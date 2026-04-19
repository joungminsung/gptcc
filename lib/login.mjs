// OAuth login flows for OpenAI / ChatGPT.
//
//   browser (default) — Authorization Code + PKCE. User logs in through
//                       their normal ChatGPT browser session; code comes
//                       back to a transient local http://localhost:1455
//                       callback. Matches the flow OpenAI's official
//                       Codex CLI uses for interactive sign-in.
//
//   device (--device) — Device Code flow. Used on headless machines
//                       (SSH, CI, Docker) where a local browser callback
//                       isn't possible.
//
// Both flows share the same public Codex CLI client ID (same as
// openai/codex), which OpenAI has registered with `http://localhost:1455/
// auth/callback` as a valid redirect URI.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  chmodSync,
  renameSync,
  unlinkSync,
} from "fs";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { createHash, randomBytes } from "crypto";
import { spawnSync } from "child_process";
import http from "http";

// Security: OAuth endpoints must be on *.openai.com to prevent token
// exfiltration via a hostile environment variable.
function validateOpenAIEndpoint(url, fallback) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && /(^|\.)openai\.com$/.test(u.hostname)) return url;
    console.error(
      `[security] Rejecting OAuth endpoint override: ${url} (not openai.com). Using default.`
    );
  } catch {}
  return fallback;
}

const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");
const TOKEN_ENDPOINT = validateOpenAIEndpoint(
  process.env.OPENAI_TOKEN_ENDPOINT,
  "https://auth.openai.com/oauth/token"
);
const AUTHORIZE_ENDPOINT = validateOpenAIEndpoint(
  process.env.OPENAI_AUTHORIZE_ENDPOINT,
  "https://auth.openai.com/oauth/authorize"
);
const DEVICE_CODE_ENDPOINT = validateOpenAIEndpoint(
  process.env.OPENAI_DEVICE_CODE_ENDPOINT,
  "https://auth.openai.com/oauth/device/code"
);
const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

// Scope must match openai/codex's build_authorize_url exactly. The
// authorize server rejects any divergence with `missing_required_parameter`.
// v2.2.4 tried reducing to identity-only scope based on a hypothesis
// that `api.connectors.*` required Codex-service accounts — that was
// wrong. Confirmed against current openai/codex Rust source:
//   codex-rs/login/src/server.rs `build_authorize_url`
const SCOPE =
  "openid profile email offline_access api.connectors.read api.connectors.invoke";
const ORIGINATOR = process.env.CODEX_ORIGINATOR || "codex_cli_rs";

// Honest UA: identifies us as gptcc, no sniffing / impersonation.
// Overridable via GPTCC_USER_AGENT.
const USER_AGENT =
  process.env.GPTCC_USER_AGENT ||
  "gptcc/2.2.11 (+https://github.com/joungminsung/gptcc)";

