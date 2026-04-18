# Takedown Policy

This is a small community interoperability tool for personal development
environments. It works by locally adapting an already-installed copy of
Claude Code on the end user's own machine so the model picker can recognize
additional model identifiers. No modified binary is ever redistributed, and
every change is fully reversible with `gptcc uninstall`.

We believe this kind of local adaptation is defensible under the DMCA
§1201(f) interoperability exception, 17 U.S.C. §117(a), and the Sega v.
Accolade line of cases — but we recognize that reasonable parties may read
Anthropic's Terms of Service differently than we do, and we want to make our
response to that as straightforward as possible.

If any rightful party — including but not limited to Anthropic, OpenAI, or
ChatGPT (OpenAI OpCo LLC) — formally requests that this project cease
operation, the maintainers commit to the following response protocol,
without requiring formal legal proceedings.

## Scope of "rightful party"

- Anthropic, PBC — in its capacity as the developer of Claude Code
- OpenAI, OpCo LLC — in its capacity as the operator of ChatGPT and the Codex
  API this tool authenticates against
- Any party acting as authorized counsel on behalf of either

## Response SLA

Upon receipt of a formal written request (email, DMCA notice, cease-and-desist
letter, or equivalent) to the maintainer contact listed in `SECURITY.md`:

| Timeframe | Action |
|---|---|
| Within **24 hours** of receipt | Acknowledge receipt of the notice via reply to the sender |
| Within **24 hours** of receipt | Archive the GitHub repository (read-only, no new commits / PRs) |
| Within **24 hours** of receipt | Publish a `DEPRECATED` notice at the top of README.md |
| Within **48 hours** of receipt | Mark the npm package as deprecated via `npm deprecate` |
| Within **7 days** of receipt | Remove the npm package entirely if requested |

These actions will be taken **without requiring the requester to initiate
legal proceedings**. We will not force escalation.

## What "cease operation" means

If requested, we will:

- Stop accepting new contributions
- Archive the repository so no further releases can be published
- Publish a notice advising existing users to uninstall via
  `gptcc uninstall`
- Withdraw the npm package from active distribution
- Remove the authors' public endorsement of the tool

We will **not**:

- Attempt to contact or demand action from individual users who have already
  installed the tool (we don't track users; we don't have a list)
- Push any forced update or remote disable mechanism (the tool has no such
  capability by design)
- Continue any further distribution, development, or promotion of the tool

## Reverse course

If a takedown request is subsequently withdrawn, or if the underlying concern
is resolved (for example, official support for custom model providers is
added to Claude Code), the project may be un-archived at the maintainers'
discretion.

## Contact

To send a formal takedown request, use the security contact listed in
[SECURITY.md](./SECURITY.md). Please include:

1. Your identity and authority to request action on behalf of the rightful party
2. The specific concern (ToS clause, copyright claim, trademark claim, etc.)
3. The action you are requesting

We will respond to any good-faith request within the SLA above. We will not
ignore, stall, or attempt to litigate.

---

*This policy exists because we believe that community research tools should
exist, and because we believe that when rightful parties object, the correct
response is to comply quickly and quietly — not to hide, stall, or force
escalation.*
