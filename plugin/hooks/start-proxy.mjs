#!/usr/bin/env node
// Cross-platform SessionStart hook: start the gptcc proxy if it's not running.
// Fires when a Claude Code session starts. Exits fast when the proxy is
// already healthy. Reads GPTCC_AUTH_TOKEN from ~/.claude/settings.json so
// the restarted proxy will accept requests carrying the same token.

import { homedir, platform } from "os";
import { join } from "path";
import { existsSync, openSync, closeSync } from "fs";
import { spawn } from "child_process";

const IS_WINDOWS = platform() === "win32";
const PORT = process.env.GPT_PROXY_PORT || "52532";
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const INSTALL_DIR = join(homedir(), ".local", "share", "gptcc");
const PROXY_SCRIPT = join(INSTALL_DIR, "proxy.mjs");
const START_SCRIPT_POSIX = join(INSTALL_DIR, "start-proxy.sh");
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

const spawnEnv = { ...process.env };

if (IS_WINDOWS) {
  // Do NOT use the .cmd wrapper / `start /B`: `start`'s stdio redirect
  // does not propagate to the launched child, so proxy stderr/stdout is
  // discarded and failures are invisible. Spawn node directly with
  // detached + windowsHide — Node sets DETACHED_PROCESS and
  // CREATE_NEW_PROCESS_GROUP so the child survives the hook exit — and
  // attach its stdio to an append handle on the startup log so we can
  // always diagnose failures post-hoc.
  let logFd = null;
  try { logFd = openSync(STARTUP_LOG, "a"); } catch {}
  const child = spawn(process.execPath, [PROXY_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
    env: spawnEnv,
    windowsHide: true,
  });
  child.unref();
  if (logFd !== null) {
    try { closeSync(logFd); } catch {}
  }
} else {
  // POSIX: the installed start-proxy.sh uses nohup + disown, which is
  // the canonical detach pattern on macOS / Linux. Keep using it.
  if (existsSync(START_SCRIPT_POSIX)) {
    const child = spawn(START_SCRIPT_POSIX, {
      detached: true,
      stdio: "ignore",
      env: spawnEnv,
      shell: true,
    });
    child.unref();
  } else {
    const child = spawn(process.execPath, [PROXY_SCRIPT], {
      detached: true,
      stdio: "ignore",
      env: spawnEnv,
    });
    child.unref();
  }
}

// Don't wait for the proxy to come up — the hook is async.
process.exit(0);
