# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.2.2] - Fix `missing_required_parameter` on login

v2.2.0/2.2.1 sent the wrong parameter set to `auth.openai.com/oauth/authorize`.
OpenAI's public Codex CLI client_id expects a very specific request shape;
missing any of the required fields triggers `missing_required_parameter`
on the consent page.

### Fixed

- `lib/login.mjs` authorize URL and device code request now match
  `openai/codex`'s `build_authorize_url()` exactly:
  - `scope` extended to
    `openid profile email offline_access api.connectors.read api.connectors.invoke`
  - Added `id_token_add_organizations=true`
  - Added `codex_cli_simplified_flow=true` (tells the server this is a
    CLI consent flow, not a web-app one)
  - Added `originator=codex_cli_rs` (overridable via `CODEX_ORIGINATOR`)
  - Removed `audience` (the public client_id doesn't accept it)

### Notes

These are OAuth protocol parameters that OpenAI requires for the public
Codex CLI `client_id` — they're not a User-Agent trick. Using the CLI's
`client_id` at all means speaking its parameter language. ChatGPT's
consent screen shows "Codex CLI" to the user, which is accurate: the
OAuth flow this app uses *is* Codex CLI's flow. OpenAI's docs state this
flow is supported for personal non-commercial use outside the Codex CLI.

## [2.2.1] - Cross-review follow-up

Parallel Claude + GPT review on v2.2.0 flagged three release-quality
issues. Both reviewers agreed on the XSS; GPT alone caught the broken
`callOpenAIAPI` paths (Claude missed them) — this is the
cross-review pattern doing its job.

### Fixed

- **`lib/login.mjs`: XSS sink on the failure page.** When the OAuth
  callback carried a crafted `error_description`, `FAILURE_HTML`
  interpolated it into the page without escaping. Localhost-only, but
  still a real XSS sink. Now HTML-escaped before interpolation.
- **`lib/proxy.mjs`: `OPENAI_API_KEY` fallback was completely broken.**
  - Non-streaming path called `translateResponseSync` with a 3-argument
    shape that doesn't exist (real signature is
    `(responsesRes, model)`).
  - Streaming path called `translator.feed()` and `translator.flush()`,
    neither of which exists on the translator returned by
    `createStreamTranslator` (real API is `processEvent` + `end`).
  - The fallback has never actually worked in production. Now mirrors
    `callCodexBackend` exactly, reusing the same SSE block parser and
    translator lifecycle.

### Changed

- README updated: login step now says "browser (Authorization Code +
  PKCE)" instead of "device-code flow"; `gptcc login --device` listed
  as the headless fallback; `lib/login.mjs` comment updated.

### Unfixed but acknowledged

- No automated test covers the new browser OAuth flow or the
  `OPENAI_API_KEY` fallback. Both regressions above would have been
  caught by even minimal integration tests. Test coverage for these
  paths is on the list for a follow-up release.

## [2.2.0] - Browser OAuth as the default; honest User-Agent

### Changed

- **Login now opens a browser by default** (Authorization Code flow with
  PKCE + localhost callback on `http://127.0.0.1:1455/auth/callback`),
  matching OpenAI's official Codex CLI. The user signs in through their
  normal ChatGPT browser session — no bot detection to circumvent.
- **Device Code flow is now opt-in**, via `gptcc login --device` or
  `gptcc setup --device`. Use on headless machines (SSH, Docker, CI).
- **User-Agent changed from `codex-cli/0.105.0` to `gptcc/2.2.0`.** v2.1.9
  sent a UA that impersonated the official Codex CLI to clear Cloudflare.
  Honest identification works too and is the right thing to do;
  impersonating another product's client was a short-term hack. A real
  UA still satisfies the WAF.

### Added

- `GPTCC_LOGIN_PORT` to override the localhost callback port (default
  `1455`).

### Fixed

- `gptcc login` produces a clean success page in the browser on callback,
  then auto-closes the transient local server. Failures return a specific
  error page explaining what went wrong.
- CSRF state validation on the callback.

### Migration from 2.1.x

Existing tokens in `~/.codex/auth.json` continue to work. Next login
goes through the browser. Force-reset:

```
gptcc login           # browser flow (default)
gptcc login --device  # device-code flow (headless)
```

## [2.1.9] - Fix Cloudflare 403 on OAuth endpoints

### Fixed

- **Login now gets past Cloudflare bot protection.** Node's fetch ships
  with User-Agent `undici`, which `auth.openai.com` returns 403 for
  (Cloudflare "Just a moment..." challenge). OpenAI's own Codex CLI has
  the same root cause tracked in `openai/codex#12859`. gptcc now sets
  `User-Agent: codex-cli/0.105.0` (override with `GPTCC_USER_AGENT`) on
  every OpenAI-side request:
  - `lib/login.mjs`: device code request + token polling
  - `lib/proxy.mjs`: refresh-token call, Codex backend, OpenAI API
    fallback

Visible symptom that's now fixed: `gptcc setup` died with
`Device code request failed (403): <!DOCTYPE html>...Just a moment...`.

## [2.1.8] - Setup auto-relogin + install banner

### Fixed

- **`gptcc setup` now detects expired tokens and re-logs in.** Before,
  setup only checked that `access_token` existed — an expired token
  would pass and setup "completed" even though every subsequent API
  call would 401. The fix JWT-parses the token, checks `exp`, and if
  expired (or within 5 minutes) it triggers the normal OAuth flow
  automatically. `--force-login` still works too.
