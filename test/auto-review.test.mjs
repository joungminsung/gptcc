import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordChange,
  readPending,
  clearPending,
  shouldReview,
  buildReviewInstruction,
} from "../plugin/hooks/auto-review.mjs";

function stateDir() {
  return mkdtempSync(join(tmpdir(), "gptcc-st-"));
}

test("recordChange appends to pending file and dedupes path", () => {
  const dir = stateDir();
  const p = join(dir, "pending.json");
  recordChange(p, { file: "a.ts", lines: 10 });
  recordChange(p, { file: "a.ts", lines: 5 });
  recordChange(p, { file: "b.ts", lines: 2 });
  const list = readPending(p);
  assert.equal(list.length, 2);
  const a = list.find((x) => x.file === "a.ts");
  assert.equal(a.lines, 15);
  rmSync(dir, { recursive: true });
});

test("shouldReview respects autoReview toggle", () => {
  assert.equal(shouldReview({ autoReview: false, autoReviewMinLines: 0 }, [{ file: "x", lines: 100 }]), false);
  assert.equal(shouldReview({ autoReview: true, autoReviewMinLines: 0 }, [{ file: "x", lines: 100 }]), true);
});

test("shouldReview respects minLines threshold", () => {
  assert.equal(shouldReview({ autoReview: true, autoReviewMinLines: 50 }, [{ file: "x", lines: 10 }]), false);
  assert.equal(
    shouldReview({ autoReview: true, autoReviewMinLines: 50 }, [{ file: "x", lines: 30 }, { file: "y", lines: 25 }]),
    true
  );
});

test("buildReviewInstruction names the files and asks for gpt-reviewer", () => {
  const out = buildReviewInstruction([{ file: "a.ts", lines: 10 }, { file: "b.ts", lines: 4 }]);
  assert.match(out, /gpt-reviewer/);
  assert.match(out, /a\.ts/);
  assert.match(out, /b\.ts/);
});

test("clearPending empties the file but keeps it readable", () => {
  const dir = stateDir();
  const p = join(dir, "pending.json");
  recordChange(p, { file: "a.ts", lines: 1 });
  clearPending(p);
  assert.deepEqual(readPending(p), []);
  rmSync(dir, { recursive: true });
});
