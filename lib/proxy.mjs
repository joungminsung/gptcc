#!/usr/bin/env node
// ============================================================================
// GPT for Claude Code Proxy for Claude Code
// Translates Anthropic Messages API <-> OpenAI Responses API
// Routes claude-* -> Anthropic API | gpt-*/o* -> Codex backend
//
// Auth: Uses Codex CLI OAuth tokens (~/.codex/auth.json)
// The CLIENT_ID below is the public Codex CLI client ID (open source).
// See: https://github.com/openai/codex
// ============================================================================

import http from "http";
import { readFileSync, writeFileSync, existsSync, statSync, chmodSync, renameSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const PORT = parseInt(process.env.GPT_PROXY_PORT || "52532", 10);

// Security: upstream endpoints must match expected host suffix to prevent
// misdirection of tokens / API keys via hostile environment variables.
function validateEndpoint(url, allowedSuffixes, fallback, label) {
  try {
    const u = new URL(url);
    if (u.protocol === "https:" && allowedSuffixes.some(s => u.hostname === s || u.hostname.endsWith("." + s))) {
      return url;
    }
    console.error(`[security] Rejecting ${label} override: ${url}. Using default.`);
  } catch {}
  return fallback;
}

const ANTHROPIC_API = validateEndpoint(
  process.env.ANTHROPIC_API_ENDPOINT,
  ["anthropic.com"],
  "https://api.anthropic.com",
  "Anthropic endpoint"
);
const CODEX_API = validateEndpoint(
  process.env.CODEX_API_ENDPOINT,
  ["chatgpt.com", "openai.com"],
  "https://chatgpt.com/backend-api/codex",
  "Codex endpoint"
);
const TOKEN_ENDPOINT = validateEndpoint(
  process.env.OPENAI_TOKEN_ENDPOINT,
  ["openai.com"],
  "https://auth.openai.com/oauth/token",
  "Token endpoint"
);
const AUTH_PATH = process.env.CODEX_AUTH_PATH || join(homedir(), ".codex", "auth.json");

// Public Codex CLI OAuth client ID (same value as open-source Codex CLI)
const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

// Debug logging for unknown SSE events, unknown models, etc.
const DEBUG = process.env.GPTCC_DEBUG === "1";
const debugLog = DEBUG ? (...a) => console.error("[DEBUG]", ...a) : () => {};

// Enable HTTP keepalive for upstream connections (reuse TCP to Codex/Anthropic)
// Node 18+ fetch uses undici under the hood — set global dispatcher with keepalive
try {
  const { setGlobalDispatcher, Agent } = await import("undici");
  setGlobalDispatcher(new Agent({
    keepAliveTimeout: 10_000,       // 10s keepalive
    keepAliveMaxTimeout: 60_000,    // cap at 60s
    connections: 16,                 // pool size per origin
  }));
  debugLog("HTTP keepalive enabled (undici Agent)");
} catch (err) {
  // undici not available (very old Node) — fallback to default (no keepalive)
  debugLog("undici not available, using default fetch:", err.message);
}

// ============================================================================
// Section 1: Codex OAuth (token + account_id from ~/.codex/auth.json)
// ============================================================================

function b64urlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString();
}

function parseJwt(token) {
  return JSON.parse(b64urlDecode(token.split(".")[1]));
}

function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(
      `Codex auth not found at ${AUTH_PATH}. Run: gptcc login`
    );
  }
  return JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
}

function saveAuth(auth) {
  // Atomic write: temp file + rename. mode: creation flag only;
  // explicit chmod ensures permissions on overwrite.
  const tmp = AUTH_PATH + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, AUTH_PATH);
    chmodSync(AUTH_PATH, 0o600);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }
}

// Cache account_id in memory — only changes on re-login (auth file mtime)
let _accountIdCache = { mtime: 0, value: null };

function getAccountId() {
  try {
    const stat = statSync(AUTH_PATH);
    if (stat.mtimeMs === _accountIdCache.mtime && _accountIdCache.value) {
      return _accountIdCache.value;
    }

    const auth = loadAuth();
    let id = auth.tokens?.account_id;
    if (!id && auth.tokens?.id_token) {
      try {
        const payload = parseJwt(auth.tokens.id_token);
        id = payload["https://api.openai.com/auth"]?.chatgpt_account_id || null;
      } catch {}
    }
    _accountIdCache = { mtime: stat.mtimeMs, value: id };
    return id;
  } catch {
    return null;
  }
}