- The login step now prints how long the current token is valid for
  (`Already logged in (27d 4h left).`) so users can see at a glance
  whether they need to refresh.

### Added

- **`npm install -g gptcc` now prints a next-step banner** pointing at
  `gptcc setup` and `gptcc hello`. Only fires on interactive, global
  installs — silent on CI, Docker, local deps, sudo-root, or when
  `GPTCC_SKIP_POSTINSTALL=1` is set.

### Upgrade

`gptcc setup` auto-updates (from 2.1.4+) and picks up the new login
check on the next run.

## [2.1.7] - Zombie log cleanup + doctor path fix

### Fixed

- **Windows: zombie startup log now auto-cleaned on every setup.** If a
  previous failed setup left a zombie `cmd` handle holding
  `proxy-startup.log`, the next `gptcc setup` would hit the same EBUSY
  and fail in the same way forever. Setup now attempts to `unlink` the
  log at the start of each run.
- **`gptcc doctor` finds Claude Code on Windows.** Previously hardcoded
  `AppData/Local/claude-code/claude.exe` — but npm installs Claude Code
  under `~/.local/bin/claude.exe` on most setups. Doctor now searches
  `~/.local/bin/claude.exe`, `~/.local/bin/claude`, the old AppData path,
  and the npm global prefix `%APPDATA%\npm\claude.cmd`, in that order.
- Doctor's layer 5 (plugin list) gracefully skips when the binary
  wasn't found, instead of crashing on an undefined binary path.

### Recovery for existing stuck installs

If v2.1.6 left you with a locked log, upgrade + manual cleanup:

```
npm install -g gptcc@latest
del "%USERPROFILE%\.local\share\gptcc\proxy-startup.log"
gptcc login        (if token expired)
gptcc setup
```

A reboot also clears any zombie handle. From v2.1.7 onward, setup
handles this automatically.

## [2.1.6] - Windows log file lock fix

v2.1.5 added a startup log so Windows proxy failures would be visible.
The log itself then became the failure: setup opened a file handle to
`proxy-startup.log` via `openSync(..., "a")` and passed it through
`stdio`, while the generated `.cmd` wrapper **also** redirected
`>>proxy-startup.log 2>&1`. Windows rejects the second append open
with "cannot access the file because it is being used by another
process", so the wrapper exited immediately without spawning the
proxy — visible as the Korean CP949 error message in the log.

### Fixed

- `gptcc setup` (Windows) no longer opens the startup-log file handle
  itself. The generated `start-proxy.cmd` owns the log exclusively,
  so the redirect succeeds and the proxy actually launches.
- SessionStart hook applies the same fix.
- `start-proxy.cmd` now calls `chcp 65001` so any future error output
  lands as UTF-8 in the log, not locale-dependent mojibake.

### Upgrade

On v2.1.4+: `gptcc setup` auto-updates to 2.1.6 and re-executes. No
manual step.

## [2.1.5] - Windows spawn via .cmd wrapper + startup log

v2.1.3's Windows fix (inline `start "" /B` via `spawn({shell: true})`) still
failed in the field — reported as "proxy didn't start" + empty `netstat`.
Root cause: Node spawn quote/escape across the shell+cmd boundary is
brittle when the Node binary path contains spaces (e.g.
`C:\Program Files\nodejs\node.exe`), and stdio was `ignore`, so the real
error was silently dropped.

### Fixed

- Windows `gptcc setup` now launches the proxy by executing the already-
  generated `start-proxy.cmd` wrapper (plain cmd syntax, no JavaScript
  quote nesting) instead of building an inline cmd string. The wrapper
  uses `start "" /B`, appends `exit /b 0`, and logs any real proxy
  startup errors to `%LOCALAPPDATA%\...\gptcc\proxy-startup.log` (under
  the gptcc install dir).
- Setup now reads that log back if the proxy fails to come up within
  30 s and prints the tail to the user — no more silent "didn't start"
  warnings.
- Plugin SessionStart hook uses the same wrapper path.
- `gptcc doctor` shows the last 10 lines of the startup log when the
  proxy isn't responding, pointing directly at the failing line.

### Migration

`gptcc hello` on v2.1.4 or earlier should auto-update (2.1.4 pulled
troubleshooting commands into the update check). If you're on <=2.1.3,
one manual `npm install -g gptcc@latest` then `gptcc setup`.

## [2.1.4] - Auto-update now covers troubleshooting commands

### Fixed

- **`gptcc setup`, `hello`, `doctor`, `status`, `login` now auto-update.**
  Previously these were in `SKIP_UPDATE_FOR`, which made sense on paper
  (offline setup, fast status) but caused a real problem in practice:
  users on an older version would re-run `gptcc setup` or
  `gptcc doctor` to troubleshoot, and stay pinned to the stale version
  even though the fix was already on npm. Now only `help`, `uninstall`,
  and `proxy` skip the update check (they genuinely need to work offline
  or exit instantly). The other troubleshooting commands pick up the
  latest release automatically.

When an update is available, the CLI prints `Updating gptcc: X → Y...`,
runs `npm install -g gptcc@latest`, then re-execs your original command
with `stdio: "inherit"` (TTY preserved for `setup`'s OAuth prompt).

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
