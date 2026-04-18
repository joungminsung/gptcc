# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.3] - Windows proxy detach fix

### Fixed

- **Windows: `gptcc setup` now actually starts the background proxy.**
  On v2.1.2 and earlier, `setup` used `spawn({detached: true})`, which on
  Windows keeps the child bound to the parent console — so the proxy
  died the instant `gptcc setup` exited, and the subsequent
  `gptcc hello` saw `fetch failed`. Fixed by routing through
  `cmd.exe /c start "" /B <node> <proxy>`, which is the documented
  Windows detach path.
- Same fix applied to the plugin SessionStart hook
  (`plugin/hooks/start-proxy.mjs`): Windows sessions will now re-start
  the proxy automatically if it isn't already running.

POSIX (macOS / Linux) code path unchanged.

### Migration

`npm install -g gptcc@latest && gptcc setup`. Zero-touch upgrade. If
you're already on 2.1.2 and macOS/Linux, there's nothing new — the fix
only affects Windows.

## [2.1.2] - Cross-review fixes

Cross-review (Claude + GPT-5.4) identified a set of release-quality
issues in v2.1.1 that this patch cleans up. Both reviewers independently
flagged the `npm test` glob and the stale version strings; each flagged
additional platform-specific items that only showed up on one side.

### Fixed

- `npm test` script no longer uses single-quoted globs, which `cmd.exe`
  can't expand. Now invokes Node with explicit test files so the suite
  runs on macOS, Linux, and Windows alike.
- Windows `start-proxy.cmd` wrapper now probes `/health` (the proxy
  rejects non-`/v1/*` GETs with "Invalid path") and defaults
  `GPT_PROXY_PORT` to `52532` when unset. Previously the hook would mis-
  detect a healthy proxy and spawn a second one every session.
- Windows `stopProxy()` no longer relies on the `WINDOWTITLE` taskkill
  filter (which never matched detached Node processes). It now enumerates
  listeners on `GPT_PROXY_PORT` via `netstat -ano` and kills the owning
  PIDs.
- Linux proxy log path switched from the macOS-only `~/Library/Logs/`
  to `$XDG_STATE_HOME/gptcc` (defaults to `~/.local/state/gptcc`). The
  `nohup` redirect on Linux previously failed silently because the
  directory didn't exist.
- Version strings synced: `/health`, proxy startup log, and
  `plugin/.claude-plugin/plugin.json` all report `2.1.2` now (v2.1.1
  shipped with stale `2.1.0` in those three places).

### Changed

- Pure helpers (`parseBedrockInvoke`, `isOpenAIModel`, `checkProxyAuth`)
  extracted from `lib/proxy.mjs` into a new `lib/routing.mjs` module.
  The test suite now imports those helpers directly, closing the
  drift gap — previously tests held their own inline copies, which
  could stay green even if `proxy.mjs` regressed.
- `CHANGELOG` entry for 2.1.1 clarified: the release did change
  `package.json`, so "no code changes" was too strong. It was
  documentation + metadata.

### Migration from 2.1.x

Zero-touch: `npm install -g gptcc@latest`. Existing installs can stay on
2.1.1 safely on macOS; Windows/Linux users should upgrade to pick up
the platform-specific fixes.

## [2.1.1] - Doc polish

### Changed

