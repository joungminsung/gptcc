import { test } from "node:test";
import assert from "node:assert/strict";
import { stripClaudeToneGuidance } from "../lib/gpt-native.mjs";

test("stripClaudeToneGuidance removes 'be concise' style lines", () => {
  const input = "You are an assistant.\nBe concise.\nReturn JSON.";
  const out = stripClaudeToneGuidance(input);
  assert.doesNotMatch(out, /be concise/i);
  assert.match(out, /Return JSON/);
});

test("stripClaudeToneGuidance removes 'think step by step' stacks", () => {
  const input = "Solve this. Think step by step. Think carefully. Think deeply.";
  const out = stripClaudeToneGuidance(input);
  assert.doesNotMatch(out, /step by step/i);
  assert.doesNotMatch(out, /think carefully/i);
  assert.doesNotMatch(out, /think deeply/i);
});

test("stripClaudeToneGuidance preserves markdown headers", () => {
  const input = "## Task\nDo X.\n## Output\nJSON.";
  const out = stripClaudeToneGuidance(input);
  assert.match(out, /## Task/);
  assert.match(out, /## Output/);
});
