// Routing / URL parsing tests for lib/routing.mjs (shared by proxy.mjs).
//
// Run with: npm test

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  parseBedrockInvoke,
  isOpenAIModel,
  resolveGptModel,
  isAutoAlias,
  AUTO_ALIAS,
  AUTO_REAL_MODEL,
} from "../lib/routing.mjs";

test("parseBedrockInvoke — /model/<id>/invoke", () => {
  const r = parseBedrockInvoke("/model/gpt-5.4/invoke");
  assert.deepEqual(r, { model: "gpt-5.4", stream: false });
});

test("parseBedrockInvoke — /model/<id>/invoke-with-response-stream", () => {
  const r = parseBedrockInvoke("/model/gpt-5.4-fast/invoke-with-response-stream");
  assert.deepEqual(r, { model: "gpt-5.4-fast", stream: true });
});

test("parseBedrockInvoke — URL-encoded model IDs", () => {
  const r = parseBedrockInvoke("/model/gpt-5.4%3A1m/invoke");
  assert.deepEqual(r, { model: "gpt-5.4:1m", stream: false });
});

test("parseBedrockInvoke — ignores query strings", () => {
  const r = parseBedrockInvoke("/model/gpt-5.4/invoke?foo=bar");
  assert.deepEqual(r, { model: "gpt-5.4", stream: false });
});

test("parseBedrockInvoke — returns null for /v1/messages", () => {
  assert.equal(parseBedrockInvoke("/v1/messages"), null);
});

test("parseBedrockInvoke — returns null for /health", () => {
  assert.equal(parseBedrockInvoke("/health"), null);
});

test("parseBedrockInvoke — returns null for random paths", () => {
  assert.equal(parseBedrockInvoke("/model/gpt-5.4"), null);
  assert.equal(parseBedrockInvoke("/models/gpt-5.4/invoke"), null);
  assert.equal(parseBedrockInvoke("/"), null);
});

test("isOpenAIModel — recognizes gpt-*", () => {
  assert.equal(isOpenAIModel("gpt-5.4"), true);
  assert.equal(isOpenAIModel("gpt-5.4-fast"), true);
  assert.equal(isOpenAIModel("gpt-5.3-codex"), true);
});

test("isOpenAIModel — recognizes o-series", () => {
  assert.equal(isOpenAIModel("o1"), true);
  assert.equal(isOpenAIModel("o3-mini"), true);
});

test("isOpenAIModel — rejects Claude models", () => {
  assert.equal(isOpenAIModel("claude-sonnet-4-6"), false);
  assert.equal(isOpenAIModel("claude-opus-4-7"), false);
  assert.equal(isOpenAIModel("claude-haiku-4-5"), false);
});

test("isOpenAIModel — handles empty / null", () => {
  assert.equal(isOpenAIModel(""), false);
  assert.equal(isOpenAIModel(null), false);
  assert.equal(isOpenAIModel(undefined), false);
});

test("isOpenAIModel — accepts custom prefix list", () => {
  const extra = ["gpt-", "custom-"];
  assert.equal(isOpenAIModel("custom-model", extra), true);
  assert.equal(isOpenAIModel("claude-whatever", extra), false);
});

test("isAutoAlias matches claude-auto-opus", () => {
  assert.equal(isAutoAlias("claude-auto-opus"), true);
  assert.equal(isAutoAlias("claude-opus-4-7"), false);
  assert.equal(isAutoAlias(""), false);
});

test("resolveGptModel keeps non-GPT models unchanged", () => {
  assert.equal(resolveGptModel("claude-opus-4-7", { fastmode: false }), "claude-opus-4-7");
});

test("resolveGptModel: fastmode off keeps gpt-5.4 / gpt-5.4-auto", () => {
  assert.equal(resolveGptModel("gpt-5.4", { fastmode: false }), "gpt-5.4");
  assert.equal(resolveGptModel("gpt-5.4-auto", { fastmode: false }), "gpt-5.4");
});

test("resolveGptModel: fastmode on rewrites to gpt-5.4-fast", () => {
  assert.equal(resolveGptModel("gpt-5.4", { fastmode: true }), "gpt-5.4-fast");
  assert.equal(resolveGptModel("gpt-5.4-auto", { fastmode: true }), "gpt-5.4-fast");
});

test("resolveGptModel: explicit gpt-5.4-fast always honored", () => {
  assert.equal(resolveGptModel("gpt-5.4-fast", { fastmode: false }), "gpt-5.4-fast");
  assert.equal(resolveGptModel("gpt-5.4-fast", { fastmode: true }), "gpt-5.4-fast");
});

test("AUTO_ALIAS / AUTO_REAL_MODEL are exported constants", () => {
  assert.equal(AUTO_ALIAS, "claude-auto-opus");
  assert.ok(AUTO_REAL_MODEL.startsWith("claude-opus-"));
});
