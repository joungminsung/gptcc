# Security Policy

## Supported versions

Only the latest published major version receives security fixes.

## Reporting a vulnerability

**Do not open a public issue for security-sensitive reports.**

If you believe you've found a security issue, please report privately
(e.g. via the repository host's private security advisory mechanism, if
available on the project page, or by emailing the maintainer). Include:

- Description of the issue and its impact
- Steps to reproduce or proof-of-concept
- Affected version(s)
- Suggested fix if you have one

We'll acknowledge receipt within a reasonable time, investigate, and
coordinate disclosure once a fix is available.

## Takedown requests

If you are a rightful party (Anthropic, OpenAI, or authorized counsel) and
you'd like this project to cease operation, email or open a private
security advisory and we'll comply promptly — typically within 24 hours,
no escalation required.

## Contact

Send security reports or takedown requests to the maintainer via the GitHub
repository's **Security → Report a vulnerability** link (preferred — uses
GitHub's private security advisory mechanism).

If that is unavailable, open a minimal GitHub issue asking the maintainer to
reach out privately, without including any sensitive details.

## Scope

### In scope

- Token exfiltration or credential leakage via the CLI, proxy, or installer
- Command injection / path traversal in CLI / installer paths
- SSRF or request smuggling in the proxy
- Binary patcher bugs that could corrupt the Claude Code binary in ways
  that leak data or break signature verification
- Dependency chain issues (e.g. if we add a malicious dependency)

### Out of scope (but we still want to hear about)

- Issues that require physical access to the user's machine already
  (e.g. an attacker with shell access could do X) — we still want to
  know but they'll likely be "won't fix"
- Issues with Claude Code, Anthropic, OpenAI, or ChatGPT themselves
  (report those to the respective vendors)
- Social engineering / phishing unrelated to this tool

## Threat model

This tool is designed for use on the user's own development machine,
authenticated to their own ChatGPT account. Its security properties
assume the machine is not compromised by a local attacker.

### What we defend against

- **Malicious environment variables** — `OPENAI_TOKEN_ENDPOINT` or similar
  overrides that point to attacker-controlled hosts are rejected unless
  they match the expected upstream (`openai.com` / `anthropic.com`)
- **Auth file corruption** — atomic writes (temp file + rename) prevent
  partial-write corruption on crash
- **Permission drift** — `~/.codex/auth.json` and `.gptcc-backup`
  files are written with explicit `0o600` permissions even on overwrite
- **SSRF via proxy** — Anthropic passthrough restricted to `/v1/*` paths;
  arbitrary URLs in `req.url` are rejected
- **PATH hijacking on auto-update** — `npm` is resolved from the Node
  binary's directory (`process.execPath`), not from `PATH`
- **Shell injection** — all external commands use `spawnSync`/`execFileSync`
  with argument arrays, not interpolated shell strings
- **JWT size DoS** — JWT parsing rejects payloads larger than 16 KB

### What we don't defend against

- **A local attacker with user-level shell access** — they can read
  `~/.codex/auth.json` anyway
- **A malicious Claude Code binary** — this tool patches the binary but
  assumes it was installed via legitimate channels
- **Anthropic / OpenAI compromise** — if their API endpoints or OAuth
  service is compromised, we forward requests as normal
- **Prompt injection attacks on GPT** — the tool forwards user prompts;
  prompt safety is the user's and provider's responsibility

## Secrets handling

- OAuth tokens (access, refresh, id) are stored in `~/.codex/auth.json`
  with `0o600` permissions
- The tool does not log request or response bodies
- The tool does not collect telemetry
- The OAuth Client ID is the public Codex CLI client ID (same as the
  open-source `codex` tool from OpenAI); it is not a secret
- No API keys are ever generated, stored, or transmitted

## Extension points

gptcc uses only documented Claude Code extension mechanisms:

- `ANTHROPIC_BASE_URL` — official environment variable that routes Claude
  Code requests through a user-chosen endpoint (the local gptcc proxy).
- `ANTHROPIC_CUSTOM_MODEL_OPTION` / `_NAME` / `_DESCRIPTION` /
  `_SUPPORTED_CAPABILITIES` — official environment variables that register
  a custom model in the `/model` picker. Per Claude Code docs, "Claude Code
  skips validation for the model ID set in `ANTHROPIC_CUSTOM_MODEL_OPTION`."
- Claude Code **plugin hooks** — the installed plugin's `SessionStart` hook
  starts the proxy if it isn't already running.

No Claude Code binaries are modified, no reverse engineering is performed,
and no workaround of authentication or licensing is involved.

## Disclosure timeline

Our target timeline for reported issues:

- Acknowledgement: within 5 business days
- Initial assessment: within 14 business days
- Fix shipped: best effort; critical issues prioritized
- Public disclosure: after a fix is available, or 90 days, whichever is earlier