- README repositioned — tone made less apologetic, hero and About box
  updated to reflect that gptcc is an extension (not a "small community
  experiment"). Added `gptcc hello` to the first-install command block.
- New **Use cases** section with five concrete workflows (cross-review,
  architecture second opinion, stuck-bug diagnosis, GPT-only sessions,
  parallel sketches) — replaces abstract "cross-review" positioning.
- New FAQ entries comparing gptcc to LiteLLM, claude-code-router, and
  Codex CLI. Honest about what each alternative does well; specific
  about where gptcc fits.

### Added

- `docs/blog/geeknews.md` — Korean submission draft for news.hada.io.

No code changes.

## [2.1.0] - Multi-slot picker, diagnostics, hardening

### Added

- **`gptcc doctor`** — 5-layer self-diagnostic. Checks the Claude Code
  binary, settings, OAuth, proxy, and plugin registration in one pass.
  Surfaces the exact failing layer plus a one-line fix.
- **`gptcc hello`** — end-to-end smoke test. Sends a tiny prompt through
  the proxy and confirms a GPT response. First-success experience right
  after `gptcc setup`.
- **Multi-slot mode** (`gptcc setup --multi-slot`) — registers GPT-5.4,
  GPT-5.4 Fast, GPT-5.4 Mini, and GPT-5.3 Codex as four separate entries
  in Claude Code's `/model` picker. Uses Claude Code's documented
  `CLAUDE_CODE_USE_BEDROCK=1` mode together with a new Bedrock-compatible
  endpoint on the proxy (`/model/<id>/invoke`). Off by default in this
  release.
- **`OPENAI_API_KEY` fallback** — when set, the proxy routes to
  `api.openai.com/v1/responses` instead of the Codex backend. Lets users
  pay in OpenAI API credits and protects against any future Codex-backend
  policy change.
- **Proxy auth token** — setup generates a random `gptcc_*` token and
  writes it to `ANTHROPIC_AUTH_TOKEN`. The proxy now rejects any request
  that doesn't carry the matching `Authorization: Bearer ...` header,
  stopping other local processes on the same machine from driving it.
- **Layered error messages** — upstream failures are now tagged with the
  layer that failed (`[upstream:codex]`, `[upstream:openai]`, `[bridge]`,
  `[config]`) plus a next-step hint. No more opaque 500s.
- **`node --test`-based test suite** — routing and auth-token unit tests.
  Run with `npm test`. Lays the groundwork for safer refactors.

### Changed

- `/health` now reports `features`: `bedrockInvoke`, `apiKeyFallback`,
  `authRequired`. Makes `gptcc doctor` output more informative.
- `gptcc setup` end message now points at `gptcc hello` / `gptcc doctor`
  first, and explains single-slot vs multi-slot mode.
- Uninstaller cleans multi-slot keys (`ANTHROPIC_DEFAULT_*_MODEL*`,
  `CLAUDE_CODE_USE_BEDROCK`, `ANTHROPIC_BEDROCK_BASE_URL`,
  `ANTHROPIC_AUTH_TOKEN`) in addition to the single-slot keys.

### Fixed

- Cleaner shutdown of the Codex request stream on client disconnect
  (`AbortError` no longer propagates as an unhandled bridge error).

### Migration from 2.0

Zero-touch: `npm install -g gptcc@latest` and re-run `gptcc setup`.
Existing OAuth tokens, pins, and plugin registration are reused. Run
`gptcc setup --multi-slot` if you want four GPT models in the picker.

## [2.0.0] - No binary modification, cross-platform

This release removes all binary modification of Claude Code. gptcc now
uses only **documented Claude Code extension points** — environment
variables, `settings.json`, and the plugin hook system — the same
mechanisms used by LiteLLM, LM Studio, Ollama, and vLLM.

### Breaking changes

- **No binary adapter.** The 2.x installer does not patch Claude Code.
  Instead it sets `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_MODEL_OPTION`,
  and related variables. If you previously used `gptcc` 1.x, run
  `gptcc uninstall` before upgrading — the new uninstaller also restores
  any lingering binary backup from a 1.x install.
- **`gptcc patch` and `gptcc diagnose` commands removed.** No binary
  modification means nothing to patch or diagnose at that level.
- **No Python 3 requirement.** The patcher used Python; the new install
  flow is pure Node.js.
- **No launchd dependency.** Proxy auto-start moved to the Claude Code
  plugin's SessionStart hook, which is cross-platform.

### Added

- **Linux and Windows support.** Cross-platform setup, uninstaller, and
  status. Previously macOS-only.
- **`plugin/agents/` subagent bundle** — `gpt-reviewer`, `gpt-bug`, and
  `gpt-arch` markdown subagents, each pinned to a GPT model via
  frontmatter. Invoke with
  `Agent(subagent_type: "gpt-reviewer", prompt: "...")`.
- **Cross-platform `SessionStart` proxy starter** — `plugin/hooks/start-proxy.mjs`
  replaces the macOS bash script.
- **`--model` flag** on `gptcc setup` and `GPTCC_DEFAULT_MODEL` env var to
  choose which GPT variant lands in the `/model` picker.
- **`_SUPPORTED_CAPABILITIES`** declared so Claude Code enables `effort`,
  `thinking`, `adaptive_thinking`, and `interleaved_thinking` for the GPT
  entry.

### Changed

- Setup steps reduced from 7 to 5. Faster install, no
  codesign / xattr / launchd setup on macOS.
- Uninstaller is best-effort on pre-2.0 state (legacy launchd plists,
  binary backup) while also cleaning the new 2.0 settings.
- Consent prompt wording changed from "binary modification" to "install
  configuration" — reflects what actually happens now.
- README positioning shifted from "interoperability tool that modifies
  the Claude Code binary" to "community tool that uses documented
  extension points."

### Removed

- `scripts/patch-claude.py` — the binary patcher.
- `scripts/autopatch.sh` — the launchd watcher script.
- Reverse-engineering defense clauses (DMCA §1201(f), 17 U.S.C. §117(a),
  Sega v. Accolade) from README and SECURITY.md — no reverse engineering
  means those are not needed.
- `TAKEDOWN_POLICY.md` — takedown note collapsed into SECURITY.md § Takedown.
- `"os": ["darwin"]` constraint from package.json.

### Migration from 1.x

```bash
gptcc uninstall                 # cleans the old install (restores the
                                # Claude Code binary from backup)
npm install -g gptcc@2
gptcc setup
```

Your `~/.codex/auth.json` OAuth tokens are reused — no re-login needed.

## [1.1.0] - CLI name unified with package name

### Changed

- **CLI command renamed `gpt-cc` → `gptcc`** to match the npm package name.
  Install (`npm i -g gptcc`) and run (`gptcc setup`) now use the same
  identifier. All environment variables, launchd labels, install paths, and
  log filenames migrated accordingly:
  - env vars: `GPT_CC_ACCEPT_RISK` → `GPTCC_ACCEPT_RISK`, `GPT_CC_NO_UPDATE`
    → `GPTCC_NO_UPDATE`, `GPT_CC_DEBUG` → `GPTCC_DEBUG`
  - launchd: `com.gpt-cc.proxy` / `com.gpt-cc.watcher` → `com.gptcc.proxy` /
    `com.gptcc.watcher`
  - install dir: `~/.local/share/gpt-cc/` → `~/.local/share/gptcc/`
  - logs: `~/Library/Logs/gpt-cc-*.log` → `~/Library/Logs/gptcc-*.log`
  - settings backup suffix: `.gpt-cc-backup` → `.gptcc-backup`
- README/CONTRIBUTING/TAKEDOWN_POLICY updated to use `gptcc` throughout.

### Migration

Existing installs from `1.0.x` should:

1. Run `gptcc uninstall` (the old CLI name still works in 1.0.x).
2. Upgrade: `npm install -g gptcc@1.1.0`.
3. Reinstall: `gptcc setup`.

## [1.0.1] - Doc polish

### Changed

- README/CONTRIBUTING/CHANGELOG examples updated so `npm install -g gptcc`
  consistently reflects the actual npm package name.

## [1.0.0] - Initial release as `gptcc`

This is the first release under the new package identity. The project was
previously published as `gpt-bridge-cc` (final version `2.1.0`), which has
been deprecated in favor of this package. Functionality is equivalent; the
rename was made to clean up the project's identity and the CLI ergonomics.

### Project identity

- **npm package:** `gptcc`
- **CLI command:** `gptcc` (e.g. `gptcc setup`, `gptcc status`,
  `gptcc uninstall`) — unified with the package name starting in 1.1.0.
- **Display name:** GPT for Claude Code
- **License:** MIT
- **Scope:** non-commercial community research tool for personal
  development environments

### Core functionality

- **CLI** (`gptcc`) with commands: `setup`, `login`, `patch`, `diagnose`,
  `status`, `proxy`, `uninstall`, `help`.
- **One-touch setup** — login, settings, binary adaptation, proxy startup,
  launchd auto-start, auto-patch watcher, Claude Code plugin registration.
- **Device Code OAuth login** — direct to ChatGPT via OpenAI's OAuth flow.
  No Codex CLI dependency.
- **Local HTTP proxy** — translates Anthropic Messages API ↔ OpenAI
  Responses API, routing by model name. Binds to `127.0.0.1` only.
- **Binary adapter** — adds GPT models to Claude Code's `/model` picker and
  the Agent tool's model enum. Byte-length-neutral. Structural regex adapts
  to minifier renames between Claude Code releases.
- **Auto-update watcher** — launchd watches the Claude Code binary and
  re-applies the adapter on updates. Self-updates `gptcc` from npm on
  pattern failure and retries.
- **Auto-update on CLI** — every non-first-run command checks npm for a
  newer version (24h cached). Disable with `GPTCC_NO_UPDATE=1`.
- **GPT prompt optimization** — replaces Claude Code's identity/workflow
  system prompt with a minimal GPT-appropriate prompt when routing to a
  GPT model, preserving only the user's CLAUDE.md content verbatim.
- **Claude Code plugin** — SessionStart hook (ensures proxy is running) +
  orchestration skill with GPT prompt templates and cross-review protocol.
- **MCP server** — `ask_gpt54` and `review_with_gpt54` tools usable from
  any MCP-aware client.

### Legal & consent hardening

- **Explicit consent prompt** in `gptcc setup` — TTY users confirm the
  local binary adaptation step explicitly. Non-interactive installs must
  set `GPTCC_ACCEPT_RISK=1` to proceed.
- **[TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md)** — documented 24-hour
  compliance SLA for formal takedown requests from Anthropic, OpenAI, or
  other rightful parties. No forced escalation.
- **README FAQ** — straightforward discussion of the ToS gray area, the
  DMCA §1201(f) / 17 U.S.C. §117(a) / Sega v. Accolade interoperability
  basis, and the recommended scope of use (personal development
  environments only).
- **CONTRIBUTING § Things We Won't Accept** — explicit list of PR
  categories that will be closed without merge (telemetry, monetization
  hooks, consent-prompt removal, pre-patched binary redistribution, etc.).
- **Legal-position docstring** in `scripts/patch-claude.py` — explicit
  statement of the interoperability-exception basis inside the adapter.

### Security & operational properties

- OAuth tokens stored in `~/.codex/auth.json` with `0o600` permissions.
- Auth file written atomically (temp file + rename) to prevent corruption.
- Anthropic passthrough restricted to `/v1/*` paths (SSRF prevention).
- Endpoint override allowlist (host must match `openai.com` / `anthropic.com`).
- Settings file written atomically.
- npm auto-update uses `process.execPath`-adjacent node binary (no PATH
  hijacking).
- `spawnSync` / `execFileSync` with argument arrays (no shell injection).
- JWT parsing rejects payloads larger than 16 KB.
- Zero telemetry. Zero monetization. Zero third-party services.

### Performance

- HTTP keepalive via undici Agent (measured ~50% speed improvement on
  sequential requests to the Codex backend).
- Token expiry cached in memory; account_id cached by auth-file mtime.

### Configurability

All upstream endpoints, OAuth client, auth path, model prefixes, virtual
models, reasoning thresholds, and debug/verbosity flags are configurable
via environment variables. See README § "Environment Variables".

### Known limitations

- **macOS only.** launchd + codesign + osascript bits are macOS-specific.
  Proxy and OAuth code are portable.
- **ChatGPT Plus/Pro required.** Codex backend is not accessible to free
  accounts.
- **Major Claude Code restructures** can break the adapter regex; running
  `gptcc diagnose` and submitting a PR to `PATTERNS` in
  `scripts/patch-claude.py` is usually enough to fix.
- **Picker labels** for Sonnet/Haiku may show the short name only in some
  Claude Code code paths; the 1M-context variant shows the full label.

### Migration from `gpt-bridge-cc`

If you were previously using `gpt-bridge-cc`, migrate with:

```bash
gpt-bridge uninstall             # cleanly revert the old install
npm uninstall -g gpt-bridge-cc
npm install -g gptcc
gptcc setup
```

Nothing is lost — the underlying OAuth auth at `~/.codex/auth.json` is
shared and will continue to work.
