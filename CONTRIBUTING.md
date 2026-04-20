# Contributing to gptcc

Thanks for wanting to contribute. This document covers development setup,
how the pieces fit together, and the things we will and won't accept.

---

> ### A quick note before you start
>
> gptcc is a small, non-commercial, personal-use tool. It uses only
> documented Claude Code extension points (`ANTHROPIC_BASE_URL`,
> `ANTHROPIC_CUSTOM_MODEL_OPTION`, plugin hooks) — no binary modification
> and no reverse engineering.
>
> By contributing, you agree that:
>
> - This tool stays non-commercial. PRs that add telemetry, tracking, or
>   monetization won't be accepted (see [Things we won't accept](#things-we-wont-accept)).
> - The installer's consent prompt stays in place (wording can be
>   refined; the step itself doesn't silently disappear).
> - Your contribution is licensed MIT, same as the rest of the project.
>
> If something feels borderline, open a draft PR or discussion and we'll
> talk it through.

---

## Table of Contents

- [Development Setup](#development-setup)
- [Project Layout](#project-layout)
- [Common contributions](#common-contributions)
- [Testing](#testing)
- [Debugging](#debugging)
- [Submitting Changes](#submitting-changes)
- [Code Style](#code-style)
- [Commit Message Convention](#commit-message-convention)
- [Release Process](#release-process)
- [Code of Conduct](#code-of-conduct)
- [Things we won't accept](#things-we-wont-accept)

---

## Development Setup

### Prerequisites

- Node.js 18+
- Claude Code installed (`claude` on PATH, or set `CLAUDE_BINARY`)
- ChatGPT Plus/Pro subscription (for runtime testing)
- macOS, Linux, or Windows

### Local install for development

```bash
cd gptcc
npm link              # registers the gptcc CLI globally pointing to this repo
gptcc setup           # runs setup using this working copy
```

After `npm link`, edits in this repo take effect immediately.

Unlink when done:

```bash
npm unlink -g gptcc
```

### Run proxy in foreground for debugging

```bash
node lib/proxy.mjs
# or
gptcc proxy
```

The proxy logs every request, tagged `[REQ]`, `[ROUTE]`, `[FAST]`, `[ERROR]`.

## Project Layout

```
gptcc/
├── bin/gptcc.mjs             # CLI entry — dispatches to lib/ commands
├── lib/
│   ├── login.mjs             # OAuth device code flow
│   ├── setup.mjs             # Cross-platform installer / uninstaller / status
│   ├── updater.mjs           # npm auto-update check (cached 24h)
│   └── proxy.mjs             # HTTP proxy (Anthropic ↔ OpenAI translation)
├── mcp/server.mjs            # MCP server (ask_gpt54, review_with_gpt54)
├── plugin/                   # Claude Code plugin
│   ├── .claude-plugin/
│   ├── hooks/
│   │   ├── hooks.json        # SessionStart hook
│   │   └── start-proxy.mjs   # cross-platform proxy starter
│   ├── agents/               # gpt-reviewer, gpt-bug, gpt-arch subagents
│   └── skills/gptcc-auto-delegate/ # Auto delegation rules + prompt templates
└── package.json
```

### Key files

1. **`lib/proxy.mjs`** — API translation. If Anthropic or OpenAI Responses
   API shape changes, the translation functions
   (`buildResponsesRequest`, `translateResponseSync`, `createStreamTranslator`)
   are the ones to update.

2. **`lib/setup.mjs`** — cross-platform installer. Writes
   `~/.claude/settings.json` entries, installs `proxy.mjs` under
   `~/.local/share/gptcc/`, and registers the plugin.

3. **`plugin/agents/*.md`** — GPT-backed subagents. Each defines a
   `model:` in its frontmatter so `Agent(subagent_type: ...)` runs on GPT.

4. **`plugin/hooks/start-proxy.mjs`** — invoked on each Claude Code
   session start to make sure the proxy is up. Cross-platform, Node only.

## Common contributions

### Add a new GPT subagent

1. Create `plugin/agents/<name>.md` with frontmatter:

   ```markdown
   ---
   description: <when Claude should delegate to this>
   model: gpt-5.4          # or gpt-5.4-fast, etc.
   tools: Read, Grep       # or other allowed tools
   color: blue
   effort: high
   ---

   <system prompt body>
   ```

2. Keep system prompts specific: role, non-goals, output schema.
3. Don't allow `Edit` / `Write` unless the subagent is genuinely meant to
   modify files.

### Proxy improvements

Areas that change over time:

- **Request translation** (`buildResponsesRequest`) — Anthropic messages
  → Responses API input items. Handles tool_use, tool_result, images.
- **Schema sanitization** (`sanitizeSchema`) — OpenAI rejects some JSON
  Schema constructs Anthropic allows (tuple-style `items`, certain
  `anyOf`/`oneOf` patterns).
- **Streaming translation** (`createStreamTranslator`) — Responses API
  SSE events → Anthropic SSE events with the correct
  `content_block_*` lifecycle.
- **System prompt optimization** (`optimizeSystemPrompt`) — strips Claude
  identity before forwarding to GPT.

Debugging streaming issues:

```bash
GPT_PROXY_PORT=52533 node lib/proxy.mjs
# In another terminal:
ANTHROPIC_BASE_URL=http://127.0.0.1:52533 claude --model gpt-5.4 "test prompt"
```

### Platform polish

gptcc aims to work the same on macOS, Linux, and Windows. Contributions
that tighten cross-platform behavior are welcome — particularly Windows
path handling and Linux systemd-style auto-start.

## Testing

This project does not currently have automated tests (contributions welcome).

Manual test checklist for any change:

**Setup flow:**
- [ ] `gptcc uninstall` cleans everything (safe on a fresh install too)
- [ ] `gptcc setup` completes all 5 steps
- [ ] `gptcc status` reports healthy

**Proxy:**
- [ ] Direct request to proxy: `curl -N http://127.0.0.1:52532/v1/messages -d '{"model":"gpt-5.4","stream":true,...}'`
- [ ] Claude models route through correctly: `claude --model claude-sonnet-4-6 "hi"`
- [ ] GPT models work: `claude --model gpt-5.4 "hi"` (after setup)

**Picker + plugin:**
- [ ] `/model` picker contains the GPT entry
- [ ] `Agent(subagent_type: "gpt-reviewer", prompt: "...")` runs on GPT
- [ ] Restarting Claude Code does not require manual proxy restart (the
      SessionStart hook brings it up)

## Debugging

### Proxy not starting

```bash
# Port already in use?
lsof -i :52532        # macOS / Linux
netstat -ano | findstr :52532   # Windows

# Run in foreground to see errors
gptcc proxy
```

### SessionStart hook not firing

```bash
claude plugin list
# If gptcc isn't listed:
claude plugin add /path/to/gptcc/plugin
```

### Auth expired / 401 from Codex

```bash
gptcc login
```

### Settings got out of sync

```bash
gptcc uninstall
gptcc setup
```

## Submitting Changes

### Before submitting a PR

- [ ] Changes work end-to-end (manual test checklist above)
- [ ] No new dependencies without discussion (we aim for low dep count)
- [ ] Updated README / CONTRIBUTING if behavior or layout changes
- [ ] Ran `node --check` on all .mjs files
- [ ] Commit message follows the convention below

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

- OS:
- Claude Code version:
- Node version:
```

## Code Style

- **JavaScript**: ES modules, no transpilation. `const` by default, `let`
  when reassigning. No TypeScript.
- **No new dependencies** without discussion. The CLI and proxy aim for
  zero runtime dependencies beyond Node built-ins. (The MCP server uses
  `@modelcontextprotocol/sdk`, which is fine.)
- **Comments**: only when the *why* is non-obvious.
- **Error handling**: at system boundaries only (user input, external
  APIs, file I/O). Don't wrap internal calls in try/catch without a
  specific failure mode to handle.

## Commit Message Convention

Loosely Conventional Commits:

```
<type>: <short summary>

[optional body explaining why]
```

Types: `feat`, `fix`, `proxy`, `plugin`, `docs`, `chore`, `refactor`,
`test`.

Examples:

```
proxy: handle empty tool_result.content from Claude Code 2.1.130

Some tool results arrive with content: [] under new sandbox rules.
Translate these to input_items with empty string content to avoid
"content cannot be empty" on the Responses API side.
```

```
plugin: add gpt-arch subagent for architecture second opinions
```

## Release Process

1. Update `version` in `package.json`, `mcp/server.mjs`, `lib/proxy.mjs`,
   `plugin/.claude-plugin/plugin.json`.
2. Update `CHANGELOG.md`.
3. Commit: `chore: release vX.Y.Z`.
4. Tag: `git tag vX.Y.Z`.
5. Push: `git push && git push --tags`.
6. Publish: `npm publish`.
7. `gh release create vX.Y.Z --generate-notes` (or use the CHANGELOG
   entry as the body).

Existing users auto-update on their next CLI invocation (24h cache).

## Code of Conduct

Be respectful. This is a small community project by volunteers. Assume
good intent. Harassment, personal attacks, and discriminatory behavior
will result in removal.

## Things we won't accept

- **Telemetry, analytics, usage tracking.** This tool stays zero-tracking.
- **Monetization hooks** — no paid tiers, license gating, ads, upsell paths.
- **Removing the consent prompt** in `lib/setup.mjs`. Wording can be
  refined; the acknowledgement step stays.
- **Binary modification.** gptcc 2.x deliberately uses only documented
  extension points. PRs that reintroduce binary patching or reverse
  engineering will be closed.
- **Framing the tool as an official Anthropic or OpenAI product.**
  Nominative fair use only — no third-party logos, no endorsement
  language.
- **Weakening the `127.0.0.1`-only proxy binding.** The proxy never gets
  exposed on a public interface.
- **Hardcoding credentials, API keys, or non-public OAuth client IDs.**

---

Thanks for contributing.
