#!/usr/bin/env node

// GPT for Claude Code CLI
// Usage: gptcc <command>

import { checkAndUpdate } from "../lib/updater.mjs";

const command = process.argv[2] || "help";

// Auto-update check on every invocation (cached 24h)
// Skip for commands that need to work offline / during first-run:
const SKIP_UPDATE_FOR = new Set([
  "help",
  "--help",
  "-h",
  "setup",
  "login",
  "uninstall",
  "status",
]);
if (!SKIP_UPDATE_FOR.has(command)) {
  const updated = await checkAndUpdate();
  if (updated) {
    // Re-exec using process.argv[1] (the actual script path), not bare "gptcc"
    // This avoids PATH resolution issues after npm install -g
    const { spawnSync } = await import("child_process");
    const result = spawnSync(
      process.execPath,
      [process.argv[1], ...process.argv.slice(2)],
      { stdio: "inherit" }
    );
    process.exit(result.status ?? 1);
  }
}

switch (command) {
  case "setup": {
    const { setup } = await import("../lib/setup.mjs");
    try {
      // Parse optional --model flag
      const args = process.argv.slice(3);
      const modelIdx = args.indexOf("--model");
      const options = {};
      if (modelIdx >= 0 && args[modelIdx + 1]) options.model = args[modelIdx + 1];
      if (args.includes("--force-login")) options.forceLogin = true;
      await setup(options);
    } catch (err) {
      console.error(`\n  Setup failed: ${err.message}`);
      if (process.env.GPTCC_DEBUG) console.error(err.stack);
      console.error("  Partial state may remain in:");
      console.error("    ~/.claude/settings.json (backup at settings.json.gptcc-backup if modified)");
      console.error("    ~/.local/share/gptcc/ (installed proxy)");
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
    setup [--model <id>]    One-touch install (login + proxy + settings + plugin)
    login                    (Re)login to ChatGPT
    status                   Show proxy, auth, and settings status
    proxy                    Run proxy in the foreground (debug)
    uninstall                Remove everything and restore settings
    help                     Show this help

  Environment:
    GPTCC_DEFAULT_MODEL      Default model ID used during setup (default: gpt-5.4-fast)
    GPTCC_NO_UPDATE=1        Disable the auto-update check
    GPTCC_DEBUG=1            Verbose logging
    GPTCC_ACCEPT=1           Skip the interactive consent prompt (non-interactive installs)
    GPT_PROXY_PORT           Proxy port (default: 52532)
    CLAUDE_BINARY            Override Claude Code binary path
`);
    if (!isHelp) process.exit(1);
    break;
  }
}