// Localhost callback is what the Codex CLI client_id is registered for.
const REDIRECT_HOST = "127.0.0.1";
const REDIRECT_PORT = Number(process.env.GPTCC_LOGIN_PORT) || 1455;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/auth/callback`;

// --- base64url helpers & JWT ---

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

function base64urlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString();
}

function parseJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  if (parts[1].length > 16384) throw new Error("JWT payload too large");
  return JSON.parse(base64urlDecode(parts[1]));
}

// --- PKCE ---

function generatePKCE() {
  const verifier = base64urlEncode(randomBytes(32));
  const challenge = base64urlEncode(
    createHash("sha256").update(verifier).digest()
  );
  return { verifier, challenge };
}

// --- Browser launch (cross-platform, safe args array) ---

function openBrowser(url) {
  try {
    let cmd, args;
    if (platform() === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform() === "win32") {
      // Do NOT use `cmd /c start "" <url>` — cmd.exe treats `&` in the URL
      // as a command separator, so the OAuth authorize URL (full of `&`)
      // is truncated to `?response_type=code` and the browser lands on a
      // consent page that (correctly) reports `missing_required_parameter`.
      //
      // `rundll32 url.dll,FileProtocolHandler` hands the URL to Windows'
      // default URL handler verbatim — same mechanism Electron's
      // shell.openExternal uses on Windows.
      cmd = "rundll32";
      args = ["url.dll,FileProtocolHandler", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

// --- Token persistence ---

function saveAuth(data) {
  const auth = {
    tokens: {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      id_token: data.id_token,
    },
    created: new Date().toISOString(),
  };
  try {
    const payload = parseJwtPayload(data.id_token);
    if (payload.email) console.log(`  Logged in as: ${payload.email}`);
    const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
    if (accountId) auth.tokens.account_id = accountId;
  } catch {}

  const dir = dirname(AUTH_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = AUTH_PATH + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(auth, null, 2), "utf-8");
    chmodSync(tmp, 0o600);
    renameSync(tmp, AUTH_PATH);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
  chmodSync(AUTH_PATH, 0o600);
  console.log(`  Tokens saved to ${AUTH_PATH}`);
  return auth;
}

// Keep these short; they're what the user sees after the OAuth redirect.
const SUCCESS_HTML = `<!doctype html><meta charset="utf-8"><title>gptcc login</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}.c{max-width:440px;padding:2.5rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem;color:#4ade80}p{color:#94a3b8;margin:.5rem 0}</style>
<div class="c"><h1>✓ Logged in</h1><p>gptcc received your authorization code.</p><p>You can close this tab and return to the terminal.</p></div>`;

// HTML-escape every character that could break out of the context where
// we interpolate OAuth error strings. Without this, a malicious redirect
// (e.g. an attacker-crafted link hitting the user's localhost:1455) could
// inject script tags into the failure page. Localhost-only, but still
// XSS-worthy.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

const FAILURE_HTML = (reason) => `<!doctype html><meta charset="utf-8"><title>gptcc login failed</title>
<style>body{font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0}.c{max-width:440px;padding:2.5rem;text-align:center}h1{font-size:1.5rem;margin:0 0 .5rem;color:#f87171}p{color:#94a3b8;margin:.5rem 0}code{background:#1e293b;padding:.2rem .4rem;border-radius:4px}</style>
<div class="c"><h1>✗ Login failed</h1><p><code>${escapeHtml(reason)}</code></p><p>Return to the terminal for details.</p></div>`;

// --- Flow 1: Authorization Code + PKCE (browser) ---

async function loginBrowser() {
  console.log("\n  Signing in to ChatGPT via your browser...\n");

  const { verifier, challenge } = generatePKCE();
  const state = base64urlEncode(randomBytes(16));

  const server = http.createServer();

  const codePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { server.close(); } catch {}
      reject(new Error("Login timed out (5 min). Try again, or use `gptcc login --device` on a headless machine."));
    }, 5 * 60 * 1000);

    server.on("request", (req, res) => {
      let reqUrl;
      try {
        reqUrl = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      } catch {
        res.writeHead(400);
        res.end("Invalid request");
        return;
      }
      if (reqUrl.pathname !== "/auth/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const error = reqUrl.searchParams.get("error");
      const errorDesc = reqUrl.searchParams.get("error_description") || "";
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(FAILURE_HTML(`${error}: ${errorDesc}`));
        clearTimeout(timeout);
        try { server.close(); } catch {}
        reject(new Error(`OAuth error: ${error} ${errorDesc}`.trim()));
        return;
      }

      const code = reqUrl.searchParams.get("code");
      const returnedState = reqUrl.searchParams.get("state");
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(FAILURE_HTML("missing authorization code"));
        clearTimeout(timeout);
        try { server.close(); } catch {}
        reject(new Error("No code in callback"));
        return;
      }
      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(FAILURE_HTML("state mismatch (possible CSRF)"));
        clearTimeout(timeout);
        try { server.close(); } catch {}
        reject(new Error("State mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(SUCCESS_HTML);
      clearTimeout(timeout);
      try { server.close(); } catch {}
      resolve(code);
    });

    server.on("error", (err) => {
      clearTimeout(timeout);
      if (err.code === "EADDRINUSE") {
        reject(
          new Error(
            `Port ${REDIRECT_PORT} is already in use. Another login flow may be running. ` +
              `Close it and retry, or set GPTCC_LOGIN_PORT to a free port.`
          )
        );
      } else {
        reject(err);
      }
    });

    server.listen(REDIRECT_PORT, REDIRECT_HOST, () => {
      // Match openai/codex Rust `build_authorize_url` byte-for-byte.
      //   codex-rs/login/src/server.rs
      //
      // - Rust uses `urlencoding::encode` which emits `%20` for spaces.
      //   URLSearchParams emits `+`, which the authorize server rejects
      //   (it reads `+` as a literal `+`, so the scope arrives malformed
      //   and surfaces as `missing_required_parameter`).
      // - Parameter order is the order Rust pushes into its Vec:
      //   response_type, client_id, redirect_uri, scope,
      //   code_challenge, code_challenge_method,
      //   id_token_add_organizations, codex_cli_simplified_flow,
      //   state, originator.
      //   OAuth servers shouldn't care about order in theory, but the
      //   consent page is strict about total-URL equivalence with the
      //   official CLI, so we match order too.
      const params = [
        ["response_type", "code"],
        ["client_id", CLIENT_ID],
        ["redirect_uri", REDIRECT_URI],
        ["scope", SCOPE],
        ["code_challenge", challenge],
        ["code_challenge_method", "S256"],
        ["id_token_add_organizations", "true"],
        ["codex_cli_simplified_flow", "true"],
        ["state", state],
        ["originator", ORIGINATOR],
      ];
      const qs = params
        .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
        .join("&");
      const url = `${AUTHORIZE_ENDPOINT}?${qs}`;
      console.log("  Waiting for you to sign in at:");
      console.log(`    ${url}`);
      console.log("");
      if (openBrowser(url)) {
        console.log("  Browser opened automatically. Complete the login, then return here.");
      } else {
        console.log("  Open the URL above in a browser to continue.");
      }
      console.log("");
    });
  });

  const code = await codePromise;

  // Exchange the authorization code for tokens.
  const tokenRes = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Token exchange failed (${tokenRes.status}): ${body.slice(0, 500)}`);
  }

  const data = await tokenRes.json();
  if (!data.access_token) {
    throw new Error(`Token response missing access_token: ${JSON.stringify(data).slice(0, 300)}`);
  }

  return saveAuth(data);
}

