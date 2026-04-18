# Contributing to GPT for Claude Code

Thanks for wanting to contribute! This document covers how to set up a development environment, the most common contribution scenarios, and how to submit changes.

---

> ### A quick note before you start
>
> This is a small community interoperability tool for personal development
> environments. Before contributing, please skim the
> [README FAQ](./README.md#faq) and [TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md)
> so we're on the same page about what the project is and isn't.
>
> By contributing, you agree that:
>
> - This is a **non-commercial, personal-use tool**. PRs that would add
>   telemetry, tracking, or monetization won't be accepted (see
>   [Things We Won't Accept](#things-we-wont-accept) below).
> - Patcher changes must continue to run only on the end-user's own
>   machine — we never ship a pre-patched binary.
> - The installer's consent prompt must stay in place (we can soften the
>   wording, but it doesn't silently disappear).
> - Your contribution is licensed MIT, same as the rest of the project.
>
> If something feels borderline, open a draft PR or discussion and we'll
> talk it through.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Layout](#project-layout)
- [Common Contribution Scenarios](#common-contribution-scenarios)
  - [Fixing the Patch Script After a Claude Code Update](#fixing-the-patch-script-after-a-claude-code-update)
  - [Adding a New Model](#adding-a-new-model)
  - [Improving the Proxy](#improving-the-proxy)
  - [Adding Linux/Windows Support](#adding-linuxwindows-support)
- [Testing](#testing)
- [Debugging](#debugging)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Commit Message Convention](#commit-message-convention)
- [Release Process](#release-process)
- [Code of Conduct](#code-of-conduct)
- [Things We Won't Accept](#things-we-wont-accept)

---

## Development Setup

### Prerequisites

- Node.js 18+
- Python 3.8+
- Claude Code installed at `~/.local/bin/claude`
- ChatGPT Plus/Pro subscription (for runtime testing)
- macOS (for full testing; proxy and patcher can be partly tested on Linux)

### Local install for development

```bash
# After cloning:
cd gptcc
npm link                    # registers the gptcc CLI globally, pointing to this repo
gptcc setup            # runs setup using this working copy
```

After `npm link`, edits to files in this repo take effect immediately — no reinstall needed.

To unlink when done:

```bash
npm unlink -g gptcc
```

### Run proxy in foreground for debugging

```bash
node lib/proxy.mjs
# Or through the CLI:
gptcc proxy
```

The proxy logs every request and includes `[ROUTE]`, `[FAST]`, and `[ERROR]` tags.

## Project Layout

```
gptcc/
├── bin/gptcc.mjs         # CLI entry — dispatches to lib/ commands
├── lib/
│   ├── login.mjs              # OAuth device code flow
│   ├── setup.mjs              # One-touch install, uninstall, status
│   ├── updater.mjs            # npm auto-update check (cached 24h)
│   └── proxy.mjs              # HTTP proxy (Anthropic ↔ OpenAI translation)
├── scripts/
│   ├── patch-claude.py        # Binary patcher
│   └── autopatch.sh           # launchd watcher handler
├── mcp/server.mjs             # MCP server with ask_gpt54 tool
├── plugin/                    # Claude Code plugin (hooks + skills)
└── package.json
```

### Critical files to understand

1. **`scripts/patch-claude.py`** — the most fragile component. Breaks on Claude Code updates. Understand the `PATTERNS` dict and the byte balancing logic in `apply_all()`.

2. **`lib/proxy.mjs`** — API translation layer. If the Anthropic or OpenAI Responses API changes shape, translation functions (`buildResponsesRequest`, `translateResponseSync`, `createStreamTranslator`) need updates.

3. **`lib/setup.mjs`** — installs scripts to `~/.local/share/gptcc/` (NOT `~/Desktop/...` — macOS quarantine blocks launchd from executing scripts in Desktop). Sets up launchd plists.

## Common Contribution Scenarios

### Fixing the Patch Script After a Claude Code Update

**When it happens:** Every Claude Code update potentially wipes the patch. Most minor updates are handled automatically by the auto-patch watcher. Major updates (internal restructures) may break pattern matching.

**Symptoms:**
- `gptcc diagnose` shows `FAIL` for one or more patterns
- `~/Library/Logs/gptcc-patch.log` shows "Patch failed"

**Workflow:**

1. Run diagnostics:
   ```bash
   gptcc diagnose
   ```
   Output shows each pattern and partial matches (with binary context) when they fail.

2. Explore the new binary:
   ```bash
   python3 -c "
   data = open('/Users/\$USER/.local/bin/claude', 'rb').read()
   # Search for patterns related to the failed match
   import re
   for m in re.finditer(rb'YOUR_NEW_PROBE', data):
       print(data[m.start():m.start()+200].decode('utf-8', errors='replace'))
   "
   ```

3. Update `PATTERNS` in `scripts/patch-claude.py`. Key rules:
   - Use **structural** regex, not exact names (Claude Code uses a minifier so `Da1`, `e17`, etc. change every release).
   - Support `$` in variable names (newer minifier output uses `$85`, `l$7`, etc.) — use `[\w\$]+` rather than `\w+`.
   - Keep patterns tight enough to match only the intended site. `picker_return_vz` initially matched too broadly (16 matches instead of 2) — we narrowed it.

4. Verify with diagnose, then test-apply:
   ```bash
   gptcc diagnose    # all patterns OK?
   gptcc patch       # actually apply
   claude --version       # binary still runs?
   ```

5. Restart Claude Code and check `/model` picker.

**Example from v2.0 → v2.1 update:**

Claude Code 2.1.114 changed several things:
- Variable names can now contain `$` (`Da1` → `$85`, `e17` → `l$7`)
- Absorber function added a third `.includes("opus-4-7")` check
- Minifier-chosen function identifiers changed (`Ja1` → `z85`, `BJ` → `A2`, `m06` → `Lo`)

Fix was entirely in `PATTERNS` regex — adding `[\w\$]+` for identifiers and making the `opus-4-7` check optional:

```python
"context_absorber": {
    "regex": rb'function\s+([\w\$]{1,6})\((\w)\)...'
             rb'\4\.includes\("claude-sonnet-4"\)\|\|\4\.includes\("opus-4-6"\)'
             rb'(?:\|\|\4\.includes\("opus-4-7"\))?\}',  # <-- new optional
}
```

**When regex changes aren't enough:**

If Claude Code restructures entirely (e.g., model definitions become array literals instead of variable assignments, or the patcher has to inject into a completely new code path), the `apply_all()` function logic needs updating, not just patterns.

### Adding a New Model

1. Add to `OPENAI_MODELS` list (if desired, for `/health` endpoint) in `lib/proxy.mjs`.
2. Add to `gptModels` list in `lib/setup.mjs` so it ends up in `availableModels`.
3. Update `isOpenAIModel()` if the model prefix is not `gpt-`/`o1`/`o3`/`o4`.
4. If it's a "virtual" model (same underlying model with different tier, like `gpt-5.4-fast`), update `resolveModel()`.

For binary picker display, the patch script injects two models (`gpt-5.4`, `gpt-5.4-fast`) by default. To change this, update `INJECT_MODELS` env var or the default in `patch-claude.py`:

```bash
GPT_MODELS="gpt-5.4,gpt-5.4-fast,gpt-5.4-mini" gptcc patch
```

### Improving the Proxy

The proxy translates between two streaming APIs with subtle differences. Key areas:

- **Request translation** (`buildResponsesRequest`) — Anthropic messages → Responses API input items. Handles tool_use, tool_result, images.
- **Schema sanitization** (`sanitizeSchema`) — OpenAI rejects some JSON Schema constructs Anthropic allows (tuple-style `items`, certain `anyOf`/`oneOf` patterns).
- **Streaming translation** (`createStreamTranslator`) — the trickiest part. Responses API SSE events → Anthropic SSE events with correct `content_block_*` lifecycle.
- **System prompt optimization** (`optimizeSystemPrompt`) — strips Claude identity and meta-instructions before forwarding to GPT.

When debugging streaming issues:

```bash
# Run proxy in foreground with request/response logging
GPT_PROXY_PORT=52533 node lib/proxy.mjs
# In another terminal, test
ANTHROPIC_BASE_URL=http://127.0.0.1:52533 claude --model gpt-5.4 "test prompt"
```

### Adding Linux/Windows Support

Platform-specific parts to replace:

| Component | macOS | Linux | Windows |
|---|---|---|---|
| Auto-start | launchd plist | systemd user unit | Task Scheduler / startup folder |
| Binary change watcher | launchd `WatchPaths` | inotifywait | ReadDirectoryChangesW |
| Codesign after patch | `codesign --sign -` | Not needed | Authenticode (may need to skip) |
| Notifications | osascript | notify-send | toast / BurntToast |
| Browser open | `open` | `xdg-open` | `start` / PowerShell |

The proxy (`lib/proxy.mjs`) and OAuth flow (`lib/login.mjs`) are already cross-platform. The binary patcher (`scripts/patch-claude.py`) works on any OS as long as the Claude Code binary is accessible (currently macOS Mach-O; Linux ELF may need different handling around codesign).

To contribute a platform port:

1. Add platform detection in `lib/setup.mjs`:
   ```js
   import { platform } from "os";
   const PLATFORM = platform(); // "darwin" | "linux" | "win32"
   ```
2. Extract macOS-specific parts of `setup()`, `uninstall()`, and `status()` into separate files or conditionals.
3. Implement equivalents for target platform.
4. Update README prerequisites.

## Testing

This project does not currently have automated tests (contributions welcome).

Manual test checklist for any change:

**Setup flow:**
- [ ] `gptcc uninstall` cleans everything
- [ ] `gptcc setup` completes all 7 steps
- [ ] `gptcc status` reports healthy

**Proxy:**
- [ ] Direct request to proxy returns valid SSE: `curl -N http://127.0.0.1:52532/v1/messages -d '{"model":"gpt-5.4","stream":true,...}'`
- [ ] Claude models route through correctly: `claude --model claude-sonnet-4-5-20250929 "hi"`
- [ ] GPT models work: `claude --model gpt-5.4 "hi"`

**Binary patch:**
- [ ] `gptcc diagnose` shows all OK
- [ ] `gptcc patch` applies cleanly with `Total byte change: 0`
- [ ] Claude Code starts after patch: `claude --version`
- [ ] `/model` picker shows GPT models
- [ ] `Agent(model: "gpt-5.4-fast")` passes enum validation

**Auto-patch:**
- [ ] Manually trigger by touching the binary: `touch ~/.local/bin/claude`
- [ ] Check log: `tail -f ~/Library/Logs/gptcc-patch.log`

## Debugging

### Proxy not responding

```bash
lsof -i :52532                           # who's listening?
curl -v http://127.0.0.1:52532/health    # is it our proxy?
tail -f ~/Library/Logs/gpt-proxy.log     # logs
launchctl list | grep gptcc         # launchd status
```

### Auto-patch not running on Claude Code update

```bash
# Is the watcher loaded?
launchctl list | grep gptcc.watcher

# Check log
tail -f ~/Library/Logs/gptcc-patch.log

# Common cause: script has com.apple.provenance attribute and launchd refuses to run it
xattr ~/.local/share/gptcc/scripts/autopatch.sh
# If present: xattr -d com.apple.provenance ~/.local/share/gptcc/scripts/autopatch.sh
```

### Binary corrupted after patch

```bash
# Restore immediately
gptcc patch --restore

# Or directly
python3 ~/.local/share/gptcc/scripts/patch-claude.py --restore

# Or manually from backup
cp ~/.local/bin/claude.backup ~/.local/bin/claude
codesign --force --sign - ~/.local/bin/claude
```

### Patch regex returns unexpected matches

Run diagnostics and carefully read the partial-match output. Tighten the regex by anchoring to structural neighbors (e.g., require `if(...)return!1` before the target, or require `.push(VAR)` after). Test with:

```bash
python3 scripts/patch-claude.py --diagnose
```

## Submitting Changes

### Before submitting a PR

- [ ] Changes work end-to-end (manual test checklist above)
- [ ] No new dependencies without discussion (we aim to stay zero-dependency)
- [ ] Updated README / CONTRIBUTING if behavior changes
- [ ] Ran `node --check` on all .mjs files, `python3 -m py_compile` on .py
- [ ] Commit message follows convention (below)

### PR description template

```markdown
## What this PR changes

...

## Why

...

## How to test

1. ...
2. ...

## Tested on

- macOS version:
- Claude Code version:
- Node version:
```

## Code Style

- **JavaScript**: ES modules, no transpilation. Use `const` by default, `let` when reassigning. No TypeScript.
- **Python**: Standard library only. Python 3.8+ compatible (though we target 3.11+).
- **No new dependencies** without discussion. Zero-dep is a design goal for the CLI and proxy. (The MCP server depends on `@modelcontextprotocol/sdk`, which is fine.)
- **Comments**: Only when the "why" is non-obvious. Code should be readable without them.
- **Error handling**: At system boundaries only (user input, external APIs, file I/O). Don't wrap internal calls in try/catch without a specific failure mode to handle.

## Commit Message Convention

Loosely Conventional Commits:

```
<type>: <short summary>

[optional body explaining why]

[optional footer: breaking changes, refs, etc.]
```

Types: `feat`, `fix`, `patch` (binary patcher changes), `proxy` (proxy changes), `docs`, `chore`, `refactor`, `test`.

Examples:

```
patch: support $-prefixed variable names (Claude Code 2.1.114)

Minifier output in recent Claude Code versions produces identifiers like
$85 and l$7. Updated regex patterns to accept [\w\$]+ instead of \w+.
```

```
proxy: strip Billed-as-extra-usage from Sonnet 1M description

Reduces verbosity in /model picker display.
```

## Release Process

1. Update `version` in `package.json`.
2. Update CHANGELOG (if present).
3. Commit: `chore: release vX.Y.Z`
4. Tag: `git tag vX.Y.Z`
5. Push: `git push && git push --tags`
6. Publish: `npm publish`

Users with `gptcc` installed will auto-update on their next CLI invocation (cached 24h).

## Code of Conduct

Be respectful. This is a small community project by volunteers. Assume good intent.

Harassment, personal attacks, and discriminatory behavior will result in removal from the project.

## Things We Won't Accept

A short list so you don't waste time writing a PR that won't land. Not
because the thought isn't appreciated — these just move the project in
directions we don't want to go.

- **Telemetry, analytics, usage tracking** of any kind. This tool stays
  zero-tracking.
- **Monetization hooks** — no paid tiers, license gating, ads, or upsell
  paths. Non-commercial by design.
- **Removing the consent prompt** in `lib/setup.mjs`. Wording can be
  refined; the acknowledgement step stays.
- **Redistributing a pre-patched Claude Code binary.** The patcher only
  operates on a binary already present on the end user's machine.
- **Removing or weakening the takedown policy.** See
  [TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md).
- **Framing the tool as an official Anthropic or OpenAI product.**
  Nominative fair use only — no third-party logos or endorsement language.
- **Weakening the `127.0.0.1`-only proxy binding.** The proxy never gets
  exposed on a public interface.
- **Hardcoding credentials, API keys, or non-public OAuth client IDs.**

---

Thanks for contributing!
