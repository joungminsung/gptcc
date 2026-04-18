---
name: gpt-orchestration
description: How to delegate work to GPT-5.4 via Agent tool — when to delegate, how to construct GPT-optimized prompts, and how to verify results
---

# GPT-5.4 Orchestration

GPT-5.4 is available via `Agent(model: "gpt-5.4-fast")` and through the MCP tools
`ask_gpt54` / `review_with_gpt54`. The proxy auto-optimizes Claude's system prompt
for GPT (strips Claude identity and meta-instructions; preserves user's CLAUDE.md).

## When Delegation Actually Helps

Delegation has real cost: context handoff, extra latency, coordination overhead.
It only pays off when one of these is true:

| Situation | Why delegate | Example |
|---|---|---|
| **Independent, spec-driven work** | No conversation context needed | Generate a new module from a written spec |
| **Second opinion on high-stakes code** | Two independent models catch more | Security-sensitive function; PR ready to merge |
| **Parallel paths** | Real wall-clock savings | Claude searches one codebase area, GPT another |
| **Model disagreement is the goal** | You want diverse viewpoints | Architecture decision with no clear best answer |

**Do not delegate** when:
- The task is part of an ongoing conversation (context loss hurts more than GPT helps)
- A quick edit Claude can finish in 1–2 tool calls
- UI/UX, Figma, or anything needing visual judgment
- Environment config, credentials, or local-state-dependent work

## Prompt Construction (Important)

GPT responds best to prompts that are:

1. **Structured with markdown headers** (not prose)
2. **Constraints-first** — what NOT to do, before the data
3. **One depth cue** — "trace root cause", not a stack of "think carefully / deeply / step by step"
4. **Explicit output schema** — what format you want back
5. **No contradictory tone** — do not ask for "concise" + "thorough" in the same prompt

### Template 1 — Code Generation

```
Agent(model: "gpt-5.4-fast", prompt: """
## Task
Create [module/function/class] that [behavior].

## Requirements
- [requirement 1, concrete, testable]
- [requirement 2]
- [requirement 3]

## Constraints
- Language: [lang]
- Integrates with: [existing interface / file path]
- Style: match patterns in [example file]
- Do not use: [libraries/approaches to avoid]

## Output format
A single fenced code block containing the complete file.
No explanation or commentary.
""")
```

### Template 2 — Independent Code Review

```
Agent(model: "gpt-5.4-fast", prompt: """
## Task
You are performing an independent code review.
Flag only issues supported by evidence in the code itself.

## Intent
[what the code is supposed to do — one sentence]

## Non-goals
- Style nits, naming, formatting
- Speculative refactoring
- Confirming things look fine

## Output format
For each issue:
- [severity: critical|high|medium|low] file:line
  Problem: <one-sentence description>
  Evidence: <quote from the code>
  Fix: <minimal change>

If no issues: "No issues found after checking: <list what you verified>"

## Code
[paste diff or file contents]
""")
```

**Important**: do NOT include your own analysis or suspicions in the prompt.
That anchors GPT and defeats the purpose of an independent review.

### Template 3 — Root Cause Analysis

```
Agent(model: "gpt-5.4-fast", prompt: """
## Task
Trace the root cause of this bug from symptom to cause.

## Symptom
[what the user observes]

## Expected behavior
[what should happen]

## Evidence
[stack trace / error message / failing test output — verbatim]

## Relevant code
[paste the smallest set of files that could contain the bug]

## Output format
1. Root cause: <one sentence>
2. Causal chain: symptom → ... → root cause (one step per line, each backed by evidence)
3. Minimal fix: <what to change, where, why this fixes it>
4. Confidence: high | medium | low, with reasoning
""")
```

### Template 4 — Architecture Second Opinion

```
Agent(model: "gpt-5.4-fast", prompt: """
## Task
Propose 2-3 approaches to [decision]. Recommend one.

## Context
- Current state: [what exists now]
- Constraints: [hard limits: scale, latency, team, tech]
- Goals: [what success looks like]

## Non-goals
- Exhaustive survey of all possible approaches
- Advocating for any particular technology

## Output format
For each approach:
- Name + one-line description
- Trade-offs (3 bullets max)
- When it's the right choice

Then:
- Recommendation: <approach name>
- Why: <reasoning tied to the constraints above>
""")
```

## Cross-Review Protocol

For non-trivial changes (new modules, refactors >100 lines, security-sensitive code),
run Claude and GPT reviews in parallel as independent checks.

### Step 1 — Launch in parallel

```
# Send both simultaneously. Do NOT share Claude's analysis with the GPT agent.
Agent(subagent_type: "superpowers:code-reviewer", prompt: "Review <path/to/changes>...")
Agent(model: "gpt-5.4-fast", prompt: "<use Template 2 above — diff + intent only>")
```

### Step 2 — Compare findings

| Issue | Claude | GPT | Action |
|---|---|---|---|
| [issue A] | flagged critical | flagged high | Fix |
| [issue B] | flagged medium | not mentioned | Verify then decide |
| [issue C] | not mentioned | flagged medium | Investigate |

### Step 3 — Resolve

- **Both flag same issue** → fix
- **Only one flags** → verify the finding (read the cited lines), then decide
- **Contradictory** → dig deeper, usually one is wrong
- **Neither flags anything** → higher confidence, but not proof of safety

### Step 4 — Report to user

```
## Cross-Review Summary

Reviewed: <what>
- Claude found: N issues (top: <brief list>)
- GPT found: N issues (top: <brief list>)
- Common: <issues both caught>
- Fixed in this change: <list>
- Deferred: <list with reason>
```

## Result Verification (always)

GPT output must be verified before applying:

- **Code generation** → read it, run type check / linter, test integration points
- **Review findings** → read cited lines, confirm issue is real (GPT has false positives)
- **Root cause analysis** → test the proposed fix mentally against edge cases

Never apply GPT output blindly. Never claim "no issues" without naming what was checked.

## Error Recovery

**GPT times out or errors**
> GPT delegation failed for <task>. Handling with Claude instead.

Then execute with Claude. Do not silently retry GPT.

**GPT output is low-quality**
Signs: empty, off-topic, generic, repeats the prompt.
> GPT response was insufficient for <task>. Re-doing with Claude.

**GPT disagrees with Claude**
This is often the value. Present both views to the user; do not auto-resolve.

## Feedback Format

**Before delegation** (one line):
> Delegating to GPT-5.4-fast: generate auth middleware (spec-driven, independent).

**After delegation** (structured):
> **[GPT-5.4-fast]**
> - Task: auth middleware
> - Output: src/middleware/auth.ts (87 lines)
> - Key decisions: JWT validation, refresh token rotation
> - Verification: type check passed, integrates with User type
> - Issues: none after post-generation review

**Never say** "no issues found" without listing what was checked.

---

## Why this structure (rationale for maintainers)

GPT's own prompt-engineering self-assessment (captured in the repo's prompt design
notes) emphasizes:

- Markdown headers > prose
- Constraints BEFORE data (so constraints frame interpretation)
- One task-specific depth cue, not a stack
- Explicit output schema
- No "be concise" style directives when deep work is needed

The templates above are built around these rules. If you find a prompt producing
poor results, check for: (a) contradictory tone directives, (b) stacked think-harder
phrases, (c) data before constraints, (d) missing output schema. Fix by restructure,
not by adding more instructions.
