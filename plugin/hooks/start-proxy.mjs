#!/usr/bin/env node
// Cross-platform SessionStart hook: start the gptcc proxy if it's not running.
// Fires when a Claude Code session starts. Exits fast when the proxy is
// already healthy.

import { homedir } from "os";
import { join } from "path";
import { existsSync } from "fs";
import { spawn } from "child_process";

const PORT = process.env.GPT_PROXY_PORT || "52532";
const HEALTH_URL = `http://127.0.0.1:${PORT}/health`;
const PROXY_SCRIPT = join(homedir(), ".local", "share", "gptcc", "proxy.mjs");

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
  // Setup hasn't been run yet — nothing to start. Silent exit so we don't
  // spam an unrelated Claude Code session.
  process.exit(0);
}

const child = spawn(process.execPath, [PROXY_SCRIPT], {
  detached: true,
  stdio: "ignore",
  env: process.env,
  windowsHide: true,
});
child.unref();

// Don't wait for the proxy to come up — the hook is async and setup
// already verified the proxy works. This just recovers from reboots.
process.exit(0);