// Mutex to prevent concurrent token refresh race condition
let _refreshLock = null;
// Cache parsed token expiry to skip redundant JWT decoding on hot path
let _tokenExpCache = { token: null, exp: 0 };

async function getAccessToken() {
  const auth = loadAuth();
  const tokens = auth.tokens;
  if (!tokens?.access_token)
    throw new Error("No Codex OAuth token. Run: gptcc login");

  // Fast path: reuse cached expiry if same token
  const now = Math.floor(Date.now() / 1000);
  if (_tokenExpCache.token === tokens.access_token) {
    if (_tokenExpCache.exp > now + 300) return tokens.access_token;
  } else {
    try {
      const payload = parseJwt(tokens.access_token);
      _tokenExpCache = { token: tokens.access_token, exp: payload.exp || 0 };
      if (payload.exp && payload.exp > now + 300) return tokens.access_token;
    } catch {}
  }

  // Deduplicate concurrent refreshes
  if (_refreshLock) return _refreshLock;
  _refreshLock = (async () => {
    try {
      const freshAuth = loadAuth();
      try {
        const p = parseJwt(freshAuth.tokens.access_token);
        if (p.exp && p.exp > Math.floor(Date.now() / 1000) + 300)
          return freshAuth.tokens.access_token;
      } catch {}

      const res = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          client_id: CLIENT_ID,
          refresh_token: freshAuth.tokens.refresh_token,
        }),
      });
      if (!res.ok) throw new Error(`Token refresh failed: ${res.status}`);

      const data = await res.json();
      freshAuth.tokens.access_token = data.access_token;
      if (data.refresh_token)
        freshAuth.tokens.refresh_token = data.refresh_token;
      if (data.id_token) freshAuth.tokens.id_token = data.id_token;
      freshAuth.last_refresh = new Date().toISOString();
      saveAuth(freshAuth);
      return data.access_token;
    } finally {
      _refreshLock = null;
    }
  })();
  return _refreshLock;
}

// ============================================================================
// Section 2: Model Detection & Resolution
// ============================================================================

// OpenAI model prefixes (future-proof: any o-series, gpt-*)
// Add custom prefixes via OPENAI_MODEL_PREFIXES env (comma-separated)
const OPENAI_PREFIXES = [
  "gpt-",
  "chatgpt-",
  ...Array.from({ length: 10 }, (_, i) => `o${i + 1}`), // o1..o10
  ...(process.env.OPENAI_MODEL_PREFIXES?.split(",").map(s => s.trim()).filter(Boolean) || []),
];

function isOpenAIModel(model) {
  if (!model) return false;
  return OPENAI_PREFIXES.some(p => model.startsWith(p));
}

// Virtual model table: { alias → { actual, fast, extras } }
// Add via OPENAI_VIRTUAL_MODELS env (JSON)
const VIRTUAL_MODELS = {
  "gpt-5.4-fast": { actual: "gpt-5.4", fast: true },
  "gpt-5.3-codex-spark": { actual: "gpt-5.3-codex", fast: true },
  ...(() => {
    try { return JSON.parse(process.env.OPENAI_VIRTUAL_MODELS || "{}"); }
    catch { return {}; }
  })(),
};

function resolveModel(model) {
  const virt = VIRTUAL_MODELS[model];
  if (virt) return { actual: virt.actual, fast: !!virt.fast, extras: virt.extras };
  return { actual: model, fast: false };
}

// ============================================================================
// Section 3: Schema Sanitizer (Anthropic -> OpenAI compatible JSON Schema)
// ============================================================================

