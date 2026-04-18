#!/usr/bin/env node
// Cross-platform SessionStart hook: start the gptcc proxy if it's not running.
// Fires when a Claude Code session starts. Exits fast when the proxy is
// already healthy. Reads GPTCC_AUTH_TOKEN from ~/.claude/settings.json so
// the restarted proxy will accept requests carrying the same token.

import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";

const PORT = process.env.GPT_PROXY_PORT || "52532";
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const PROXY_SCRIPT = join(homedir(), ".local", "share", "gptcc", "proxy.mjs");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");

async function isHealthy() {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.proxy === "gptcc";
  } catch {
    return false;
  }
}

if (await isHealthy()) process.exit(0);

if (!existsSync(PROXY_SCRIPT)) {
  // Setup hasn't been run yet — silently exit so we don't spam an
  // unrelated Claude Code session.
  process.exit(0);
}

let authToken = null;
try {
  const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
  authToken = s.env?.ANTHROPIC_AUTH_TOKEN || null;
} catch {}

const child = spawn(process.execPath, [PROXY_SCRIPT], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    ...(authToken ? { GPTCC_AUTH_TOKEN: authToken } : {}),
  },
  windowsHide: true,
});
child.unref();

// Don't wait for the proxy to come up — the hook is async.
process.exit(0);
