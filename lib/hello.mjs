// gptcc hello — end-to-end smoke test.
// Sends a tiny Anthropic-format request to the local proxy with a gpt-*
// model, checks the response, and prints a green check. First-success
// experience for users who just ran `gptcc setup`.

import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const HOME = homedir();
const SETTINGS_PATH = join(HOME, ".claude", "settings.json");
const PORT = process.env.GPT_PROXY_PORT || "52532";

export async function hello() {
  console.log("\n  === gptcc hello ===\n");
  console.log("  Sending a tiny test prompt through the proxy...\n");

  // Load proxy auth token from settings so our test request passes the
  // proxy's auth check.
  let authToken = null;
  let pickerModel = null;
  if (existsSync(SETTINGS_PATH)) {
    try {
      const s = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
      authToken = s.env?.ANTHROPIC_AUTH_TOKEN || null;
      pickerModel = s.env?.ANTHROPIC_CUSTOM_MODEL_OPTION ||
                    s.env?.ANTHROPIC_DEFAULT_OPUS_MODEL ||
                    "gpt-5.4-fast";
    } catch {}
  }

  // Probe /health first — gives a specific "proxy down" message before we
  // try the heavy request.
  try {
    const h = await fetch(`http://127.0.0.1:${PORT}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!h.ok) throw new Error(`health ${h.status}`);
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m Proxy is not responding on port ${PORT}.`);
    console.error(`     ${err.message}`);
    console.error("     Fix: run `gptcc setup` or `gptcc proxy` in the foreground.");
    return 1;
  }

  const body = {
    model: pickerModel,
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content:
          "Respond with exactly this text and nothing else: gptcc works.",
      },
    ],
  };

  const headers = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    console.error(`  \x1b[31m✗\x1b[0m Request to proxy failed: ${err.message}`);
    console.error("     Fix: run `gptcc doctor` to diagnose.");
    return 1;
  }

  if (!resp.ok) {
    const text = await resp.text();
    console.error(`  \x1b[31m✗\x1b[0m Proxy returned ${resp.status}:`);
    console.error(`     ${text.slice(0, 500)}`);
    console.error("     Fix: run `gptcc doctor` — the error tag above names the failing layer.");
    return 1;
  }

  const data = await resp.json();
  const text =
    data?.content?.[0]?.text ??
    data?.content?.map?.((b) => b.text).filter(Boolean).join(" ") ??
    "";

  if (!text) {
    console.error("  \x1b[31m✗\x1b[0m Got an empty response.");
    console.error(`     raw: ${JSON.stringify(data).slice(0, 300)}`);
    return 1;
  }

  console.log(`  Model: ${data.model || pickerModel}`);
  console.log(`  Reply: ${text.trim()}`);
  console.log("");

  if (/gptcc\s+works/i.test(text)) {
    console.log("  \x1b[32m✓ End-to-end test passed.\x1b[0m");
    console.log("");
    console.log("  Next steps:");
    console.log(`    claude --model ${pickerModel}    # start a GPT session`);
    console.log("    claude                              # start a normal Claude session");
    console.log("    /model                               # switch between them inside a session");
    console.log('    Agent(subagent_type: "gpt-reviewer", prompt: "...")   # delegate a review');
    console.log("");
    return 0;
  }

  console.log("  \x1b[33m! Response content differs from the prompt,\x1b[0m but the");
  console.log("    full pipeline did return text — that's usually enough.");
  console.log("");
  return 0;
}
