#!/usr/bin/env node
// Cross-platform SessionStart hook: start the gptcc proxy if it's not running.
// Fires when a Claude Code session starts. Exits fast when the proxy is
// already healthy. Reads GPTCC_AUTH_TOKEN from ~/.claude/settings.json so
// the restarted proxy will accept requests carrying the same token.

import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";

const IS_WINDOWS = platform() === "win32";
const PORT = process.env.GPT_PROXY_PORT || "52532";
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const INSTALL_DIR = join(homedir(), ".local", "share", "gptcc");
const PROXY_SCRIPT = join(INSTALL_DIR, "proxy.mjs");
const START_SCRIPT = join(INSTALL_DIR, IS_WINDOWS ? "start-proxy.cmd" : "start-proxy.sh");
const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const STARTUP_LOG = join(INSTALL_DIR, "proxy-startup.log");

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

const spawnEnv = {
  ...process.env,
  ...(authToken ? { GPTCC_AUTH_TOKEN: authToken } : {}),
};

// Prefer the installed wrapper script — it uses each OS's native
// detach convention (cmd `start /B` on Windows, `nohup` on POSIX).
// Falls back to a direct spawn of the proxy if the wrapper is missing
// (older installs or partial setup).
if (existsSync(START_SCRIPT)) {
  // start-proxy.cmd (Windows) appends its own log via `>>...log 2>&1`.
  // If we also pass an opened handle through stdio, Windows rejects the
  // .cmd's redirect with EBUSY and the proxy never starts. Always use
  // stdio: "ignore" here.
  const child = spawn(START_SCRIPT, {
    detached: true,
    stdio: "ignore",
    env: spawnEnv,
    shell: true,
    windowsHide: true,
  });
  child.unref();
} else {
  // Fallback: direct spawn of proxy.mjs
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: "ignore",
    env: spawnEnv,
    windowsHide: true,
  });
  child.unref();
}

// Don't wait for the proxy to come up — the hook is async.
process.exit(0);