function sanitizeSchema(schema) {
  if (!schema || typeof schema !== "object") return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  const out = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === "items") {
      if (Array.isArray(val)) {
        out.items = val.length > 0 ? sanitizeSchema(val[0]) : { type: "number" };
      } else {
        out.items = sanitizeSchema(val);
      }
    } else if (key === "properties" && typeof val === "object" && val !== null) {
      out.properties = {};
      for (const [pk, pv] of Object.entries(val)) {
        out.properties[pk] = sanitizeSchema(pv);
      }
    } else if (
      (key === "anyOf" || key === "oneOf" || key === "allOf") &&
      Array.isArray(val)
    ) {
      const filtered = val
        .filter((v) => !(v && v.type === "null"))
        .map(sanitizeSchema);
      if (filtered.length === 1) {
        Object.assign(out, filtered[0]);
      } else if (filtered.length > 0) {
        out[key] = filtered;
      } else {
        out[key] = val.map(sanitizeSchema);
      }
    } else if (
      key === "additionalProperties" &&
      typeof val === "object" &&
      val !== null
    ) {
      out.additionalProperties = sanitizeSchema(val);
    } else if (key === "$schema" || key === "id" || key === "$id") {
      continue;
    } else if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      out[key] = sanitizeSchema(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

// ============================================================================
// Section 4: Prompt Engine (Claude system prompt → GPT-optimized)
//
// Design principles (derived from GPT-5.4 self-review of its own prompt format):
//   - Replace Claude's system prompt entirely (not regex-strip — too fragile)
//   - Preserve ONLY user-authored content (CLAUDE.md instructions)
//   - Single depth cue, not stacked tone directives ("be concise" + "thorough")
//   - No Claude identity / meta / workflow instructions (noise to GPT)
//   - Output format, if any, comes from user's task — not overlay
// ============================================================================

function extractUserInstructions(text) {
  // Extract content of the "# claudeMd" section — user's global CLAUDE.md,
  // the only user-authored content inside Claude Code's system prompt.
  // Note: JS regex has no \Z; use explicit end-of-string fallback.
  const headerIdx = text.search(/^# claudeMd\s*$/m);
  if (headerIdx === -1) return null;
  const afterHeader = text.slice(headerIdx).replace(/^# claudeMd\s*\n/, "");
  // Find next "# Header" line or end of string
  const nextMatch = afterHeader.match(/^# \w/m);
  let body = nextMatch ? afterHeader.slice(0, nextMatch.index) : afterHeader;
  // Strip Claude Code's framing around user content
  body = body.replace(/Contents of [^\n]*\(user'?s[^)]*\):\s*\n/gi, "");
  body = body.replace(/Contents of [^\n]*CLAUDE\.md[^\n]*:\s*\n/gi, "");
  return body.trim() || null;
}

function isClaudeCodeSystemPrompt(text) {
  // Detect Claude Code's generated system prompts (both main and subagent).
  // Users with their own custom prompt won't match these markers.
  const head = text.slice(0, 500);
  return /^You are Claude Code,\s*Anthropic/i.test(head) ||
         /^You are Claude,?\s+made by Anthropic/i.test(head) ||
         /^You are an?\s+\w+\s+agent\b/i.test(head) &&
           (text.includes("<system-reminder>") || text.includes("tool_use")) ||
         text.includes("# claudeMd") ||
         (text.length > 3000 && /\n# Doing tasks\n/.test(text));
}

function isClaudeSubagentPrompt(text) {
  // Subagents are launched by Agent(...). They have a Claude-specific framing
  // but don't match the main Claude Code prompt markers.
  const head = text.slice(0, 500);
  return /^You are an?\s+(?:\w+\s+)?(?:Claude\s+)?(?:subagent|agent)\b/i.test(head) ||
         /^You are Claude\b/i.test(head);
}

function buildGPTSystemPrompt(rawSystem, body) {
  // Normalize to string
  let text = rawSystem;
  if (Array.isArray(text)) {
    text = text.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }
  if (text && typeof text !== "string") text = String(text);

  // No system prompt → minimal default
  if (!text || !text.trim()) {
    return "You are a senior software engineer. Respond directly and precisely.";
  }

  const isClaudeMain = isClaudeCodeSystemPrompt(text);
  const isSubagent = !isClaudeMain && isClaudeSubagentPrompt(text);

  // User-supplied prompt (neither Claude main nor subagent) — don't touch it
  if (!isClaudeMain && !isSubagent) {
    return text;
  }

  // Replace Claude-specific framing, preserve task-relevant content
  const userInstructions = extractUserInstructions(text);

  // For subagents, preserve the task description from the user-prompt-ish content
  // in the system prompt (Agent tool sometimes puts task context in system)
  let subagentTaskContext = null;
  if (isSubagent) {
    // Strip the "You are..." opening and common Claude tone rules; keep the rest
    subagentTaskContext = text
      .replace(/^You are[^.]*\.\s*/i, "")
      .replace(/^[\s\S]*?(?=##|\n\n)/, "") // jump to first header or double-newline
      .trim();
    // If nothing useful remains, null it out
    if (subagentTaskContext.length < 20) subagentTaskContext = null;
  }

  const sections = [
    // Minimal role — GPT doesn't need identity framing
    isSubagent
      ? "You are performing a delegated task. Focus on the specific request; ignore any conflicting identity framing."
      : "You are a senior software engineer working through a CLI with tool access.",
  ];

  // Tool policy — only if tools are present. Short, actionable.
  if (body?.tools?.length) {
    sections.push(
      "Use the provided tools to inspect files, run commands, and make edits. " +
      "Call them directly when needed — do not narrate what you're about to do."
    );
  }

  // User's CLAUDE.md (main conversation only — subagents typically don't have it)
  if (userInstructions) {
    sections.push("## User Instructions (from CLAUDE.md)\n\n" + userInstructions);
  }

  // Subagent task context
  if (subagentTaskContext) {
    sections.push("## Delegated Task Context\n\n" + subagentTaskContext);
  }

  return sections.join("\n\n");
}

// ============================================================================
// Section 4b: Request Translation (Anthropic Messages -> OpenAI Responses API)
// ============================================================================

function buildResponsesRequest(body) {
  const req = {
    model: body.model,
    stream: true,
    store: false,
  };

  req.instructions = buildGPTSystemPrompt(body.system, body);

  req.input = [];

  for (const msg of body.messages || []) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        req.input.push({ type: "message", role: "user", content: msg.content });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      for (const block of msg.content) {
        if (block.type === "tool_result") {
          let output = "";
          if (typeof block.content === "string") output = block.content;
          else if (Array.isArray(block.content))
            output = block.content
              .map((b) => b.text || JSON.stringify(b))
              .join("\n");
          else if (block.content) output = JSON.stringify(block.content);
          req.input.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: output || "(empty)",
          });
        } else if (block.type === "text") {
          req.input.push({
            type: "message",
            role: "user",
            content: block.text,
          });
        } else if (block.type === "image") {
          if (block.source?.type === "base64") {
            req.input.push({
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_image",
                  image_url: `data:${block.source.media_type};base64,${block.source.data}`,
                },
              ],
            });
          }
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        req.input.push({
          type: "message",
          role: "assistant",
          content: msg.content,
        });
        continue;
      }
      if (!Array.isArray(msg.content)) continue;

      const textParts = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (textParts) {
        req.input.push({
          type: "message",
          role: "assistant",
          content: textParts,
        });
      }

      for (const block of msg.content) {
        if (block.type === "tool_use") {
          req.input.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input || {}),
          });
        }
      }
    }
  }

  if (body.tools?.length) {
    req.tools = body.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description || "",
      parameters: sanitizeSchema(
        t.input_schema || { type: "object", properties: {} }
      ),
    }));
  }

  // Thinking → Reasoning effort mapping
  // Budget thresholds configurable via env vars (defaults based on empirical performance)
  //   - "low":    quick tasks (~1-2K thinking tokens)
  //   - "medium": standard tasks (~3-8K)
  //   - "high":   complex reasoning (~8-20K)
  //   - "xhigh":  deep reasoning (~20K+)
  if (body.thinking?.type === "enabled") {
    const budget = body.thinking.budget_tokens || 0;
    const thresholds = {
      low:    parseInt(process.env.REASONING_LOW_MAX || "2000", 10),
      medium: parseInt(process.env.REASONING_MEDIUM_MAX || "8000", 10),
      high:   parseInt(process.env.REASONING_HIGH_MAX || "20000", 10),
    };
    let effort;
    if (budget <= thresholds.low) effort = "low";
    else if (budget <= thresholds.medium) effort = "medium";
    else if (budget <= thresholds.high) effort = "high";
    else effort = "xhigh";
    req.reasoning = { effort, summary: "auto" };
  }

  return req;
}

