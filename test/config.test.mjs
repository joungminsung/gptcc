import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readConfig,
  writeConfig,
  setKey,
  DEFAULTS,
  VALID_KEYS,
} from "../lib/config.mjs";

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "gptcc-cfg-"));
  return { dir: d, path: join(d, "config.json") };
}

test("readConfig returns defaults when file missing", () => {
  const { path } = tmp();
  assert.deepEqual(readConfig(path), DEFAULTS);
});

test("readConfig falls back to defaults on parse error + logs", () => {
  const { path } = tmp();
  writeFileSync(path, "{ not json");
  assert.deepEqual(readConfig(path), DEFAULTS);
});

test("writeConfig produces atomic rename (tmp file gone)", () => {
  const { dir, path } = tmp();
  writeConfig(path, { ...DEFAULTS, fastmode: true });
  assert.equal(JSON.parse(readFileSync(path, "utf8")).fastmode, true);
  const stray = (existsSync(path + ".tmp"));
  assert.equal(stray, false);
  rmSync(dir, { recursive: true });
});

test("setKey validates known keys and coerces values", () => {
  const { path } = tmp();
  setKey(path, "fastmode", "on");
  assert.equal(readConfig(path).fastmode, true);
  setKey(path, "auto-review", "false");
  assert.equal(readConfig(path).autoReview, false);
  setKey(path, "auto-review-min-lines", "25");
  assert.equal(readConfig(path).autoReviewMinLines, 25);
});

test("setKey rejects unknown key", () => {
  const { path } = tmp();
  assert.throws(() => setKey(path, "nope", "on"), /unknown key/i);
});

test("setKey rejects non-boolean for boolean key", () => {
  const { path } = tmp();
  assert.throws(() => setKey(path, "fastmode", "maybe"), /invalid boolean/i);
});

test("VALID_KEYS covers all DEFAULT keys", () => {
  for (const k of Object.keys(DEFAULTS)) {
    const cli = k.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
    assert.ok(VALID_KEYS.includes(cli), `${cli} missing from VALID_KEYS`);
  }
});
