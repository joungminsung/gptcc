// Tests for the proxy auth-token enforcement logic.
//
// Run with: node --test test/auth-token.test.mjs
// Pure logic, no network.

import { test } from "node:test";
import { strict as assert } from "node:assert";

function makeCheck(expectedToken) {
  // Matches the checkProxyAuth implementation in lib/proxy.mjs.
  return (headers) => {
    if (!expectedToken) return true;
    const hdr = headers["x-gptcc-auth"] || headers["authorization"] || "";
    const val = hdr.replace(/^Bearer\s+/i, "");
    return val === expectedToken;
  };
}

test("no token configured → always passes", () => {
  const check = makeCheck(null);
  assert.equal(check({}), true);
  assert.equal(check({ authorization: "Bearer random" }), true);
});

test("x-gptcc-auth header matches", () => {
  const check = makeCheck("secret");
  assert.equal(check({ "x-gptcc-auth": "secret" }), true);
  assert.equal(check({ "x-gptcc-auth": "wrong" }), false);
});

test("Authorization: Bearer <token> matches", () => {
  const check = makeCheck("secret");
  assert.equal(check({ authorization: "Bearer secret" }), true);
  assert.equal(check({ authorization: "bearer secret" }), true);
  assert.equal(check({ authorization: "Bearer wrong" }), false);
});

test("missing header when required → rejects", () => {
  const check = makeCheck("secret");
  assert.equal(check({}), false);
});

test("empty header value when required → rejects", () => {
  const check = makeCheck("secret");
  assert.equal(check({ authorization: "" }), false);
  assert.equal(check({ authorization: "Bearer " }), false);
});