// ============================================================================
// Section 5: Response Translation -- Non-Streaming
// ============================================================================

function translateResponseSync(responsesRes, model) {
  const content = [];

  for (const item of responsesRes.output || []) {
    if (item.type === "reasoning") {
      const summaryText = (item.summary || [])
        .map((s) => s.text || "")
        .join("\n");
      if (summaryText) {
        content.push({ type: "thinking", thinking: summaryText });
      }
    } else if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      let input = {};
      try {
        input = JSON.parse(item.arguments || "{}");
      } catch {}
      content.push({
        type: "tool_use",
        id: item.call_id || item.id,
        name: item.name,
        input,
      });
    }
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (content.some((c) => c.type === "tool_use")) stopReason = "tool_use";
  if (responsesRes.status === "incomplete") stopReason = "max_tokens";

  return {
    id: `msg_${responsesRes.id || Date.now()}`,
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: responsesRes.usage?.input_tokens || 0,
      output_tokens: responsesRes.usage?.output_tokens || 0,
    },
  };
}

// ============================================================================
// Section 6: Streaming Translation (Responses API SSE -> Anthropic SSE)
// ============================================================================

function createStreamTranslator(res, model) {
  let started = false;
  let blockIndex = -1;
  let hasToolUse = false;
  let usage = null;
  const outputToBlock = new Map();
  const openBlocks = new Set();

  function write(event, data) {
    if (res.writableEnded || res.destroyed) return;
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (e) {
      console.error("[STREAM] Write failed:", e.message);
    }
  }

  function ensureStarted(inputTokens) {
    if (started) return;
    started = true;
    write("message_start", {
      type: "message_start",
      message: {
        id: `msg_${Date.now()}`,
        type: "message",
        role: "assistant",
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: inputTokens || 0, output_tokens: 0 },
      },
    });
  }

  function blockKey(prefix, parsed) {
    const oi = parsed.output_index ?? 0;
    const ci = parsed.content_index ?? 0;
    return `${prefix}_${oi}_${ci}`;
  }

  function processEvent(eventType, data) {
    if (!data) return;
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (parsed.type === "response.created") {
      ensureStarted(parsed.response?.usage?.input_tokens);
      return;
    }

    ensureStarted();

    // Reasoning summary -> thinking block
    if (parsed.type === "response.reasoning_summary_part.added") {
      blockIndex++;
      const bi = blockIndex;
      outputToBlock.set(blockKey("reason", parsed), bi);
      openBlocks.add(bi);
      write("content_block_start", {
        type: "content_block_start",
        index: bi,
        content_block: { type: "thinking", thinking: "" },
      });
      return;
    }
    if (parsed.type === "response.reasoning_summary_text.delta") {
      const bi = outputToBlock.get(blockKey("reason", parsed));
      if (bi !== undefined) {
        write("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "thinking_delta", thinking: parsed.delta },
        });
      }
      return;
    }
    if (
      parsed.type === "response.reasoning_summary_text.done" ||
      parsed.type === "response.reasoning_summary_part.done"
    ) {
      const bi = outputToBlock.get(blockKey("reason", parsed));
      if (bi !== undefined && openBlocks.has(bi)) {
        write("content_block_stop", {
          type: "content_block_stop",
          index: bi,
        });
        openBlocks.delete(bi);
      }
      return;
    }

    // Text content
    if (parsed.type === "response.content_part.added") {
      if (parsed.part?.type === "output_text") {
        blockIndex++;
        const bi = blockIndex;
        outputToBlock.set(blockKey("text", parsed), bi);
        openBlocks.add(bi);
        write("content_block_start", {
          type: "content_block_start",
          index: bi,
          content_block: { type: "text", text: "" },
        });
      }
      return;
    }

    if (parsed.type === "response.output_text.delta") {
      const bi = outputToBlock.get(blockKey("text", parsed));
      if (bi !== undefined) {
        write("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "text_delta", text: parsed.delta },
        });
      }
      return;
    }

    if (
      parsed.type === "response.output_text.done" ||
      parsed.type === "response.content_part.done"
    ) {
      const bi = outputToBlock.get(blockKey("text", parsed));
      if (bi !== undefined && openBlocks.has(bi)) {
        write("content_block_stop", {
          type: "content_block_stop",
          index: bi,
        });
        openBlocks.delete(bi);
      }
      return;
    }

    // Function call
    if (
      parsed.type === "response.output_item.added" &&
      parsed.item?.type === "function_call"
    ) {
      blockIndex++;
      const bi = blockIndex;
      outputToBlock.set(`fc_${parsed.output_index ?? 0}`, bi);
      openBlocks.add(bi);
      hasToolUse = true;
      write("content_block_start", {
        type: "content_block_start",
        index: bi,
        content_block: {
          type: "tool_use",
          id: parsed.item.call_id || parsed.item.id || `call_${Date.now()}`,
          name: parsed.item.name || "",
          input: {},
        },
      });
      return;
    }

    if (parsed.type === "response.function_call_arguments.delta") {
      const bi = outputToBlock.get(`fc_${parsed.output_index ?? 0}`);
      if (bi !== undefined) {
        write("content_block_delta", {
          type: "content_block_delta",
          index: bi,
          delta: { type: "input_json_delta", partial_json: parsed.delta },
        });
      }
      return;
    }

    if (parsed.type === "response.function_call_arguments.done") {
      const bi = outputToBlock.get(`fc_${parsed.output_index ?? 0}`);
      if (bi !== undefined && openBlocks.has(bi)) {
        write("content_block_stop", {
          type: "content_block_stop",
          index: bi,
        });
        openBlocks.delete(bi);
      }
      return;
    }

    if (parsed.type === "response.output_item.done") {
      const fcKey = `fc_${parsed.output_index ?? 0}`;
      const fcBi = outputToBlock.get(fcKey);
      if (fcBi !== undefined && openBlocks.has(fcBi)) {
        write("content_block_stop", {
          type: "content_block_stop",
          index: fcBi,
        });
        openBlocks.delete(fcBi);
      }
      return;
    }

    if (parsed.type === "response.completed") {
      usage = parsed.response?.usage;
      return;
    }

    // Unknown event type — log in debug mode (helps catch Responses API additions)
    if (parsed.type?.startsWith("response.") &&
        !parsed.type.startsWith("response.error") &&
        !parsed.type.endsWith(".in_progress")) {
      debugLog("Unknown SSE event type:", parsed.type);
    }
  }

  function end() {
    ensureStarted(0);

    for (const bi of openBlocks) {
      write("content_block_stop", { type: "content_block_stop", index: bi });
    }
    openBlocks.clear();

    const stopReason = hasToolUse ? "tool_use" : "end_turn";
    write("message_delta", {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: usage?.output_tokens || 0 },
    });
    write("message_stop", { type: "message_stop" });
    res.end();
  }

  return { processEvent, end };
}

