# GPT for Claude Code

![License](https://img.shields.io/badge/license-MIT-blue)
![Scope](https://img.shields.io/badge/scope-personal_research-lightblue)
![Uninstall](https://img.shields.io/badge/uninstall-one_command-brightgreen)

Use **OpenAI GPT** and **Claude** models side-by-side inside [Claude Code](https://claude.com/claude-code), with the same conversation context and CLI. No API key required — authenticates via your existing ChatGPT (Plus/Pro) subscription through OAuth.

```bash
npm install -g gptcc
gptcc setup
```

```bash
# Use GPT models directly:
claude --model gpt-5.4
claude --model gpt-5.4-fast

# Or delegate tasks from Claude → GPT:
Agent(model: "gpt-5.4-fast", prompt: "...")
```

> ### ℹ️ About this project
>
> GPT for Claude Code is a **community interoperability tool for personal development
> environments**. It works by locally adapting a copy of Claude Code on your
> own machine — no modified binaries are redistributed, and the change is
> fully reversible with `gptcc uninstall` (backups are always preserved).
>
> Claude Code doesn't officially support third-party models yet. If and when
> Anthropic adds a public provider API, we'll happily deprecate this tool in
> favor of it. Until then, this lets individual developers experiment with
> multi-model workflows without losing the Claude Code experience they're
> used to.
>
> Best for individual developers. **Not designed for enterprise or
> compliance-sensitive environments** — if your organization has a software
> modification policy, this tool is not for you.
>
> For the full picture, see [FAQ: Is this against Anthropic's ToS?](#faq)
> and [TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md).

---

## Table of Contents

- [What This Is (And What It Isn't)](#what-this-is-and-what-it-isnt)
- [When It's Useful](#when-its-useful)
- [When It Isn't](#when-it-isnt)
- [How It Works](#how-it-works)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Usage](#usage)
- [Available Models](#available-models)
- [CLI Commands](#cli-commands)
- [Environment Variables](#environment-variables)
- [Auto-Update Behavior](#auto-update-behavior)
- [Architecture](#architecture)
- [Security](#security)
- [Troubleshooting](#troubleshooting)
- [Known Limitations](#known-limitations)
- [Uninstall](#uninstall)
- [Contributing](#contributing)
- [FAQ](#faq)
- [License](#license)

---

## What This Is (And What It Isn't)

**What it is:**
A workflow tool that lets you use GPT and Claude models through the same CLI,
with the same conversation context for Claude tasks and clean delegation to GPT
for independent work.

**What it isn't:**
- **Not a performance upgrade.** GPT through this bridge is not faster or "better"
  than GPT through the Codex CLI for pure GPT work. It's the *integration* that's
  the product.
- **Not a replacement for Codex CLI.** If you want pure GPT coding sessions with
  GPT's native tooling, use Codex CLI directly.
- **Not an API optimization.** This is a proxy that adds a small amount of latency
  (~1ms internal, plus normal network). Direct API calls are always faster.

The real value: **you keep using Claude Code** (the tool you already have configured,
with your plugins, skills, and conversation history), and you gain the ability to
delegate specific tasks to GPT when an independent perspective or specialized
capability helps.

## When It's Useful

1. **Cross-review for non-trivial code.** After Claude makes a change, have GPT
   review it independently. The two models have different training and catch
   different issues. This is the single highest-value use case.

2. **Second opinion on architecture.** When there's no clearly right answer,
   hearing a differently-trained model's reasoning helps.

3. **Parallel exploration.** Split investigation into independent paths, run
   Claude and GPT in parallel, compare.

4. **Spec-driven generation.** When you have a precise spec and no conversation
   context is needed, GPT can generate the module while Claude keeps the main
   session clean.

5. **Using specific GPT strengths.** Some tasks (certain math, specific coding
   patterns) are areas where GPT outperforms Claude in ways that matter for you.

## When It Isn't

Delegation has real costs — context handoff, coordination, output verification.
It loses more than it gains for:

- **Ongoing multi-turn conversation** — GPT loses all context; you'll spend more
  time re-explaining than the delegation saves.
- **Small edits** — overhead exceeds the work.
- **UI / Figma / visual judgment** — Claude has Figma integration; GPT doesn't.
- **Environment / config / local state** — needs the main conversation's awareness.
- **Iterative debugging within a session** — same as multi-turn; keep it in Claude.

A well-designed multi-model workflow delegates ~10-20% of tasks, not more.

## How It Works

```
┌─────────────────┐
│   Claude Code   │
│  (Opus / etc.)  │
└────────┬────────┘
         │ Anthropic Messages API
         │ ANTHROPIC_BASE_URL=http://127.0.0.1:52532
         ▼
┌─────────────────────────────────────────┐
│   GPT for Claude Code Proxy (local, 127.0.0.1)   │
│                                         │
│   Route by model name:                  │
│   ├─ claude-* → Anthropic API (pass)    │
│   └─ gpt-*, o* → Codex backend          │
│      (with Claude→GPT prompt rewrite)   │
└────────┬─────────────────┬──────────────┘
         │                 │
         ▼                 ▼
  api.anthropic.com    chatgpt.com/backend-api/codex
                       (OAuth, ChatGPT subscription)
```

Two components:

1. **Proxy** (`lib/proxy.mjs`) — translates Anthropic Messages API ↔ OpenAI
   Responses API. Also rewrites Claude-specific system prompts into
   GPT-optimized ones (stripping Claude identity and meta-instructions, keeping
   only the user's CLAUDE.md content).

2. **Binary patch** (`scripts/patch-claude.py`) — modifies the Claude Code
   binary so GPT models appear in the `/model` picker and work in the `Agent`
   tool's enum. Uses structural regex to adapt to Claude Code minifier renames
   between releases. Byte-length-neutral (space-padded).

## Prerequisites

- **macOS** (currently macOS-only; Linux/Windows support welcome via PR)
- **Node.js 18+**
- **Python 3.8+**
- **Claude Code** installed (default path: `~/.local/bin/claude`)
- **ChatGPT Plus or Pro** subscription (Codex backend requires paid ChatGPT)

## Installation

```bash
npm install -g gptcc
gptcc setup
```

`setup` handles everything:

1. ChatGPT login via OAuth device-code flow
2. Configure Claude Code settings
3. Patch the binary to accept GPT models
4. Start the proxy (auto-verifies `/health` before committing `ANTHROPIC_BASE_URL`)
5. Install launchd agents for auto-start and auto-repatch
6. Register the Claude Code plugin (orchestration skill + hook)

Verify:

```bash
gptcc status
```

Expect:

```
  Proxy:     running (port 52532)
  Auth:      valid (expires YYYY-MM-DD)
  Patch:     applied
  Settings:  URL=OK Models=OK
```

## Usage

### Direct model selection

```bash
claude --model gpt-5.4          # GPT-5.4
claude --model gpt-5.4-fast     # GPT-5.4 on priority tier (faster, 2x credits)
```

### In-session model picker

Type `/model` in Claude Code.

### Delegation

Keep Opus or Sonnet as main. Delegate specific work to GPT via the Agent tool:

```
Agent(model: "gpt-5.4-fast", prompt: "
## Task
Independent code review — flag real issues, skip style nits.

## Intent
This middleware validates JWT tokens and sets req.user.

## Code
[paste diff or file]

## Output format
- [severity: critical|high|medium|low] file:line
  Problem: ...
  Evidence: ...
  Fix: ...
")
```

The installed orchestration skill contains full templates for code generation,
review, bug analysis, and architecture second-opinion prompts — see
`plugin/skills/orchestration/SKILL.md`.

### Cross-review (most valuable use case)

After a non-trivial change, run Claude and GPT reviews in parallel:

```
Agent(subagent_type: "superpowers:code-reviewer", prompt: "Review <files>...")
Agent(model: "gpt-5.4-fast", prompt: "<independent review template>")
```

Compare findings. Common issues → fix. One-sided flags → verify.

## Available Models

| Model | Notes |
|---|---|
| `gpt-5.4` | Flagship, 1M context, reasoning support |
| `gpt-5.4-fast` | Same model, priority tier (1.5x speed, 2x credits) |
| `gpt-5.4-mini` | Lightweight |
| `gpt-5.3-codex` | Coding-specialized |
| `gpt-5.3-codex-spark` | Real-time coding iteration |
| `gpt-5.2` | Previous generation |

## CLI Commands

```
gptcc setup       One-touch install
gptcc login       (Re)login to ChatGPT
gptcc patch       Re-apply binary patch manually
gptcc diagnose    Show which patch patterns match/fail
gptcc status      Show proxy / auth / patch / settings status
gptcc proxy       Run proxy in foreground (debug)
gptcc uninstall   Remove everything
gptcc help        Show help
```

## Environment Variables

**Basic:**
- `GPT_PROXY_PORT` (default: `52532`)
- `GPTCC_NO_UPDATE=1` — disable auto-update check
- `GPTCC_DEBUG=1` — verbose logging (unknown SSE events, undici status)
- `CLAUDE_BINARY` — path to Claude Code binary
- `GPT_MODELS` — comma-separated models to inject into picker

**API endpoints** (for testing / future API changes):
- `ANTHROPIC_API_ENDPOINT` (default: `https://api.anthropic.com`)
- `CODEX_API_ENDPOINT` (default: `https://chatgpt.com/backend-api/codex`)
- `OPENAI_TOKEN_ENDPOINT` (default: `https://auth.openai.com/oauth/token`)
- `CODEX_AUTH_PATH` (default: `~/.codex/auth.json`)
- `CODEX_CLIENT_ID` (default: public Codex CLI ID)

**Model configuration:**
- `OPENAI_MODEL_PREFIXES` — extra prefixes to recognize as OpenAI (comma-separated)
- `OPENAI_VIRTUAL_MODELS` — JSON: `{"alias": {"actual": "gpt-5.4", "fast": true}}`

**Reasoning effort mapping** (Claude `budget_tokens` → GPT effort):
- `REASONING_LOW_MAX` (default: `2000`)
- `REASONING_MEDIUM_MAX` (default: `8000`)
- `REASONING_HIGH_MAX` (default: `20000`)

## Auto-Update Behavior

Two independent update mechanisms:

### 1. gptcc self-update

On most CLI invocations, `gptcc` checks npm for a newer version (24h cached).
New version → auto-installed, command re-runs.

Skipped for: `setup`, `login`, `uninstall`, `status`, `diagnose`, `help`
(these need to work offline).

Disable globally with `GPTCC_NO_UPDATE=1`.

### 2. Claude Code update handler

launchd watches `~/.local/bin/claude`. When it changes:

```
Claude Code update detected
  ↓
autopatch.sh
  ├─ Try re-apply with current gptcc → notify "patched"
  └─ Fail → npm install -g gptcc@latest → retry
      ├─ Succeed → notify "updated to X.Y.Z + patched"
      └─ Fail → notify "Run: gptcc diagnose"
```

## Architecture

```
gptcc/
├── bin/gptcc.mjs         # CLI entry
├── lib/
│   ├── login.mjs              # OAuth device code flow
│   ├── setup.mjs              # One-touch installer
│   ├── updater.mjs            # npm auto-update (24h cached)
│   └── proxy.mjs              # HTTP proxy (Anthropic ↔ OpenAI translation)
├── scripts/
│   ├── patch-claude.py        # Binary patcher
│   └── autopatch.sh           # launchd handler
├── mcp/server.mjs             # MCP server (ask_gpt54, review_with_gpt54)
├── plugin/                    # Claude Code plugin
│   ├── .claude-plugin/
│   ├── hooks/hooks.json       # SessionStart hook
│   └── skills/orchestration/  # Prompt templates + delegation rules
└── package.json
```

### How the proxy handles prompts

Claude Code's system prompt is long (5-10 KB) and contains Claude-specific
identity, workflow rules, and tone guidance. Forwarding this to GPT produces
worse output than a clean prompt — GPT isn't Claude and shouldn't follow
Claude's tone rules.

When a request targets a GPT model, the proxy:

1. Detects if the system prompt is Claude Code's main prompt (not a subagent)
2. Extracts only the user's content (CLAUDE.md section)
3. Composes a minimal GPT system prompt: role + tool policy + user instructions
4. Discards Claude identity, workflow rules, tone guidance

Subagent system prompts (from `Agent(...)`) are passed through as-is since they're
already task-specific.

### Binary patch details

Uses **structural regex** (not exact-name matching) so the patcher adapts to
minifier renames between Claude Code releases. Patterns:

- `model_defs` — sonnet/haiku variable definitions (supports `$`-prefixed names)
- `agent_enum` — `.enum([...])` for the Agent tool's model validation
- `context_1m` — 1M-context detection function (extended to recognize GPT models)
- `context_absorber` / `model_check_3way` — nearby functions shortened for byte-balancing
- `picker_return_*` — picker branches needing GPT model injection

All patches are byte-length-neutral (space padding). Binary size verified
unchanged before writing. Patched binary re-signed with ad-hoc signature.

## Security

Core properties:

- Proxy binds to `127.0.0.1` only (never exposed on a public interface)
- OAuth tokens in `~/.codex/auth.json` with `0o600` permissions
- Auth file written atomically to prevent corruption
- Anthropic passthrough restricted to `/v1/*` paths (SSRF prevention)
- OAuth Client ID is the same public Codex CLI ID used by OpenAI's open-source `codex` tool
- Zero telemetry, zero third-party services, zero monetization

What this tool does not do:

- Modify behavior for Claude models (pure passthrough when you pick a Claude model)
- Send anything beyond the proxied API calls
- Retain or log request contents
- Redistribute modified Claude Code binaries
- Collect or transmit user data to any third party

For the full security policy and threat model, see [SECURITY.md](./SECURITY.md).

## Troubleshooting

### Proxy not starting
```bash
tail -f ~/Library/Logs/gpt-proxy.log
```

### "Codex backend error" or 401
OAuth expired. Re-login:
```bash
gptcc login
```

### GPT models missing from `/model` after a Claude Code update
Binary patch was wiped. Auto-patch should run automatically; check log:
```bash
tail -f ~/Library/Logs/gptcc-patch.log
```

If auto-patch fails, run diagnostics:
```bash
gptcc diagnose
```

This shows which patterns matched and which failed, with partial-match context
to help you (or the maintainers) fix the patch regex.

### Agent tool: "Invalid option: expected one of sonnet|opus|haiku"
The session was started before the binary was patched. Restart Claude Code.

### Claude Code won't launch
Restore the original binary:
```bash
python3 ~/.local/share/gptcc/scripts/patch-claude.py --restore
```

## Known Limitations

- **Claude Code updates wipe the patch.** Auto-patch catches most minor updates.
  Major internal restructures require patch-script updates.
- **macOS only** for now. Proxy/OAuth code is portable; setup scripts aren't.
- **Sonnet/Haiku picker labels don't always show version numbers** (e.g. "Sonnet"
  instead of "Sonnet 4.6"). Depends on which internal code path Claude Code
  chooses for your account. Functionality is unaffected.
- **ChatGPT Free accounts don't work.** Codex backend requires paid ChatGPT.
- **No OpenAI API key support.** This routes through the Codex backend
  (ChatGPT OAuth). Direct `api.openai.com` support would require a separate
  code path.

## Uninstall

**One command. Restores everything. Safe to run any time.**

```bash
gptcc uninstall
npm uninstall -g gptcc
```

Restores:

- **Claude Code binary** — reinstated from the backup saved before the first
  patch (`~/.local/bin/claude.backup`). Original bytes, original signature
  path, original behavior.
- **Claude Code settings** — `ANTHROPIC_BASE_URL` env entry and `availableModels`
  GPT entries removed from `~/.claude/settings.json`.
- **launchd agents** — proxy-runner and auto-patch watcher unloaded and
  removed.
- **Installed scripts** — `~/.local/share/gptcc/` directory removed.

Does not remove:

- `~/.codex/auth.json` — your ChatGPT OAuth tokens. We leave these in case
  you use the official Codex CLI, which shares this file. Delete manually if
  desired.
- Claude Code plugin registration — run `claude plugin remove gptcc`
  separately if you registered it.

If you ever have doubts about state, `gptcc status` tells you exactly
what the current install looks like, and `gptcc patch --restore` on its
own reinstates just the binary.

## Contributing

Community contributions are welcome. Start here:

- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — development setup, contribution
  workflows, and the detailed guide for the most common contribution
  (updating the patch script after a Claude Code release)
- **[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)** — community expectations
- **[SECURITY.md](./SECURITY.md)** — security policy and reporting
- **[CHANGELOG.md](./CHANGELOG.md)** — release history

Most common contribution type: updating the patch script after a Claude Code
release. `gptcc diagnose` output plus a PR updating `PATTERNS` in
`scripts/patch-claude.py` is usually enough.

## FAQ

**Q: Is this an official Anthropic or OpenAI product?**
No. It's a small community tool built by and for developers who use both
platforms. Not affiliated with, endorsed by, or sponsored by Anthropic or
OpenAI. All trademarks belong to their respective owners; their use here is
nominative fair use, solely to describe what this tool interoperates with.

**Q: Is this against Anthropic's Terms of Service?**
Honestly — it's a gray area, and we want to be straightforward about that.

This tool locally adapts a copy of Claude Code on your own machine so the
model picker recognizes additional model identifiers. We believe this is
defensible under the DMCA §1201(f) interoperability exception, 17 U.S.C.
§117(a) (the owner's right to adapt software for their own use), and the
Sega v. Accolade line of cases on reverse engineering for interoperability.
No modified binary is ever redistributed.

That said, reasonable people may read the Anthropic ToS differently, and
we respect Anthropic's right to clarify their position. That's exactly why
we publish a [TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md) with a 24-hour
compliance SLA — if Anthropic (or anyone with standing) formally asks us to
wind this down, we will, without forcing escalation.

In practice: this is fine for individual developers experimenting with
multi-model workflows on their own machine. It is **not appropriate** for
corporate environments with software modification policies, for shared or
production systems, or as part of a commercial product. If you're unsure
whether it applies to your situation, assume it does and don't install.

**Q: Could my ChatGPT or Anthropic account be affected?**
The OAuth side of this is indistinguishable from the official Codex CLI
(same public client ID, same endpoints), so the ChatGPT side looks normal.
The binary patch is entirely local — Anthropic's API doesn't see anything
different from a regular Claude Code install. We've seen no reports of
accounts being actioned for this, but we can't guarantee it. If you're
cautious, use a separate test ChatGPT account while you try it.

**Q: What if I change my mind? Is it really reversible?**
Yes, and we take this seriously — it's why we always keep a binary backup
before the first patch. `gptcc uninstall` restores Claude Code to its
original state in one command. `gptcc patch --restore` does the same
for just the binary. `gptcc status` shows you exactly what's currently
modified. See the [Uninstall](#uninstall) section for the full picture.

**Q: Will this become unnecessary?**
We hope so! If Anthropic adds official support for third-party model
providers in Claude Code, this tool is no longer needed, and we'll happily
deprecate it with a pointer to the official mechanism. Until then, this
lets individual developers bridge the gap without leaving the Claude Code
environment they've invested in.

**Q: Is this faster than Codex CLI for pure GPT work?**
No. It adds a small proxy hop. Use this for *integration* with Claude Code
workflows, not for faster GPT alone. If all you want is GPT in a terminal,
use Codex CLI directly — it's the right tool for that job.

**Q: Can GPT match Claude's quality inside Claude Code?**
Varies by task. GPT does some things better, Claude does others. The value
is having both available in the same session, not one being universally
better. Most of our own usage is Claude as the main session with selective
GPT delegation (code review, independent second opinion, specialized
generation tasks).

**Q: Why strip Claude's system prompt when calling GPT?**
Claude Code's system prompt contains Anthropic-specific identity, tone
guidance, and workflow rules that are tuned for Claude. Feeding those to
GPT makes GPT perform worse than giving it a clean, task-specific prompt.
So when the proxy routes to a GPT model, it extracts only your CLAUDE.md
content and composes a minimal GPT-appropriate system prompt. Claude
identity/tone/workflow guidance is kept for Claude and only Claude.

**Q: Does the auto-patch really survive Claude Code updates?**
For minor updates (variable renames from the minifier), yes — the structural
regex patterns handle these. For major internal restructures, the auto-patch
attempts to self-update gptcc from npm first, which usually has a fix
by then. In the rare case of a completely new internal structure, a patch
script PR is needed and the auto-patch will notify you.

**Q: Is there an audit of what the patcher changes?**
Yes — everything is documented in `scripts/patch-claude.py` (the patches
applied) and `lib/proxy.mjs` (the API translation). `gptcc diagnose`
shows you exactly which patterns will match and what will change, before
anything is written. Everything is reversible via `--restore`.

## License

MIT — see [LICENSE](./LICENSE).

Not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, or
ChatGPT. All trademarks belong to their respective owners; their use in this
repository is nominative fair use, solely to describe what this tool
interoperates with.

If Anthropic, OpenAI, or another rightful party would like this project to
cease operation, see [TAKEDOWN_POLICY.md](./TAKEDOWN_POLICY.md) — we commit
to acting within 24 hours, without forcing escalation.
