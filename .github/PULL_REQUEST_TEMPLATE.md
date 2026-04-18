<!-- Thanks for contributing! Please fill out the sections below. -->

## What this PR changes

<!-- Short summary. Link related issues with "Fixes #123" if applicable. -->

## Why

<!-- Context: what problem does this solve? What's the user impact? -->

## Type

- [ ] Bug fix (no behavior change for correct usage)
- [ ] Patch script update (after Claude Code release)
- [ ] Proxy change (API translation, prompt engine, performance)
- [ ] New feature
- [ ] Docs
- [ ] Refactor (no behavior change)
- [ ] Chore (tooling, dependencies)

## How to test

1. ...
2. ...
3. Expected outcome: ...

## Tested on

- **macOS version**:
- **Claude Code version**:
- **Node version**:

## Checklist

- [ ] `node --check` passes on all changed `.mjs` files
- [ ] `python3 -m py_compile` passes on changed `.py` files
- [ ] `gptcc status` healthy after the change
- [ ] Manual test of the affected flow (`setup`, `patch`, delegation, etc.)
- [ ] No new runtime dependencies (unless discussed and justified)
- [ ] README / CONTRIBUTING / CHANGELOG updated if user-visible
- [ ] Commit messages follow `<type>: <summary>` convention (see CONTRIBUTING.md)

## Screenshots / output (if user-visible change)

<!-- Before / after terminal output, for example -->

## Risk & rollout

<!-- Anything reviewers should watch out for? State changes to settings.json,
     binary patches that could corrupt, behavioral changes in existing flows, etc. -->