// ============================================================================
// Section 7: Anthropic Passthrough (for Claude models)
// ============================================================================

async function passthroughToAnthropic(req, res, body, rawBody) {
  // Only allow /v1/ paths to prevent SSRF via crafted URLs
  if (!req.url.startsWith("/v1/")) {
    sendError(res, 400, "invalid_request_error", `Invalid path: ${req.url}`);
    return;
  }

  const url = `${ANTHROPIC_API}${req.url}`;
  const headers = {};
  const skip = new Set([
    "host",
    "connection",
    "transfer-encoding",
    "content-length",
  ]);
  for (const [key, val] of Object.entries(req.headers)) {
    if (!skip.has(key)) headers[key] = val;
  }

  try {
    const upstream = await fetch(url, {
      method: req.method,
      headers,
      body: req.method !== "GET" ? rawBody : undefined,
    });

    const resHeaders = {
      "content-type":
        upstream.headers.get("content-type") || "application/json",
    };
    res.writeHead(upstream.status, resHeaders);

    if (body?.stream && upstream.body) {
      const reader = upstream.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch (err) {
        console.error(`[PASSTHROUGH] Stream error: ${err.message}`);
        debugLog("Passthrough stream error stack:", err.stack);
      } finally {
        res.end();
      }
    } else {
      const data = await upstream.arrayBuffer();
      res.end(Buffer.from(data));
    }
  } catch (err) {
    sendError(
      res,
      502,
      "api_error",
      `Anthropic upstream error: ${err.message}`
    );
  }
}