// --- Flow 2: Device Code (headless) ---

async function loginDevice() {
  console.log("\n  Signing in to ChatGPT via device code (headless)...\n");

  const dcRes = await fetch(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
      originator: ORIGINATOR,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!dcRes.ok) {
    const err = await dcRes.text();
    throw new Error(`Device code request failed (${dcRes.status}): ${err.slice(0, 500)}`);
  }

  const dc = await dcRes.json();
  const {
    device_code,
    user_code,
    verification_uri_complete,
    verification_uri,
    interval,
    expires_in,
  } = dc;

  const url = verification_uri_complete || verification_uri;
  console.log("  ┌──────────────────────────────────────────┐");
  console.log(`  │  Go to: ${url}`);
  console.log(`  │  Code:  ${user_code}`);
  console.log("  └──────────────────────────────────────────┘");
  console.log("");
  if (openBrowser(url)) {
    console.log("  Browser opened automatically.");
  } else {
    console.log("  Open the URL above in any browser.");
  }
  console.log("  Waiting for login...");

  let pollInterval = (interval || 5) * 1000;
  const deadline = Date.now() + (expires_in || 900) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    let tokenRes;
    try {
      tokenRes = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          client_id: CLIENT_ID,
          device_code,
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      process.stdout.write("x");
      continue;
    }

    let data;
    try {
      data = await tokenRes.json();
    } catch {
      process.stdout.write("?");
      continue;
    }

    if (data.error === "authorization_pending") {
      process.stdout.write(".");
      continue;
    }
    if (data.error === "slow_down") {
      pollInterval += 5000;
      continue;
    }
    if (data.error) {
      throw new Error(`Login failed: ${data.error} — ${data.error_description || ""}`);
    }

    console.log("\n");
    return saveAuth(data);
  }

  throw new Error("Login timed out. Please try again.");
}

// --- Public API ---

export async function login(options = {}) {
  if (options.device) return loginDevice();
  return loginBrowser();
}

export function isLoggedIn() {
  if (!existsSync(AUTH_PATH)) return false;
  try {
    const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
    return !!auth.tokens?.access_token;
  } catch {
    return false;
  }
}
