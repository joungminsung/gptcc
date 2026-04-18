// One-touch setup: login → settings → patch → proxy → launchd → plugin
// Called by `gptcc setup`

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, chmodSync, renameSync } from "fs";
import { execSync, execFileSync, spawnSync, spawn } from "child_process";
import { homedir, platform } from "os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import { login } from "./login.mjs";

// Ask a yes/no question on stdin. `defaultAnswer` is what blank-Enter resolves to.
function askYesNo(question, defaultAnswer) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const normalized = (answer || "").trim().toLowerCase();
      if (normalized === "y" || normalized === "yes") resolve(true);
      else if (normalized === "n" || normalized === "no") resolve(false);
      else resolve(defaultAnswer); // blank Enter → default
    });
  });
}

async function confirmToSRisk() {
  // Opt-out prompt via env var for unattended installs where the user has
  // already read the README and acknowledged the terms.
  if (process.env.GPTCC_ACCEPT_RISK === "1") {
    console.log("  [consent] GPTCC_ACCEPT_RISK=1 — skipping interactive prompt");
    return true;
  }

  // Non-interactive stdin → refuse rather than silently proceeding. This
  // preserves the "explicit acknowledgement" property for any automated use.
  if (!process.stdin.isTTY) {
    console.error("\n  Non-interactive install detected.");
    console.error("  Set GPTCC_ACCEPT_RISK=1 in your environment if you have");
    console.error("  read the README and want to proceed without the prompt.\n");
    return false;
  }

  console.log("\n  ─── Heads-up ───────────────────────────────────────────────");
  console.log("");
  console.log("  This installer makes a small, reversible local change to your");
  console.log("  Claude Code install so the model picker recognizes GPT models.");
  console.log("");
  console.log("    • runs only on your own machine");
  console.log("    • byte-length-neutral; signature re-applied ad-hoc");
  console.log("    • fully reversible (`gptcc uninstall` restores backup)");
  console.log("    • no modified binary is ever redistributed");
  console.log("");
  console.log("  This is a community interoperability tool meant for personal");
  console.log("  development environments. It is not appropriate for corporate,");
  console.log("  compliance-sensitive, or production setups — if that's you,");
  console.log("  please answer N below.");
  console.log("");
  console.log("  See README.md and TAKEDOWN_POLICY.md for the full picture.");
  console.log("");

  // Default is Y: most people running `gptcc setup` in a TTY have
  // already chosen to install. Explicit N (or Ctrl-C) aborts.
  const ok = await askYesNo("  Continue? [Y/n]: ", true);
  console.log("");
  return ok;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, "..");
const HOME = homedir();

const CLAUDE_BIN = process.env.CLAUDE_BINARY || join(HOME, ".local", "bin", "claude");
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(HOME, ".codex", "auth.json");

// Install location for scripts that launchd executes.
// Avoids ~/Desktop quarantine issues (com.apple.provenance blocks launchd).
const INSTALL_DIR = join(HOME, ".local", "share", "gptcc");
const INSTALLED_PATCH = join(INSTALL_DIR, "patch-claude.py");
const INSTALLED_AUTOPATCH = join(INSTALL_DIR, "autopatch.sh");
const INSTALLED_PROXY = join(INSTALL_DIR, "proxy.mjs");

function copyToInstallDir() {
  mkdirSync(INSTALL_DIR, { recursive: true });
  // Copy scripts and proxy
  copyFileSync(join(PROJECT_ROOT, "scripts", "patch-claude.py"), INSTALLED_PATCH);
  copyFileSync(join(PROJECT_ROOT, "scripts", "autopatch.sh"), INSTALLED_AUTOPATCH);
  copyFileSync(join(PROJECT_ROOT, "lib", "proxy.mjs"), INSTALLED_PROXY);
  chmodSync(INSTALLED_PATCH, 0o755);
  chmodSync(INSTALLED_AUTOPATCH, 0o755);
  // Remove macOS quarantine if present (harmless if not)
  try {
    execSync(`xattr -dr com.apple.provenance "${INSTALL_DIR}" 2>/dev/null`, { stdio: "ignore" });
    execSync(`xattr -dr com.apple.quarantine "${INSTALL_DIR}" 2>/dev/null`, { stdio: "ignore" });
  } catch {}
}