// ============================================================================
// Section 8: Codex Backend Call
// ============================================================================

async function callCodexBackend(responsesReq, res, model, wantStream) {
  const token = await getAccessToken();
  const accountId = getAccountId();
  if (!accountId) throw new Error("No account_id found. Run: gptcc login");

  responsesReq.stream = true;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 300000);

  let upstream;
  try {
    upstream = await fetch(`${CODEX_API}/responses`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
      },
      body: JSON.stringify(responsesReq),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      sendError(res, 504, "api_error", "Codex backend timed out (300s)");
      return;
    }
    throw err;
  }

  if (!upstream.ok) {
    clearTimeout(timeout);
    const errText = await upstream.text();
    const statusMap = {
      401: "authentication_error",
      403: "permission_error",
      429: "rate_limit_error",
    };
    sendError(
      res,
      upstream.status,
      statusMap[upstream.status] || "api_error",
      `Codex backend error (${upstream.status}): ${errText}`
    );
    return;
  }

  if (!wantStream) {
    clearTimeout(timeout);
    const fullText = await upstream.text();
    const outputItems = [];
    let completedResponse = null;

    for (const block of fullText.split(/\r?\n\r?\n/)) {
      let eventData = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("data:")) eventData += line.slice(5).trim();
      }
      if (!eventData) continue;
      try {
        const parsed = JSON.parse(eventData);
        if (parsed.type === "response.output_item.done" && parsed.item) {
          outputItems.push(parsed.item);
        }
        if (parsed.type === "response.completed" && parsed.response) {
          completedResponse = parsed.response;
        }
      } catch {}
    }

    if (completedResponse) {
      completedResponse.output =
        outputItems.length > 0 ? outputItems : completedResponse.output;
      const translated = translateResponseSync(completedResponse, model);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(translated));
    } else {
      sendError(
        res,
        500,
        "api_error",
        "No completed response received from Codex backend"
      );
    }
    return;
  }

  // Streaming
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const translator = createStreamTranslator(res, model);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        if (!block.trim()) continue;
        let eventType = "";
        let eventData = "";
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) eventData += line.slice(5).trim();
        }
        if (eventData) {
          translator.processEvent(eventType, eventData);
        }
      }
    }
    if (buffer.trim()) {
      let eventType = "";
      let eventData = "";
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        else if (line.startsWith("data:")) eventData += line.slice(5).trim();
      }
      if (eventData) translator.processEvent(eventType, eventData);
    }
    clearTimeout(timeout);
    if (!res.writableEnded) translator.end();
  } catch (err) {
    clearTimeout(timeout);
    if (!res.writableEnded) {
      try {
        translator.end();
      } catch {}
    }
  }
}

