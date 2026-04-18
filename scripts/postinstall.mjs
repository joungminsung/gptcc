#!/usr/bin/env node
// Runs after `npm install -g gptcc`. The goal is to nudge interactive
// users toward `gptcc setup` without breaking unattended installs
// (CI, Docker builds, sudo root installs, system imaging).
//
// Silent in every non-interactive case — no nagging on CI, no stderr,
// no exit-code pollution. npm's own postinstall failures are visible,
// so this script must not be one.

try {
  // Global install only. On local installs (inside someone else's
  // project), we're a dep or devDep and shouldn't print banners.
  if (process.env.npm_config_global !== "true") process.exit(0);

  // Non-interactive environments: CI, Docker, tests, scripted installs.
  if (!process.stdout.isTTY) process.exit(0);
  if (process.env.CI === "true" || process.env.CI === "1") process.exit(0);
  if (process.env.GPTCC_SKIP_POSTINSTALL === "1") process.exit(0);

  // A concise, one-screen banner. No emoji, no color escape tricks that
  // break on older Windows cmd.
  const msg = [
    "",
    "  gptcc installed.",
    "",
    "  Next steps:",
    "    gptcc setup        # one-time login + proxy + Claude Code hookup",
    "    gptcc hello        # end-to-end test after setup",
    "",
    "  Docs: https://github.com/joungminsung/gptcc",
    "",
  ].join("\n");

  process.stdout.write(msg);
} catch {
  // Any failure in the banner is silent. npm install must not fail
  // because we couldn't print a hint.
}

process.exit(0);
