# Screenshots

Images referenced by the project README. Replace the placeholders with
real PNGs captured from your own environment — the filenames below are
what the README expects.

## Needed

| File | What to capture |
|---|---|
| `hero.png` | A single clean shot that answers "what does this do at a glance". Ideal: `claude` running with `/model` picker open, GPT models visible. 16:9 preferred. |
| `model-picker.png` | The `/model` picker inside Claude Code with GPT entries (`gpt-5.4`, `gpt-5.4-fast`) highlighted alongside the Claude models. |
| `single-model.png` | Terminal running `claude --model gpt-5.4` with a short interaction — demonstrates "Claude Code UI, GPT brain". |
| `orchestration.png` | Main Claude session delegating to GPT via `Agent(model: "gpt-5.4-fast", ...)` — shows the orchestration pattern returning results. |

## Capture tips

- Use a 14"+ terminal window so text is crisp (retina 2x = 2800+ px wide).
- Light mode or high-contrast theme for readability on GitHub.
- Crop tight — remove dock, window chrome, and unrelated tabs.
- Export to PNG, keep under ~400 KB each. Use `pngquant` or `oxipng` if
  larger.
- Don't include any real API keys, OAuth tokens, personal email addresses,
  or private filesystem paths in the frame.

## Replacing

Drop the PNGs into this directory with the exact filenames above. The
README will pick them up automatically. Run `git add docs/screenshots/*.png
&& git commit && git push` to publish.