// ============================================================================
// Section 9: Error Helper & Token Estimation
// ============================================================================

function sendError(res, status, type, message) {
  console.error(`[ERROR] ${status} ${type}: ${message.slice(0, 300)}`);
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ type: "error", error: { type, message } }));
}

// Token estimation for context window management.
// Uses ~2.5 chars/token (conservative for mixed code/text).
// For production accuracy, consider npm `gpt-tokenizer` package.
function estimateTokens(body) {
  let charCount = 0;

  if (body.system) {
    if (typeof body.system === "string") charCount += body.system.length;
    else if (Array.isArray(body.system))
      for (const b of body.system)
        charCount += (b.text || JSON.stringify(b)).length;
  }

  for (const msg of body.messages || []) {
    charCount += 4;
    if (typeof msg.content === "string") {
      charCount += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "text") charCount += (block.text || "").length;
        else if (block.type === "tool_use")
          charCount +=
            JSON.stringify(block.input || {}).length +
            (block.name || "").length;
        else if (block.type === "tool_result") {
          if (typeof block.content === "string")
            charCount += block.content.length;
          else if (Array.isArray(block.content))
            for (const b of block.content)
              charCount += (b.text || JSON.stringify(b)).length;
        } else charCount += JSON.stringify(block).length;
      }
    }
  }

  if (body.tools?.length) {
    for (const t of body.tools) charCount += JSON.stringify(t).length;
  }

  return Math.ceil(charCount / 2.5);
}

// ============================================================================
// Section 10: Main Request Handler
// ============================================================================

