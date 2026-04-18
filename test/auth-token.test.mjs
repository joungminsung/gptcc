// Tests for the proxy auth-token enforcement logic (lib/routing.mjs).
//
// Run with: npm test

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { checkProxyAuth } from "../lib/routing.mjs";

test("no token configured → always passes", () => {
  assert.equal(checkProxyAuth({}, null), true);
  assert.equal(checkProxyAuth({ authorization: "Bearer random" }, null), true);
  assert.equal(checkProxyAuth({}, ""), true);
});

test("x-gptcc-auth header matches", () => {
  assert.equal(checkProxyAuth({ "x-gptcc-auth": "secret" }, "secret"), true);
  assert.equal(checkProxyAuth({ "x-gptcc-auth": "wrong" }, "secret"), false);
});

test("Authorization: Bearer <token> matches", () => {
  assert.equal(checkProxyAuth({ authorization: "Bearer secret" }, "secret"), true);
  assert.equal(checkProxyAuth({ authorization: "bearer secret" }, "secret"), true);
  assert.equal(checkProxyAuth({ authorization: "Bearer wrong" }, "secret"), false);
});

test("missing header when required → rejects", () => {
  assert.equal(checkProxyAuth({}, "secret"), false);
});

test("empty header value when required → rejects", () => {
  assert.equal(checkProxyAuth({ authorization: "" }, "secret"), false);
  assert.equal(checkProxyAuth({ authorization: "Bearer " }, "secret"), false);
});
