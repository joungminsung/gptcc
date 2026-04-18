// Pure routing / detection helpers used by lib/proxy.mjs.
//
// Extracted into a side-effect-free module so tests can import them
// without triggering proxy.mjs's startup side effects (auth loading,
// server bind, etc).

// Bedrock-format invoke routes:
//   /model/<id>/invoke
//   /model/<id>/invoke-with-response-stream
//
// Returns { model, stream } or null for anything that isn't a Bedrock
// invoke URL. Model IDs are URL-decoded.
export function parseBedrockInvoke(url) {
  const m = url.match(
    /^\/model\/([^/]+)\/invoke(-with-response-stream)?(?:\?.*)?$/
  );
  if (!m) return null;
  return {
    model: decodeURIComponent(m[1]),
    stream: !!m[2],
  };
}

// OpenAI / o-series model detection. Extra prefixes can be added through
// OPENAI_MODEL_PREFIXES (comma-separated) at startup.
const DEFAULT_OPENAI_PREFIXES = [
  "gpt-",
  "chatgpt-",
  "o1",
  "o2",
  "o3",
  "o4",
  "o5",
  "o6",
  "o7",
  "o8",
  "o9",
  "o10",
];

export function isOpenAIModel(model, prefixes = DEFAULT_OPENAI_PREFIXES) {
  if (!model || typeof model !== "string") return false;
  return prefixes.some((p) => model.startsWith(p));
}

// Proxy auth-token check. Accepts either a dedicated header
// (`x-gptcc-auth`) or a `Bearer <token>` in `Authorization`.
// When `expectedToken` is falsy, no auth is enforced (all requests pass).
export function checkProxyAuth(headers, expectedToken) {
  if (!expectedToken) return true;
  const hdr = headers["x-gptcc-auth"] || headers["authorization"] || "";
  const val = hdr.replace(/^Bearer\s+/i, "");
  return val === expectedToken;
}
