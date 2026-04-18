// Device Code OAuth Flow for OpenAI / ChatGPT
// No Codex CLI dependency — we handle the entire flow ourselves.

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, renameSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join, dirname } from "path";

// Security: OAuth endpoints must be on *.openai.com to prevent token exfiltration.
// Overrides are allowed for testing (e.g. staging.openai.com), but hostile hosts rejected.
function validateOpenAIEndpoint(url, fallback) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && /(^|\.)openai\.com$/.test(u.hostname)) return url;
    console.error(`[security] Rejecting OAuth endpoint override: ${url} (not an openai.com host). Using default.`);
  } catch {}
  return fallback;
}

const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");
const TOKEN_ENDPOINT = validateOpenAIEndpoint(process.env.OPENAI_TOKEN_ENDPOINT, "https://auth.openai.com/oauth/token");
const DEVICE_CODE_ENDPOINT = validateOpenAIEndpoint(process.env.OPENAI_DEVICE_CODE_ENDPOINT, "https://auth.openai.com/oauth/device/code");
const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

// Cloudflare bot protection on auth.openai.com returns 403 for requests
// that ship with no User-Agent — Node fetch uses "undici" by default.
// Matching the official Codex CLI's UA format gets us through the WAF.
// Ref: https://github.com/openai/codex/issues/12859
const USER_AGENT = process.env.GPTCC_USER_AGENT || "codex-cli/0.105.0";
const SCOPE = "openid profile email offline_access";
const AUDIENCE = "https://api.openai.com/v1";

// base64url -> base64 conversion for JWT parsing
function base64urlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString();
}

function parseJwtPayload(token) {
  const parts = token.split(".");
  if (parts.length < 2) throw new Error("Invalid JWT");
  // Reasonable upper bound: real JWTs are <8KB. Reject pathological inputs.
  if (parts[1].length > 16384) throw new Error("JWT payload too large");
  return JSON.parse(base64urlDecode(parts[1]));
}

export async function login() {
  console.log("\n  Logging in to ChatGPT...\n");

  // Step 1: Request device code
  const dcRes = await fetch(DEVICE_CODE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      scope: SCOPE,
      audience: AUDIENCE,
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!dcRes.ok) {
    const err = await dcRes.text();
    throw new Error(`Device code request failed (${dcRes.status}): ${err}`);
  }

  const dc = await dcRes.json();
  const { device_code, user_code, verification_uri_complete, verification_uri, interval, expires_in } = dc;

  // Step 2: Show user the code
  const url = verification_uri_complete || verification_uri;
  console.log("  ┌──────────────────────────────────────────┐");
  console.log(`  │  Go to: ${url}`);
  console.log(`  │  Code:  ${user_code}`);
  console.log("  └──────────────────────────────────────────┘");
  console.log("");

  // Try to open browser automatically — use spawn with argument array (no shell injection)
  try {
    const { spawnSync } = await import("child_process");
    const { platform } = await import("os");
    let cmd, args;
    if (platform() === "darwin") {
      cmd = "open"; args = [url];
    } else if (platform() === "win32") {
      // 'start' is a cmd.exe builtin, invoke through cmd /c
      cmd = "cmd"; args = ["/c", "start", "", url];
    } else {
      cmd = "xdg-open"; args = [url];
    }
    const r = spawnSync(cmd, args, { stdio: "ignore", timeout: 5000 });
    if (r.status === 0) console.log("  Browser opened automatically.");
    else console.log("  Open the URL above in your browser.");
  } catch {
    console.log("  Open the URL above in your browser.");
  }

  console.log("  Waiting for login...");

  // Step 3: Poll for token with proper backoff
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
    } catch (err) {
      // Network error — keep trying
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
      pollInterval += 5000; // Increase interval as required by spec
      continue;
    }

    if (data.error) {
      throw new Error(`Login failed: ${data.error} — ${data.error_description || ""}`);
    }

    // Success — save tokens
    console.log("\n");

    const auth = {
      tokens: {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        id_token: data.id_token,
      },
      created: new Date().toISOString(),
    };

    // Extract user info from id_token
    try {
      const payload = parseJwtPayload(data.id_token);
      if (payload.email) {
        console.log(`  Logged in as: ${payload.email}`);
      }
      const accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
      if (accountId) {
        auth.tokens.account_id = accountId;
      }
    } catch {}

    // Atomic write: temp file + rename (prevents corruption on crash/kill)
    const dir = dirname(AUTH_PATH);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const tmpPath = AUTH_PATH + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(auth, null, 2), "utf-8");
      chmodSync(tmpPath, 0o600);
      renameSync(tmpPath, AUTH_PATH);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch {}
      throw err;
    }
    chmodSync(AUTH_PATH, 0o600); // Defensive: ensure permissions

    console.log(`  Tokens saved to ${AUTH_PATH}`);
    return auth;
  }

  throw new Error("Login timed out. Please try again.");
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
