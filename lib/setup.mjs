// One-touch setup: login → settings → proxy → plugin
// Called by `gptcc setup`
//
// Cross-platform: macOS, Linux, Windows. Proxy auto-start handled by the
// SessionStart hook in the Claude Code plugin, which runs on every platform.
//
// This version does NOT modify the Claude Code binary. It uses only
// documented Claude Code extension points:
//   - ANTHROPIC_BASE_URL            (route requests through local proxy)
//   - ANTHROPIC_CUSTOM_MODEL_OPTION (register GPT model in /model picker)
//   - *_SUPPORTED_CAPABILITIES      (declare thinking / effort support)
//   - Claude Code plugin + hooks    (proxy autostart)

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  renameSync,
  rmSync,
  unlinkSync,
} from "fs";
import { execSync, execFileSync, spawnSync, spawn } from "child_process";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { login } from "./login.mjs";

// ---------------------------------------------------------------------------
// Consent prompt (kept intentionally; light tone)
// ---------------------------------------------------------------------------

function askYesNo(question, defaultAnswer) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = (answer || "").trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") resolve(true);
      else if (normalized === "n" || normalized === "no") resolve(false);
      else resolve(defaultAnswer);
    });
  });
}

async function confirmInstall() {
  if (process.env.GPTCC_ACCEPT === "1" || process.env.GPTCC_ACCEPT_RISK === "1") {
    return true;
  }
  if (!process.stdin.isTTY) {
    // Non-interactive install: require an explicit opt-in env var
    console.error("\n  Non-interactive install detected.");
    console.error("  Set GPTCC_ACCEPT=1 to confirm and proceed.\n");
    return false;
  }

  console.log("\n  ─── About to install ───────────────────────────────────────");
  console.log("");
  console.log("  gptcc will configure your Claude Code install so GPT models");
  console.log("  show up alongside Claude in the /model picker.");
  console.log("");
  console.log("    • Uses only documented Claude Code extension points");
  console.log("      (ANTHROPIC_BASE_URL, ANTHROPIC_CUSTOM_MODEL_OPTION,");
  console.log("      plugin hooks). No binary modification.");
  console.log("    • Local proxy on 127.0.0.1 translates API formats.");
  console.log("    • ChatGPT Plus/Pro OAuth — same flow as the official Codex CLI.");
  console.log("    • Fully reversible — `gptcc uninstall` restores settings.");
  console.log("");

  const ok = await askYesNo("  Continue? [Y/n]: ", true);
  console.log("");
  return ok;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const HOME = homedir();
const IS_WINDOWS = platform() === "win32";
const IS_MACOS = platform() === "darwin";

const CLAUDE_BIN =
  process.env.CLAUDE_BINARY ||
  join(HOME, IS_WINDOWS ? "AppData/Local/claude-code/claude.exe" : ".local/bin/claude");
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(HOME, ".codex", "auth.json");

// Install location for the proxy that the plugin's SessionStart hook starts.
// Keeps the proxy script out of temporary/quarantined paths on macOS.
const INSTALL_DIR = join(HOME, ".local", "share", "gptcc");
const INSTALLED_PROXY = join(INSTALL_DIR, "proxy.mjs");
const INSTALLED_START = join(INSTALL_DIR, IS_WINDOWS ? "start-proxy.cmd" : "start-proxy.sh");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(step, total, msg) {
  console.log(`\n  [${step}/${total}] ${msg}`);
}

function writeJsonAtomic(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  renameSync(tmp, path);
}

function findNode() {
  if (process.execPath && existsSync(process.execPath)) return process.execPath;
  try {
    const cmd = IS_WINDOWS ? "where node" : "which node";
    return execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim().split(/\r?\n/)[0];
  } catch {
    const fallbacks = IS_WINDOWS
      ? ["C:/Program Files/nodejs/node.exe"]
      : ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
    for (const p of fallbacks) if (existsSync(p)) return p;
    return null;
  }
}

function findClaudeBinary() {
  if (existsSync(CLAUDE_BIN)) return CLAUDE_BIN;
  try {
    const cmd = IS_WINDOWS ? "where claude" : "which claude";
    const result = execSync(cmd, { encoding: "utf-8", timeout: 5000 }).trim().split(/\r?\n/)[0];
    if (result && existsSync(result)) return result;
  } catch {}
  const candidates = IS_WINDOWS
    ? [
        join(HOME, "AppData/Local/claude-code/claude.exe"),
        join(HOME, "AppData/Roaming/npm/claude.cmd"),
        "C:/Program Files/claude-code/claude.exe",
      ]
    : [
        join(HOME, ".local", "bin", "claude"),
        "/opt/homebrew/bin/claude",
        "/usr/local/bin/claude",
      ];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

function copyProxyToInstallDir() {
  mkdirSync(INSTALL_DIR, { recursive: true });
  copyFileSync(join(PROJECT_ROOT, "lib", "proxy.mjs"), INSTALLED_PROXY);

  // Start helper — platform-specific wrapper used by the plugin SessionStart hook
  const nodePath = findNode();
  if (IS_WINDOWS) {
    writeFileSync(
      INSTALLED_START,
      `@echo off\r\nrem Starts the gptcc proxy if it is not already running\r\n` +
        `curl -fsS -m 2 http://127.0.0.1:%GPT_PROXY_PORT% >nul 2>&1 && exit /b 0\r\n` +
        `start "" /B "${nodePath}" "${INSTALLED_PROXY}"\r\n`
    );
  } else {
    writeFileSync(
      INSTALLED_START,
      `#!/usr/bin/env bash\n# Starts the gptcc proxy if it is not already running\n` +
        `PORT="\${GPT_PROXY_PORT:-52532}"\n` +
        `if curl -fsS -m 2 "http://127.0.0.1:\${PORT}/health" >/dev/null 2>&1; then\n  exit 0\nfi\n` +
        `nohup "${nodePath}" "${INSTALLED_PROXY}" >"\${HOME}/Library/Logs/gptcc-proxy.log" 2>&1 &\ndisown\n`
    );
    chmodSync(INSTALLED_START, 0o755);
  }

  // macOS only: clear quarantine so launchd/SessionStart hooks can exec
  if (IS_MACOS) {
    try {
      execSync(`xattr -dr com.apple.quarantine "${INSTALL_DIR}" 2>/dev/null`, { stdio: "ignore" });
      execSync(`xattr -dr com.apple.provenance "${INSTALL_DIR}" 2>/dev/null`, { stdio: "ignore" });
    } catch {}
  }
}

function stopProxy() {
  try {
    if (IS_WINDOWS) {
      execSync('taskkill /F /IM node.exe /FI "WINDOWTITLE eq proxy.mjs*" 2>nul', {
        stdio: "pipe",
      });
    } else {
      execSync('pkill -f "proxy.mjs"', { stdio: "pipe" });
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// Setup flow
// ---------------------------------------------------------------------------

export async function setup(options = {}) {
  const STEPS = 5;
  const port = process.env.GPT_PROXY_PORT || "52532";

  console.log("\n  === GPT for Claude Code ===\n");

  const accepted = await confirmInstall();
  if (!accepted) {
    console.log("  Okay — no changes were made. See you next time.\n");
    throw new Error("Install aborted at consent prompt");
  }

  // ---- Step 1: Prerequisites ----
  log(1, STEPS, "Checking prerequisites...");

  const nodePath = findNode();
  if (!nodePath) {
    console.error("  ERROR: Node.js not found. Install Node.js 18+.");
    throw new Error("Prerequisite check failed");
  }
  console.log(`  Node.js: ${execFileSync(nodePath, ["--version"], { encoding: "utf-8" }).trim()}`);

  const claudeBin = findClaudeBinary();
  if (!claudeBin) {
    console.error("  ERROR: Claude Code binary not found.");
    console.error("  Install Claude Code first, or set CLAUDE_BINARY=/path/to/claude.");
    throw new Error("Prerequisite check failed");
  }
  console.log(`  Claude Code: ${claudeBin}`);

  console.log(`  Platform: ${platform()}`);

  // Install proxy + helpers to a stable location
  console.log(`  Installing proxy to ${INSTALL_DIR}...`);
  copyProxyToInstallDir();

  // ---- Step 2: Login ----
  log(2, STEPS, "ChatGPT login...");

  if (existsSync(AUTH_PATH) && !options.forceLogin) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
      if (auth.tokens?.access_token) {
        console.log("  Already logged in. Use 'gptcc login' to re-login.");
      } else {
        await login();
      }
    } catch {
      await login();
    }
  } else {
    await login();
  }

  // ---- Step 3: Start proxy ----
  log(3, STEPS, "Starting proxy...");

  let proxyRunning = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    if (data.proxy === "gptcc") proxyRunning = true;
  } catch {}

  if (!proxyRunning) {
    const child = spawn(nodePath, [INSTALLED_PROXY], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME, GPT_PROXY_PORT: port },
      windowsHide: true,
    });
    child.unref();

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        const data = await res.json();
        if (data.proxy === "gptcc") {
          proxyRunning = true;
          break;
        }
      } catch {}
    }
  }

  if (!proxyRunning) {
    console.error("  WARNING: proxy didn't start within timeout. Check logs and run");
    console.error("  'gptcc proxy' in the foreground for details.");
  } else {
    console.log(`  Proxy running on port ${port}`);
  }

  // ---- Step 4: Configure Claude Code settings ----
  log(4, STEPS, "Configuring Claude Code settings...");

  mkdirSync(join(HOME, ".claude"), { recursive: true });

  if (existsSync(SETTINGS_PATH)) {
    const backupPath = SETTINGS_PATH + ".gptcc-backup";
    if (!existsSync(backupPath)) {
      copyFileSync(SETTINGS_PATH, backupPath);
      console.log(`  Settings backed up to ${backupPath}`);
    }
  }

  let settings = {};
  if (existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    } catch {}
  }

  settings.env = settings.env || {};

  // Route Claude Code through the local proxy (official extension point).
  // Only commit this if the proxy is healthy — otherwise Claude Code would
  // be pointed at a dead endpoint.
  if (proxyRunning) {
    settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
  }

  // Register a custom GPT model option in the /model picker.
  // Per Claude Code docs: "Claude Code skips validation for the model ID
  // set in ANTHROPIC_CUSTOM_MODEL_OPTION."
  //
  // NOTE: Claude Code currently supports one CUSTOM_MODEL_OPTION entry at a
  // time. Multiple GPT variants can still be used inside the session by
  // referencing them from subagent frontmatter (model: gpt-5.4) — the proxy
  // routes any gpt-* identifier to the Codex backend.
  const defaultModel = options.model || process.env.GPTCC_DEFAULT_MODEL || "gpt-5.4-fast";
  settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION = defaultModel;
  settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = prettyModelName(defaultModel);
  settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = modelDescription(defaultModel);
  settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES =
    "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";

  writeJsonAtomic(SETTINGS_PATH, settings);
  console.log("  Settings updated");

  // ---- Step 5: Register Claude Code plugin ----
  log(5, STEPS, "Registering Claude Code plugin...");

  const pluginDir = join(PROJECT_ROOT, "plugin");
  try {
    const result = spawnSync(claudeBin, ["plugin", "add", pluginDir], {
      stdio: "pipe",
      timeout: 10000,
    });
    if (result.status === 0) {
      console.log("  Plugin registered");
    } else {
      console.log("  Plugin registration skipped — run `claude plugin add` manually if desired");
    }
  } catch {
    console.log("  Plugin registration skipped — run `claude plugin add` manually if desired");
  }

  // ---- Done ----
  console.log("\n  === Setup complete! ===\n");
  console.log("  Usage:");
  console.log(`    claude --model ${defaultModel}    # Use GPT directly`);
  console.log("    /model                                # Pick from the session picker");
  console.log("    Agent(subagent_type: \"gpt-reviewer\", prompt: \"...\")   # Delegate");
  console.log("");
  console.log(`  Default model: ${defaultModel}`);
  console.log("  To change it: `gptcc setup --model gpt-5.4` or set GPTCC_DEFAULT_MODEL.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export async function uninstall() {
  console.log("\n  === Uninstalling GPT for Claude Code ===\n");

  stopProxy();
  console.log("  Proxy stopped");

  // macOS: remove legacy launchd agents from previous versions
  if (IS_MACOS) {
    const launchAgentsDir = join(HOME, "Library", "LaunchAgents");
    for (const name of ["com.gptcc.proxy.plist", "com.gptcc.watcher.plist"]) {
      const plist = join(launchAgentsDir, name);
      if (existsSync(plist)) {
        try {
          execSync(`launchctl unload "${plist}" 2>/dev/null`, { stdio: "pipe" });
          unlinkSync(plist);
        } catch {}
      }
    }
  }

  // Best-effort restore of a binary from a previous (< 2.0) install that
  // used binary patching. Silent no-op if the backup doesn't exist.
  const backup = CLAUDE_BIN + ".backup";
  if (existsSync(backup)) {
    try {
      copyFileSync(backup, CLAUDE_BIN);
      console.log("  Restored pre-2.0 binary from backup");
      if (IS_MACOS) {
        try {
          execSync(`codesign --force --sign - "${CLAUDE_BIN}" 2>/dev/null`, { stdio: "pipe" });
        } catch {}
      }
    } catch {}
  }

  // Remove installed files
  if (existsSync(INSTALL_DIR)) {
    try {
      rmSync(INSTALL_DIR, { recursive: true, force: true });
      console.log("  Installed files removed");
    } catch {}
  }

  // Clean settings
  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      if (settings.env) {
        for (const key of [
          "ANTHROPIC_BASE_URL",
          "ANTHROPIC_CUSTOM_MODEL_OPTION",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
          // Legacy keys from < 2.0 setups
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
          "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
          "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
        ]) {
          delete settings.env[key];
        }
        if (Object.keys(settings.env).length === 0) delete settings.env;
      }
      const gptModels = new Set([
        "gpt-5.4",
        "gpt-5.4-fast",
        "gpt-5.4-mini",
        "gpt-5.3-codex",
        "gpt-5.3-codex-spark",
        "gpt-5.2",
      ]);
      settings.availableModels = (settings.availableModels || []).filter(
        (m) => !gptModels.has(m)
      );
      if (settings.availableModels.length === 0) delete settings.availableModels;
      writeJsonAtomic(SETTINGS_PATH, settings);
      console.log("  Settings cleaned");
    } catch {}
  }

  console.log("\n  Done. GPT for Claude Code removed.\n");
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export async function status() {
  const port = process.env.GPT_PROXY_PORT || "52532";

  console.log("\n  === GPT for Claude Code — Status ===\n");

  let proxyOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    proxyOk = data.proxy === "gptcc";
    console.log(`  Proxy:    ${proxyOk ? "running" : "NOT running"} (port ${port})`);
    if (proxyOk && data.version) console.log(`  Version:  ${data.version}`);
  } catch {
    console.log(`  Proxy:    NOT running (port ${port})`);
  }

  if (existsSync(AUTH_PATH)) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
      const b64 = auth.tokens.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const payload = JSON.parse(Buffer.from(b64, "base64").toString());
      const exp = new Date(payload.exp * 1000);
      const expired = exp < new Date();
      console.log(`  Auth:     ${expired ? "EXPIRED" : "valid"} (expires ${exp.toLocaleString()})`);
    } catch {
      console.log("  Auth:     present but unreadable");
    }
  } else {
    console.log("  Auth:     NOT logged in");
  }

  if (existsSync(SETTINGS_PATH)) {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const hasUrl = s.env?.ANTHROPIC_BASE_URL?.includes("127.0.0.1");
      const model = s.env?.ANTHROPIC_CUSTOM_MODEL_OPTION;
      console.log(`  Settings: URL=${hasUrl ? "OK" : "missing"}  Picker=${model || "missing"}`);
    } catch {
      console.log("  Settings: error reading");
    }
  }

  console.log(`  Platform: ${platform()}`);
  console.log("");
}

// ---------------------------------------------------------------------------
// Model metadata (for picker display)
// ---------------------------------------------------------------------------

function prettyModelName(id) {
  const map = {
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-fast": "GPT-5.4 (fast)",
    "gpt-5.4-mini": "GPT-5.4 mini",
    "gpt-5.3-codex": "GPT-5.3 Codex",
    "gpt-5.3-codex-spark": "GPT-5.3 Codex Spark",
    "gpt-5.2": "GPT-5.2",
  };
  return map[id] || id;
}

function modelDescription(id) {
  const map = {
    "gpt-5.4": "OpenAI flagship · 1M context · reasoning",
    "gpt-5.4-fast": "Priority tier · 1.5× speed · 2× credits",
    "gpt-5.4-mini": "Lightweight · fast · cheap",
    "gpt-5.3-codex": "Coding-specialized",
    "gpt-5.3-codex-spark": "Real-time coding iteration",
    "gpt-5.2": "Previous generation",
  };
  return map[id] || "OpenAI model routed through gptcc";
}
