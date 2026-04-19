// gptcc doctor — 5-layer self-diagnostic
//
// Walks every layer from Claude Code through the proxy to the Codex backend
// and reports exactly which step is broken + the most likely fix. Runs offline
// where possible; only the last step hits the network.

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { homedir, platform } from "os";
import { join } from "path";

const HOME = homedir();
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(HOME, ".codex", "auth.json");
const PROXY_SCRIPT = join(HOME, ".local", "share", "gptcc", "proxy.mjs");
const PORT = process.env.GPT_PROXY_PORT || "52532";

const OK = "✓";
const WARN = "!";
const FAIL = "✗";

function line(status, label, detail, fix) {
  const color = status === OK ? "\x1b[32m" : status === WARN ? "\x1b[33m" : "\x1b[31m";
  const reset = "\x1b[0m";
  console.log(`  ${color}${status}${reset}  ${label}`);
  if (detail) console.log(`     ${detail}`);
  if (fix) console.log(`     \x1b[2m→ ${fix}${reset}`);
}

function b64urlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString();
}

function parseJwt(token) {
  return JSON.parse(b64urlDecode(token.split(".")[1]));
}

export async function doctor() {
  console.log("\n  === gptcc doctor ===\n");

  let failed = 0;
  let warned = 0;

  // ---- Layer 1: Claude Code binary ----
  console.log("  [1/5] Claude Code binary");
  const isWin = platform() === "win32";
  const candidates = process.env.CLAUDE_BINARY
    ? [process.env.CLAUDE_BINARY]
    : isWin
      ? [
          join(HOME, ".local", "bin", "claude.exe"),
          join(HOME, ".local", "bin", "claude"),
          join(HOME, "AppData", "Local", "claude-code", "claude.exe"),
          join(HOME, "AppData", "Roaming", "npm", "claude.cmd"),
        ]
      : [
          join(HOME, ".local", "bin", "claude"),
          "/opt/homebrew/bin/claude",
          "/usr/local/bin/claude",
        ];

  const claudeBin = candidates.find((p) => existsSync(p));

  if (claudeBin) {
    line(OK, `found at ${claudeBin}`);
  } else {
    failed++;
    line(
      FAIL,
      `Claude Code binary not found`,
      `Searched: ${candidates.join(", ")}`,
      "Install Claude Code first, or set CLAUDE_BINARY=/path/to/claude"
    );
  }

  // ---- Layer 2: settings.json ----
  console.log("\n  [2/5] Claude Code settings");
  if (!existsSync(SETTINGS_PATH)) {
    warned++;
    line(WARN, "settings.json not found",
      `Expected at ${SETTINGS_PATH}`,
      "Run: gptcc setup");
  } else {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const baseUrl = s.env?.ANTHROPIC_BASE_URL;
      const pickerModel = s.env?.ANTHROPIC_CUSTOM_MODEL_OPTION ||
                          s.env?.ANTHROPIC_DEFAULT_OPUS_MODEL;
      const useBedrock = s.env?.CLAUDE_CODE_USE_BEDROCK === "1";
      const authToken = s.env?.ANTHROPIC_AUTH_TOKEN;

      if (!baseUrl) {
        failed++;
        line(FAIL, "ANTHROPIC_BASE_URL not set",
          null,
          "Run: gptcc setup");
      } else if (!baseUrl.includes("127.0.0.1")) {
        warned++;
        line(WARN, `ANTHROPIC_BASE_URL points elsewhere: ${baseUrl}`,
          null,
          "Run: gptcc setup  (will restore 127.0.0.1)");
      } else {
        line(OK, `ANTHROPIC_BASE_URL = ${baseUrl}`);
      }

      if (!pickerModel) {
        warned++;
        line(WARN, "No custom model registered in /model picker",
          null,
          "Run: gptcc setup");
      } else {
        line(OK, `Picker model = ${pickerModel}${useBedrock ? " (multi-slot mode)" : ""}`);
      }

      // ANTHROPIC_AUTH_TOKEN is Claude Code's own env var; writing a
      // gptcc_-prefixed value into it (as v2.2.x did) hijacks the user's
      // Anthropic OAuth session. v2.2.8 stopped writing it and started
      // cleaning it up. We only complain here if a leftover gptcc_ token
      // is still present despite running setup.
      if (authToken && authToken.startsWith("gptcc_")) {
        warned++;
        line(WARN, "Stale gptcc_ ANTHROPIC_AUTH_TOKEN detected (hijacks Claude OAuth)",
          null,
          "Run: gptcc setup  (removes it automatically)");
      }
      // Proxy security doesn't depend on an Anthropic env var; it's
      // covered by 127.0.0.1-only binding, plus the optional
      // GPTCC_AUTH_TOKEN / x-gptcc-auth pair for users who want a header
      // check. Absence is no longer a warning.
    } catch (err) {
      failed++;
      line(FAIL, `settings.json unreadable: ${err.message}`,
        null,
        "Restore from backup: cp ~/.claude/settings.json.gptcc-backup ~/.claude/settings.json");
    }
  }

  // ---- Layer 3: ChatGPT OAuth ----
  console.log("\n  [3/5] ChatGPT OAuth token");
  if (!existsSync(AUTH_PATH)) {
    failed++;
    line(FAIL, "Not logged in",
      `Expected at ${AUTH_PATH}`,
      "Run: gptcc login");
  } else {
    try {
      const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
      if (!auth.tokens?.access_token) {
        failed++;
        line(FAIL, "Auth file present but token missing",
          null,
          "Run: gptcc login");
      } else {
        const payload = parseJwt(auth.tokens.access_token);
        const exp = new Date(payload.exp * 1000);
        const expired = exp < new Date();
        const daysLeft = Math.floor((exp - new Date()) / 86400000);
        if (expired) {
          failed++;
          line(FAIL, `Token expired (${exp.toLocaleString()})`,
            null,
            "Run: gptcc login");
        } else if (daysLeft < 3) {
          warned++;
          line(WARN, `Token expires soon (${exp.toLocaleString()}, ${daysLeft}d left)`);
        } else {
          line(OK, `Valid — expires ${exp.toLocaleString()}`);
        }
      }
    } catch (err) {
      failed++;
      line(FAIL, `Auth file unreadable: ${err.message}`,
        null,
        "Run: gptcc login");
    }
  }

  // ---- Layer 4: Proxy ----
  console.log("\n  [4/5] Local proxy");
  if (!existsSync(PROXY_SCRIPT)) {
    failed++;
    line(FAIL, "Proxy not installed",
      `Expected at ${PROXY_SCRIPT}`,
      "Run: gptcc setup");
  } else {
    let healthData = null;
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) healthData = await res.json();
    } catch {}

    if (!healthData || healthData.proxy !== "gptcc") {
      failed++;
      line(FAIL, `Proxy not running on port ${PORT}`,
        null,
        "Run: gptcc setup  (or 'gptcc proxy' in foreground to see errors)");
      // Show startup log if present — captures spawn failures on Windows
      const startupLog = join(HOME, ".local", "share", "gptcc", "proxy-startup.log");
      if (existsSync(startupLog)) {
        try {
          const log = readFileSync(startupLog, "utf-8").trim().split("\n").slice(-10);
          if (log.length && log.some((l) => l.trim())) {
            console.log(`     Recent proxy startup log (${startupLog}):`);
            for (const l of log) console.log(`       ${l}`);
          }
        } catch {}
      }
    } else {
      line(OK, `Running (v${healthData.version}) on port ${PORT}`);
      if (healthData.features?.authRequired) {
        line(OK, "  auth token enforced");
      }
      if (healthData.features?.apiKeyFallback) {
        line(OK, "  OPENAI_API_KEY fallback active");
      } else if (healthData.features?.bedrockInvoke) {
        line(OK, "  Bedrock invoke endpoint available");
      }
    }
  }

  // ---- Layer 5: Claude Code plugin ----
  console.log("\n  [5/5] Claude Code plugin registration");
  if (!claudeBin) {
    warned++;
    line(WARN, "skipped — Claude Code binary not found (see layer 1)");
  } else {
  try {
    const out = execSync(`"${claudeBin}" plugin list 2>&1`, {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (out.includes("gptcc")) {
      line(OK, "gptcc plugin registered");
    } else {
      warned++;
      line(WARN, "gptcc plugin not registered",
        null,
        "Run: claude plugin add <path-to-gptcc>/plugin  (or rerun 'gptcc setup')");
    }
  } catch {
    warned++;
    line(WARN, "Could not query Claude Code plugin list",
      null,
      "Is Claude Code accessible on PATH?");
  }
  }  // end if (claudeBin)

  // ---- Summary ----
  console.log("");
  if (failed === 0 && warned === 0) {
    console.log("  \x1b[32mAll checks passed.\x1b[0m Run 'gptcc hello' to test a live request.\n");
    return 0;
  }
  if (failed > 0) {
    console.log(`  \x1b[31m${failed} failure${failed > 1 ? "s" : ""}\x1b[0m, ${warned} warning${warned !== 1 ? "s" : ""}.`);
    console.log("  Fix the failures above, then re-run 'gptcc doctor'.\n");
    return 1;
  }
  console.log(`  ${warned} warning${warned > 1 ? "s" : ""} — gptcc works, but some features may be degraded.\n`);
  return 0;
}