async function handleRequest(req, res) {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        proxy: "gptcc",
        version: "2.0.0",
      })
    );
    return;
  }

  // HEAD requests (Claude Code health probe)
  if (req.method === "HEAD") {
    res.writeHead(200);
    res.end();
    return;
  }

  // GET requests -> passthrough (with path validation)
  if (req.method === "GET") {
    if (!req.url.startsWith("/v1/")) {
      sendError(res, 400, "invalid_request_error", `Invalid path: ${req.url}`);
      return;
    }
    const url = `${ANTHROPIC_API}${req.url}`;
    const headers = {};
    const skip = new Set([
      "host",
      "connection",
      "transfer-encoding",
      "content-length",
    ]);
    for (const [key, val] of Object.entries(req.headers)) {
      if (!skip.has(key)) headers[key] = val;
    }
    try {
      const upstream = await fetch(url, { method: "GET", headers });
      res.writeHead(upstream.status, {
        "content-type":
          upstream.headers.get("content-type") || "application/json",
      });
      const data = await upstream.arrayBuffer();
      res.end(Buffer.from(data));
    } catch (err) {
      sendError(res, 502, "api_error", `GET upstream error: ${err.message}`);
    }
    return;
  }

  // Read body (max 50MB)
  console.log(`[REQ] ${req.method} ${req.url}`);
  const MAX_BODY = 50 * 1024 * 1024;
  const chunks = [];
  let bodySize = 0;
  for await (const chunk of req) {
    bodySize += chunk.length;
    if (bodySize > MAX_BODY) {
      sendError(res, 413, "invalid_request_error", "Request body too large");
      return;
    }
    chunks.push(chunk);
  }
  const rawBody = Buffer.concat(chunks);

  let body = {};
  try {
    if (rawBody.length > 0) body = JSON.parse(rawBody.toString());
  } catch {
    sendError(res, 400, "invalid_request_error", "Invalid JSON body");
    return;
  }

  const model = body.model || "";
  const { actual: actualModel, fast: isFastModel } = resolveModel(model);
  console.log(
    `[ROUTE] model=${model}${isFastModel ? " [FAST]" : ""} stream=${!!body.stream} tools=${body.tools?.length || 0} msgs=${body.messages?.length || 0}`
  );

  // Token counting endpoint for GPT models
  if (isOpenAIModel(model) && req.url.includes("/count_tokens")) {
    const estimated = estimateTokens(body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ input_tokens: estimated }));
    return;
  }

  if (isOpenAIModel(model)) {
    try {
      body.model = actualModel;
      const responsesReq = buildResponsesRequest(body);
      if (isFastModel) {
        responsesReq.service_tier = "priority";
        console.log("[FAST] Priority tier enabled");
      }
      await callCodexBackend(responsesReq, res, actualModel, !!body.stream);
    } catch (err) {
      sendError(res, 500, "api_error", `Bridge error: ${err.message}`);
    }
  } else {
    await passthroughToAnthropic(req, res, body, rawBody);
  }
}

// ============================================================================
// Section 11: Server Startup
// ============================================================================

// Pre-flight: verify auth exists
try {
  loadAuth();
} catch (err) {
  console.error(`[FATAL] ${err.message}`);
  console.error("Run: gptcc login");
  process.exit(1);
}

const server = http.createServer(handleRequest);

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    // Verify it's actually our proxy, not something else
    fetch(`http://127.0.0.1:${PORT}/health`)
      .then((r) => r.json())
      .then((data) => {
        if (data.proxy === "gptcc") {
          console.log("GPT for Claude Code already running.");
          process.exit(0);
        } else {
          console.error(
            `Port ${PORT} in use by another process. Set GPT_PROXY_PORT to use a different port.`
          );
          process.exit(1);
        }
      })
      .catch(() => {
        console.error(
          `Port ${PORT} in use by unknown process. Set GPT_PROXY_PORT to use a different port.`
        );
        process.exit(1);
      });
    return;
  }
  console.error("Server error:", err);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`GPT for Claude Code Proxy v2.0.0 on http://127.0.0.1:${PORT}`);
  console.log("Routes: claude-* -> Anthropic | gpt-*/o* -> Codex backend");
});

process.on("SIGTERM", () => {
  server.close();
  process.exit(0);
});
process.on("SIGINT", () => {
  server.close();
  process.exit(0);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught:", err);
});
process.on("unhandledRejection", (err) => {
  console.error("Unhandled:", err);
});
