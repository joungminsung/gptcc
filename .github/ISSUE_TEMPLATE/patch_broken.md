---
name: Patch broken after Claude Code update
about: GPT models disappeared from /model picker after a Claude Code update and auto-patch did not recover
labels: patch-broken, priority
---

## Claude Code version

<!-- claude --version -->

## What fails

<!-- Which pattern(s) fail according to `gptcc diagnose`? -->

## `gptcc diagnose` output

```
<!-- paste the full output here — the partial-match context is what we need -->
```

## `~/Library/Logs/gptcc-patch.log` (last 100 lines)

```
<!-- paste here -->
```

## What I tried

- [ ] `gptcc patch` manually
- [ ] `gptcc diagnose`
- [ ] Reinstall: `npm install -g gptcc@latest` + `gptcc setup`

## If you're comfortable proposing a regex fix

Which `PATTERNS` entries in `scripts/patch-claude.py` need updating, and
what does the new binary structure look like? Include a binary snippet
(hex + decoded) showing the pattern context. See CONTRIBUTING.md →
"Fixing the Patch Script After a Claude Code Update" for the workflow.