function log(step, total, msg) {
  console.log(`\n  [${step}/${total}] ${msg}`);
}

// Atomic JSON write: temp file + rename. Prevents corruption on crash.
function writeJsonAtomic(path, obj) {
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf-8");
  renameSync(tmp, path);
}

function findNode() {
  // Prefer the Node that's running us
  if (process.execPath && existsSync(process.execPath)) {
    return process.execPath;
  }
  try {
    return execSync("which node", { encoding: "utf-8", timeout: 5000 }).trim();
  } catch {
    for (const p of ["/opt/homebrew/bin/node", "/usr/local/bin/node"]) {
      if (existsSync(p)) return p;
    }
    return null;
  }
}

function findClaudeBinary() {
  // Check default location first
  if (existsSync(CLAUDE_BIN)) return CLAUDE_BIN;

  // Try PATH lookup
  try {
    const result = execSync("which claude", { encoding: "utf-8", timeout: 5000 }).trim();
    if (result && existsSync(result)) return result;
  } catch {}

  // Try common alternate locations
  for (const p of [
    join(HOME, ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

export async function setup(options = {}) {
  const STEPS = 7;
  const port = process.env.GPT_PROXY_PORT || "52532";

  console.log("\n  === GPT for Claude Code ===\n");

  // Platform check
  if (platform() !== "darwin") {
    console.error(`\n  ERROR: Currently macOS only. Detected: ${platform()}`);
    console.error("  Linux/Windows support coming soon.");
    throw new Error("Unsupported platform");
  }

  // ---- Consent: acknowledge local binary modification before proceeding ----
  // This is the user's explicit, informed acknowledgement of the local
  // adaptation being performed. Do not bypass it without deliberate action
  // by the user (TTY blank-Enter or GPTCC_ACCEPT_RISK=1).
  const accepted = await confirmToSRisk();
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
    console.error(`  ERROR: Claude Code binary not found.`);
    console.error(`  Searched: ${CLAUDE_BIN}, PATH, homebrew, /usr/local/bin`);
    console.error(`  Set CLAUDE_BINARY env var to override.`);
    throw new Error("Prerequisite check failed");
  }
  console.log(`  Claude Code: ${claudeBin}`);

  try {
    execSync("python3 --version", { stdio: "pipe" });
    console.log(`  Python3: ${execSync("python3 --version", { encoding: "utf-8" }).trim()}`);
  } catch {
    console.error("  ERROR: python3 not found. Required for binary patching.");
    throw new Error("Prerequisite check failed");
  }

  // ---- Step 1b: Install scripts to safe location ----
  console.log(`  Installing to ${INSTALL_DIR}...`);
  copyToInstallDir();
  console.log("  Scripts installed");

  // ---- Step 2: Login ----
  log(2, STEPS, "ChatGPT Login...");

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

  // ---- Step 3: Configure settings.json ----
  log(3, STEPS, "Configuring Claude Code settings...");

  mkdirSync(join(HOME, ".claude"), { recursive: true });

  // Backup existing settings before mutation (enables recovery on setup failure)
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

  // Custom model labels — write as a coherent unit to avoid partial state on reruns
  // Guard on the model ID (primary key), not the label
  if (!settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL = "claude-sonnet-4-6-20250514";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME = "Sonnet 4.6";
    settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION = "Sonnet 4.6 · Everyday tasks";
  }
  if (!settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL = "claude-haiku-4-5-20251001";
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME = "Haiku 4.5";
    settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION = "Haiku 4.5 · Fast";
  }

  const gptModels = [
    "opus", "sonnet", "haiku", "sonnet[1m]",
    "gpt-5.4", "gpt-5.4-fast", "gpt-5.4-mini",
    "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2",
  ];
  const existing = settings.availableModels || [];
  for (const m of gptModels) {
    if (!existing.includes(m)) existing.push(m);
  }
  settings.availableModels = existing;

  // NOTE: ANTHROPIC_BASE_URL is NOT written here. It is set only after
  // the proxy is verified healthy (Step 5) to avoid pointing Claude Code
  // at a dead endpoint if setup fails partway.
  writeJsonAtomic(SETTINGS_PATH, settings);
  console.log("  Settings updated (ANTHROPIC_BASE_URL deferred until proxy verified)");

  // ---- Step 4: Patch binary ----
  log(4, STEPS, "Patching Claude Code binary...");

  const patchResult = spawnSync("python3", [INSTALLED_PATCH], { stdio: "inherit" });
  if (patchResult.status !== 0) {
    console.error("  WARNING: Patch failed. GPT models may not appear in /model picker.");
    console.error("  Run 'gptcc diagnose' for details.");
    console.error("  Continuing setup (proxy and auto-patch will still work)...");
  }

  // ---- Step 5: Start proxy ----
  log(5, STEPS, "Starting proxy...");

  const proxyScript = INSTALLED_PROXY;

  // Check if already running
  let proxyRunning = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    const data = await res.json();
    if (data.proxy === "gptcc") proxyRunning = true;
  } catch {}

  if (!proxyRunning) {
    const child = spawn(nodePath, [proxyScript], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HOME, GPT_PROXY_PORT: port },
    });
    child.unref();

    // Wait for startup
    for (let i = 0; i < 20; i++) {
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

  console.log(proxyRunning
    ? `  Proxy running on port ${port}`
    : "  WARNING: Proxy may not have started. Check ~/Library/Logs/gpt-proxy.log");

  // ---- Step 5b: Commit ANTHROPIC_BASE_URL now that proxy is verified ----
  // If proxy never started, skip this — don't break Claude Code
  if (proxyRunning) {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      s.env = s.env || {};
      s.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`;
      writeJsonAtomic(SETTINGS_PATH, s);
      console.log("  ANTHROPIC_BASE_URL committed to settings");
    } catch (err) {
      console.error(`  WARNING: Could not update settings: ${err.message}`);
    }
  } else {
    console.error("  ANTHROPIC_BASE_URL NOT set — proxy is not healthy.");
    console.error("  Run 'gptcc status' and 'gptcc setup' again after fixing.");
  }

  // ---- Step 6: launchd + plugin ----
  log(6, STEPS, "Setting up auto-start & plugin...");

  const launchAgentsDir = join(HOME, "Library", "LaunchAgents");
  mkdirSync(launchAgentsDir, { recursive: true });

  // Proxy auto-start plist
  const proxyPlist = join(launchAgentsDir, "com.gptcc.proxy.plist");
  writeFileSync(proxyPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.gptcc.proxy</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${proxyScript}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/gpt-proxy.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/gpt-proxy.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
        <key>GPT_PROXY_PORT</key>
        <string>${port}</string>
    </dict>
</dict>
</plist>
`);
  try {
    execSync(`launchctl unload "${proxyPlist}" 2>/dev/null; launchctl load "${proxyPlist}"`, { stdio: "pipe" });
    console.log("  Proxy auto-start: OK");
  } catch {}

  // Auto-patch watcher plist — uses installed script path (not PROJECT_ROOT)
  const watcherPlist = join(launchAgentsDir, "com.gptcc.watcher.plist");
  writeFileSync(watcherPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.gptcc.watcher</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALLED_AUTOPATCH}</string>
    </array>
    <key>WatchPaths</key>
    <array>
        <string>${claudeBin}</string>
    </array>
    <key>StandardOutPath</key>
    <string>${HOME}/Library/Logs/gptcc-patch.log</string>
    <key>StandardErrorPath</key>
    <string>${HOME}/Library/Logs/gptcc-patch.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>${HOME}</string>
        <key>PATH</key>
        <string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    </dict>
</dict>
</plist>
`);
  try {
    execSync(`launchctl unload "${watcherPlist}" 2>/dev/null; launchctl load "${watcherPlist}"`, { stdio: "pipe" });
    console.log("  Auto-patch watcher: OK");
  } catch {}

  // Register Claude Code plugin
  const pluginDir = join(PROJECT_ROOT, "plugin");
  try {
    spawnSync(claudeBin, ["plugin", "add", pluginDir], { stdio: "pipe", timeout: 10000 });
    console.log("  Claude Code plugin: OK");
  } catch {
    console.log("  Claude Code plugin: skipped (register manually with: claude plugin add)");
  }

  // Done
  console.log("\n  === Setup complete! ===\n");
  console.log("  Usage:");
  console.log("    claude --model gpt-5.4          # Use GPT-5.4");
  console.log("    claude --model gpt-5.4-fast     # Use GPT-5.4 Fast");
  console.log("    /model                           # Select from picker");
  console.log("");
}

export async function uninstall() {
  console.log("\n  === Uninstalling GPT for Claude Code ===\n");

  // Stop proxy
  try { execSync('pkill -f "proxy.mjs"', { stdio: "pipe" }); } catch {}

  // Remove launchd
  const launchAgentsDir = join(HOME, "Library", "LaunchAgents");
  for (const name of ["com.gptcc.proxy.plist", "com.gptcc.watcher.plist"]) {
    const plist = join(launchAgentsDir, name);
    if (existsSync(plist)) {
      try {
        execSync(`launchctl unload "${plist}"`, { stdio: "pipe" });
        const { unlinkSync } = await import("fs");
        unlinkSync(plist);
      } catch {}
    }
  }
  console.log("  LaunchAgents removed");

  // Restore binary (prefer installed path, fallback to project root)
  const patchScript = existsSync(INSTALLED_PATCH) ? INSTALLED_PATCH : join(PROJECT_ROOT, "scripts", "patch-claude.py");
  try {
    spawnSync("python3", [patchScript, "--restore"], { stdio: "inherit" });
  } catch {}

  // Remove installed scripts
  if (existsSync(INSTALL_DIR)) {
    try {
      const { rmSync } = await import("fs");
      rmSync(INSTALL_DIR, { recursive: true, force: true });
      console.log("  Installed scripts removed");
    } catch {}
  }

  // Clean settings
  if (existsSync(SETTINGS_PATH)) {
    try {
      const settings = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      if (settings.env) {
        delete settings.env.ANTHROPIC_BASE_URL;
        delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_NAME;
        delete settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION;
        delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME;
        delete settings.env.ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION;
        if (Object.keys(settings.env).length === 0) delete settings.env;
      }
      const gptModels = new Set(["gpt-5.4", "gpt-5.4-fast", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.3-codex-spark", "gpt-5.2"]);
      settings.availableModels = (settings.availableModels || []).filter((m) => !gptModels.has(m));
      if (settings.availableModels.length === 0) delete settings.availableModels;
      writeJsonAtomic(SETTINGS_PATH, settings);
      console.log("  Settings cleaned");
    } catch {}
  }

  console.log("\n  Done. GPT for Claude Code removed.\n");
}

export async function status() {
  const port = process.env.GPT_PROXY_PORT || "52532";

  console.log("\n  === GPT for Claude Code Status ===\n");

  // Proxy
  let proxyOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
    const data = await res.json();
    proxyOk = data.proxy === "gptcc";
    console.log(`  Proxy:     ${proxyOk ? "running" : "NOT running"} (port ${port})`);
  } catch {
    console.log(`  Proxy:     NOT running (port ${port})`);
  }

  // Auth
  if (existsSync(AUTH_PATH)) {
    try {
      const auth = JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
      const b64 = auth.tokens.access_token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
      const payload = JSON.parse(Buffer.from(b64, "base64").toString());
      const exp = new Date(payload.exp * 1000);
      const expired = exp < new Date();
      console.log(`  Auth:      ${expired ? "EXPIRED" : "valid"} (expires ${exp.toLocaleString()})`);
    } catch {
      console.log("  Auth:      present but unreadable");
    }
  } else {
    console.log("  Auth:      NOT logged in");
  }

  // Binary patch
  if (existsSync(CLAUDE_BIN)) {
    const data = readFileSync(CLAUDE_BIN);
    const patched = data.includes(Buffer.from('"gpt-5.4","gpt-5.4-fast"'));
    console.log(`  Patch:     ${patched ? "applied" : "NOT applied"}`);
  } else {
    console.log("  Patch:     Claude binary not found");
  }

  // Settings
  if (existsSync(SETTINGS_PATH)) {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      const hasUrl = s.env?.ANTHROPIC_BASE_URL?.includes("127.0.0.1");
      const hasModels = s.availableModels?.includes("gpt-5.4");
      console.log(`  Settings:  URL=${hasUrl ? "OK" : "missing"} Models=${hasModels ? "OK" : "missing"}`);
    } catch {
      console.log("  Settings:  error reading");
    }
  }

  console.log("");
}
