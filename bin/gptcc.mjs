#!/usr/bin/env node

// GPT for Claude Code CLI
// Usage: gptcc <command>

import { checkAndUpdate } from "../lib/updater.mjs";

const command = process.argv[2] || "help";

// Auto-update check on every invocation (cached 24h)
// Skip for commands that need to work offline / during first-run:
// Commands that skip the auto-update check.
//
// Only commands that need to work offline or must exit fast:
//   - help / --help / -h  : must work offline on a fresh checkout
//   - uninstall           : users uninstalling shouldn't be blocked by npm
//   - proxy               : long-running process; update re-exec would drop it
//
// setup/login/status/doctor/hello intentionally DO run the update check,
// because those are the commands users run while troubleshooting — they
// should pick up the latest fix automatically rather than leaving the
// user on a stale version.
const SKIP_UPDATE_FOR = new Set([
  "help",
  "--help",
  "-h",
  "uninstall",
  "proxy",
  "setting",
]);
if (process.env.GPTCC_SKIP_UPDATE === "1") {
  // skip update check entirely (test-mode shortcut)
} else if (!SKIP_UPDATE_FOR.has(command)) {
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
      // Parse optional --model and --multi-slot flags
      const args = process.argv.slice(3);
      const modelIdx = args.indexOf("--model");
      const options = {};
      if (modelIdx >= 0 && args[modelIdx + 1]) options.model = args[modelIdx + 1];
      if (args.includes("--multi-slot")) options.multiSlot = true;
      if (args.includes("--hybrid")) options.hybrid = true;
      if (args.includes("--force-login")) options.forceLogin = true;
      if (args.includes("--device") || args.includes("--device-code")) options.device = true;
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
      const args = process.argv.slice(3);
      const opts = {};
      if (args.includes("--device") || args.includes("--device-code")) {
        opts.device = true;
      }
      await login(opts);
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

  case "doctor": {
    const { doctor } = await import("../lib/doctor.mjs");
    const code = await doctor();
    process.exit(code);
    break;
  }

  case "hello": {
    const { hello } = await import("../lib/hello.mjs");
    const code = await hello();
    process.exit(code);
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

  case "setting": {
    const { readConfig, setKey, resetConfig, defaultConfigPath, VALID_KEYS } =
      await import("../lib/config.mjs");
    const path = process.env.GPTCC_CONFIG_PATH || defaultConfigPath();
    const sub = process.argv[3];
    try {
      if (!sub || sub === "list") {
        console.log(JSON.stringify(readConfig(path), null, 2));
        break;
      }
      if (sub === "reset") {
        resetConfig(path);
        console.log(JSON.stringify(readConfig(path), null, 2));
        break;
      }
      // key + value form
      const key = sub;
      const value = process.argv[4];
      if (value === undefined) {
        console.error(`Usage: gptcc setting <key> <value>\n  keys: ${VALID_KEYS.join(", ")}`);
        process.exit(2);
      }
      setKey(path, key, value);
      console.log(JSON.stringify(readConfig(path), null, 2));
    } catch (err) {
      console.error(err.message);
      process.exit(2);
    }
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
    setup [--model <id>]        One-touch install. Default behavior: Claude
                                slots untouched; GPT added as an extra option
                                in /model picker. Pick GPT manually to use it.
    setup --hybrid               Advanced: remap Sonnet/Haiku slots so that
                                 Default auto-routes to GPT on Pro accounts.
                                 Claude Opus stays accessible.
    setup --multi-slot           All slots become GPT (Claude models hidden).
    setup --device               Use device-code login (for headless machines)
    login                        Sign in via browser (default)
    login --device               Device-code flow for SSH / Docker / CI
    doctor                       Run 5-layer self-diagnostic + repair hints
    hello                        End-to-end smoke test after setup
    status                       Show proxy, auth, and settings status
    proxy                        Run proxy in the foreground (debug)
    uninstall                    Remove everything and restore settings
    help                         Show this help

  Environment:
    GPTCC_DEFAULT_MODEL          Default model ID (default: gpt-5.4-fast)
    GPTCC_MULTI_SLOT=1           Use 4-model picker mode on next setup
    GPTCC_NO_UPDATE=1            Disable the auto-update check
    GPTCC_DEBUG=1                Verbose logging
    GPTCC_ACCEPT=1               Skip the interactive consent prompt
    OPENAI_API_KEY               If set, proxy uses api.openai.com instead of the
                                 Codex backend (uses API credits, not ChatGPT subscription)
    GPT_PROXY_PORT               Proxy port (default: 52532)
    CLAUDE_BINARY                Override Claude Code binary path
`);
    if (!isHelp) process.exit(1);
    break;
  }
}
