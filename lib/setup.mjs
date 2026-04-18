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
    // The health probe must hit /health (the only non-/v1/* path the proxy
    // accepts for GET), and GPT_PROXY_PORT must default to 52532 to match
    // the Node proxy default. We also log proxy stderr to a file so that
    // a broken install surfaces an actionable error rather than silence.
    //
    // The batch script itself uses `start "" /B` (plain cmd syntax, no
    // Node-layer quote nesting), then `exit /b 0` so cmd.exe returns
    // immediately and Node's spawn() sees success.
    const logPath = join(INSTALL_DIR, "proxy-startup.log");
    writeFileSync(
      INSTALLED_START,
      `@echo off\r\n` +
        `rem Starts the gptcc proxy if it is not already running.\r\n` +
        `rem Generated by gptcc setup — do not edit by hand.\r\n` +
        `chcp 65001 >nul 2>&1\r\n` +
        `if "%GPT_PROXY_PORT%"=="" set GPT_PROXY_PORT=52532\r\n` +
        `curl -fsS -m 2 http://127.0.0.1:%GPT_PROXY_PORT%/health >nul 2>&1 && exit /b 0\r\n` +
        `start "" /B "${nodePath}" "${INSTALLED_PROXY}" >>"${logPath}" 2>&1\r\n` +
        `exit /b 0\r\n`
    );
  } else {
    // Log path: macOS keeps the traditional ~/Library/Logs/, Linux uses
    // $XDG_STATE_HOME or ~/.local/state (systemd-style convention).
    const logPathExpr = IS_MACOS
      ? '"${HOME}/Library/Logs/gptcc-proxy.log"'
      : '"${XDG_STATE_HOME:-${HOME}/.local/state}/gptcc/proxy.log"';
    const mkdirExpr = IS_MACOS
      ? ""
      : 'mkdir -p "${XDG_STATE_HOME:-${HOME}/.local/state}/gptcc"\n';
    writeFileSync(
      INSTALLED_START,
      `#!/usr/bin/env bash\n# Starts the gptcc proxy if it is not already running\n` +
        `PORT="\${GPT_PROXY_PORT:-52532}"\n` +
        `if curl -fsS -m 2 "http://127.0.0.1:\${PORT}/health" >/dev/null 2>&1; then\n  exit 0\nfi\n` +
        mkdirExpr +
        `nohup "${nodePath}" "${INSTALLED_PROXY}" >${logPathExpr} 2>&1 &\ndisown\n`
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
  // Windows: find the node PID that owns the proxy port via netstat, then
  // taskkill it. WINDOWTITLE filtering doesn't work for detached Node
  // processes (they inherit the parent console's title or none).
  // POSIX: pkill by command line — matches `node .../proxy.mjs`.
  if (IS_WINDOWS) {
    try {
      const port = process.env.GPT_PROXY_PORT || "52532";
      const netstat = execSync(`netstat -ano -p TCP`, {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const line of netstat.split(/\r?\n/)) {
        const m = line.match(/LISTENING\s+(\d+)\s*$/);
        if (!m) continue;
        if (!line.includes(`:${port} `) && !line.includes(`:${port}\t`)) continue;
        const pid = m[1];
        try {
          execSync(`taskkill /F /PID ${pid}`, { stdio: "pipe" });
        } catch {}
      }
    } catch {}
    return;
  }
  try {
    execSync('pkill -f "proxy.mjs"', { stdio: "pipe" });
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

  // Clear any stale startup log from a previous failed setup.
  // On Windows, a zombie cmd handle can keep this file locked, so also
  // fall through to a timestamped filename later if unlink fails.
  if (IS_WINDOWS) {
    try {
      unlinkSync(join(INSTALL_DIR, "proxy-startup.log"));
    } catch {}
  }

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

  // Load any previously written token so the fresh proxy accepts our own
  // follow-up requests.
  let authToken = null;
  if (existsSync(SETTINGS_PATH)) {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      authToken = s.env?.ANTHROPIC_AUTH_TOKEN || null;
    } catch {}
  }

  if (!proxyRunning) {
    const spawnEnv = {
      ...process.env,
      HOME,
      GPT_PROXY_PORT: port,
      ...(authToken ? { GPTCC_AUTH_TOKEN: authToken } : {}),
    };

    // Windows detach path.
    //
    // Node's spawn({detached: true}) alone does not really detach on
    // Windows — the child stays tied to the parent console and dies
    // when the parent exits. Several attempts that failed in the wild:
    //
    //   spawn('cmd.exe', ['/c', `start "" /B "${node}" "${proxy}"`])
    //   spawn(cmdString, { shell: true })
    //
    // Both can break on quote/escape edge cases when the Node binary
    // path contains spaces (e.g. `C:\Program Files\nodejs\node.exe`).
    //
    // What actually works: run the installed start-proxy.cmd wrapper
    // (which uses `start "" /B` internally — a plain cmd script, no
    // JavaScript quote nesting), redirect stdout/stderr to a log file
    // so errors are captured instead of silently lost, and unref.
    if (IS_WINDOWS) {
      // Do NOT open the log file here. The wrapper .cmd script opens it
      // via `>>"log" 2>&1`; if we also hold an append handle through
      // stdio, Windows rejects the second open with EBUSY
      // ("cannot access the file because it is being used by another
      // process"), the .cmd exits before spawning the proxy, and the
      // whole chain silently fails. Let the child own the log file.
      const child = spawn(INSTALLED_START, {
        detached: true,
        stdio: "ignore",
        env: spawnEnv,
        shell: true,
        windowsHide: true,
      });
      child.unref();
    } else {
      const child = spawn(nodePath, [INSTALLED_PROXY], {
        detached: true,
        stdio: "ignore",
        env: spawnEnv,
      });
      child.unref();
    }

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

    // If still not running on Windows, show the captured log so the user
    // has an actionable error instead of just "timeout".
    if (!proxyRunning && IS_WINDOWS) {
      const logPath = join(INSTALL_DIR, "proxy-startup.log");
      try {
        const log = readFileSync(logPath, "utf-8").trim();
        if (log) {
          console.error("\n  --- proxy startup log ---");
          console.error(log.split("\n").map((l) => "  " + l).join("\n"));
          console.error("  --- end log ---\n");
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

  // Proxy auth token — prevents other local processes from driving the
  // proxy on behalf of this user. Persisted to settings so Claude Code
  // sends it as `Authorization: Bearer <token>` on every request.
  if (!settings.env.ANTHROPIC_AUTH_TOKEN || !settings.env.ANTHROPIC_AUTH_TOKEN.startsWith("gptcc_")) {
    const { randomBytes } = await import("crypto");
    settings.env.ANTHROPIC_AUTH_TOKEN = `gptcc_${randomBytes(24).toString("hex")}`;
  }

  // Multi-slot mode (opt-in) — uses Bedrock-compat endpoint on the proxy so
  // three GPT models can live in the picker at once. Off by default: v2.1.x
  // ships it as an advanced option while we gather real-world telemetry.
  const useMultiSlot =
    options.multiSlot || process.env.GPTCC_MULTI_SLOT === "1";

  const defaultModel = options.model || process.env.GPTCC_DEFAULT_MODEL || "gpt-5.4-fast";

  if (useMultiSlot) {
    // Hijack the 3 default slots — and add one CUSTOM entry — to show 4 GPT
    // models in the picker simultaneously. This path requires Bedrock mode.
    settings.env.CLAUDE_CODE_USE_BEDROCK = "1";
    settings.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = "1";
    settings.env.ANTHROPIC_BEDROCK_BASE_URL = `http://127.0.0.1:${port}`;

    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL = "gpt-5.4";
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = "GPT-5.4";
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION = "OpenAI flagship · 1M ctx";
    settings.env.ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES =
      "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";

    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "gpt-5.4-fast";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = "GPT-5.4 Fast";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = "Priority tier · 1.5× speed";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES =
      "effort,thinking,adaptive_thinking";

    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "gpt-5.4-mini";
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = "GPT-5.4 Mini";
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = "Lightweight · fast";

    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION = "gpt-5.3-codex";
    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = "GPT-5.3 Codex";
    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = "Coding-specialized";
  } else {
    // Single-slot mode (default, safe). Registers one GPT entry in the picker.
    delete settings.env.CLAUDE_CODE_USE_BEDROCK;
    delete settings.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH;
    delete settings.env.ANTHROPIC_BEDROCK_BASE_URL;
    for (const k of [
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
      "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
      "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION",
    ]) delete settings.env[k];

    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION = defaultModel;
    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = prettyModelName(defaultModel);
    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = modelDescription(defaultModel);
    settings.env.ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES =
      "effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking";
  }

  writeJsonAtomic(SETTINGS_PATH, settings);
  console.log(`  Settings updated (mode: ${useMultiSlot ? "multi-slot" : "single-slot"})`);

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
  console.log("  Verify end-to-end in 5 seconds:");
  console.log("    gptcc hello\n");
  console.log("  Or inspect every layer:");
  console.log("    gptcc doctor\n");
  console.log("  Usage once verified:");
  console.log(`    claude --model ${defaultModel}`);
  console.log("    /model                                     # pick in-session");
  console.log('    Agent(subagent_type: "gpt-reviewer", ...)   # delegate a review');
  console.log("");
  if (useMultiSlot) {
    console.log("  Mode: multi-slot — GPT-5.4 / GPT-5.4 Fast / GPT-5.4 Mini / GPT-5.3 Codex");
    console.log("  all appear in the /model picker (Bedrock-compatible routing).");
  } else {
    console.log(`  Mode: single-slot — picker shows ${defaultModel}. Run`);
    console.log('  `gptcc setup --multi-slot` to surface 4 GPT models at once.');
  }
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
          "ANTHROPIC_AUTH_TOKEN",
          "ANTHROPIC_CUSTOM_MODEL_OPTION",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_NAME",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION",
          "ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES",
          // Multi-slot (Bedrock) mode keys
          "CLAUDE_CODE_USE_BEDROCK",
          "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
          "ANTHROPIC_BEDROCK_BASE_URL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL",
          "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME",
          "ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION",
          "ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES",
          "ANTHROPIC_DEFAULT_SONNET_MODEL",
          "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME",
          "ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION",
          "ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES",
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
