#!/usr/bin/env node

// GPT for Claude Code CLI
// Usage: gptcc <command>

import { checkAndUpdate } from "../lib/updater.mjs";

const command = process.argv[2] || "help";

// Auto-update check on every invocation (cached 24h)
// Skip for commands that need to work offline / during first-run:
const SKIP_UPDATE_FOR = new Set(["help", "--help", "-h", "setup", "login", "uninstall", "status", "diagnose"]);
if (!SKIP_UPDATE_FOR.has(command)) {
  const updated = await checkAndUpdate();
  if (updated) {
    // Re-exec using process.argv[1] (the actual script path), not bare "gptcc"
    // This avoids PATH resolution issues after npm install -g
    const { spawnSync } = await import("child_process");
    const result = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)], {
      stdio: "inherit",
    });
    process.exit(result.status ?? 1);
  }
}

switch (command) {
  case "setup": {
    const { setup } = await import("../lib/setup.mjs");
    try {
      await setup();
    } catch (err) {
      console.error(`\n  Setup failed: ${err.message}`);
      if (process.env.GPTCC_DEBUG) console.error(err.stack);
      console.error("  Partial state may remain in:");
      console.error("    ~/.claude/settings.json (backup at settings.json.gptcc-backup if modified)");
      console.error("    ~/.local/share/gptcc/ (installed scripts)");
      console.error("    ~/Library/LaunchAgents/com.gptcc.*.plist (launchd agents)");
      console.error("  Run 'gptcc uninstall' to clean up, then retry.");
      process.exit(1);
    }
    break;
  }

  case "login": {
    const { login } = await import("../lib/login.mjs");
    try {
      await login();
    } catch (err) {
      console.error(`\n  Login failed: ${err.message}`);
      if (process.env.GPTCC_DEBUG) console.error(err.stack);
      process.exit(1);
    }
    break;
  }

  case "patch":
  case "diagnose": {
    const { spawnSync } = await import("child_process");
    const { join, dirname } = await import("path");
    const { fileURLToPath } = await import("url");
    const { existsSync } = await import("fs");
    const { homedir, platform } = await import("os");

    if (platform() !== "darwin") {
      console.error("  ERROR: Binary patching is currently macOS-only.");
      process.exit(1);
    }

    // Prefer installed location (~/.local/share/gptcc/scripts/) — set up by 'setup'
    const installedPatch = join(homedir(), ".local", "share", "gptcc", "scripts", "patch-claude.py");
    const projectPatch = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "patch-claude.py");
    const patchScript = existsSync(installedPatch) ? installedPatch : projectPatch;

    if (!existsSync(patchScript)) {
      console.error(`  ERROR: patch script not found. Run 'gptcc setup' first.`);
      process.exit(1);
    }

    const args = command === "diagnose" ? [patchScript, "--diagnose"] : [patchScript];
    const result = spawnSync("python3", args, { stdio: "inherit" });

    if (command === "patch" && result.status !== 0) {
      console.error("  Patch failed. Run 'gptcc diagnose' for details.");
    }
    process.exit(result.status ?? 1);
  }

  case "status": {
    const { status } = await import("../lib/setup.mjs");
    await status();
    break;
  }

  case "uninstall": {
    const { uninstall } = await import("../lib/setup.mjs");
    await uninstall();
    break;
  }

  case "proxy": {
    await import("../lib/proxy.mjs");
    break;
  }

  case "help":
  case "--help":
  case "-h":
  default: {
    const isHelp = command === "help" || command === "--help" || command === "-h";
    if (!isHelp) {
      console.error(`\n  Unknown command: ${command}\n`);
    }
    console.log(`
  GPT for Claude Code

  Usage: gptcc <command>

  Commands:
    setup       One-touch install (login + patch + proxy + auto-start)
    login       (Re)login to ChatGPT
    patch       Re-apply binary patch
    diagnose    Debug patch pattern matching
    status      Show proxy, auth, and patch status
    uninstall   Remove everything
    proxy       Start proxy in foreground (debug)
    help        Show this help

  Auto-updates are checked on every run (cached 24h).
  Set GPTCC_NO_UPDATE=1 to disable auto-updates.
  Set GPTCC_DEBUG=1 for verbose logging.
`);
    if (!isHelp) process.exit(1);
    break;
  }
}
