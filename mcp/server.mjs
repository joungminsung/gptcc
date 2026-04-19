import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const AUTH_PATH = join(homedir(), ".codex", "auth.json");
const CODEX_API = "https://chatgpt.com/backend-api/codex";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

// Public Codex CLI OAuth client ID (not a secret)
const CLIENT_ID = process.env.CODEX_CLIENT_ID || "app_EMoamEEZ73f0CkXaXp7hrann";

function b64urlDecode(str) {
  let b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return Buffer.from(b64, "base64").toString();
}
function parseJwt(token) { return JSON.parse(b64urlDecode(token.split(".")[1])); }

// --- Auth ---

function loadAuth() {
  if (!existsSync(AUTH_PATH)) {
    throw new Error(`Codex auth not found at ${AUTH_PATH}. Run: gptcc login`);
  }
  return JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
}

function saveAuth(auth) {
  writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
}

let _refreshLock = null;

async function getAccessToken() {
  const auth = loadAuth();
  const tokens = auth.tokens;
  if (!tokens?.access_token)
    throw new Error("No Codex OAuth token. Run: gptcc login");

  try {
    const payload = parseJwt(tokens.access_token);
    if (payload.exp && payload.exp > Math.floor(Date.now() / 1000) + 300) {
      return tokens.access_token;
    }
  } catch {}

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
      if (data.refresh_token) freshAuth.tokens.refresh_token = data.refresh_token;
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

function getAccountId() {
  const auth = loadAuth();
  if (auth.tokens?.account_id) return auth.tokens.account_id;
  try {
    const payload = parseJwt(auth.tokens.id_token);
    return payload["https://api.openai.com/auth"]?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

// --- Codex API call (Responses API, not chat/completions) ---

async function callGPT(model, messages, options = {}) {
  const token = await getAccessToken();
  const accountId = getAccountId();
  if (!accountId) throw new Error("No account_id. Run: gptcc login");

  const input = messages.map((m) => ({
    type: "message",
    role: m.role,
    content: m.content,
  }));

  const sysMsg = messages.find((m) => m.role === "system");
  const body = {
    model,
    input: input.filter((m) => m.role !== "system"),
    instructions: sysMsg?.content || "You are a helpful assistant.",
    stream: false,
    store: false,
  };

  const res = await fetch(`${CODEX_API}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "chatgpt-account-id": accountId,
      "OpenAI-Beta": "responses=experimental",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Codex API error ${res.status}: ${err}`);
  }

  const data = await res.json();
  const textParts = [];
  for (const item of data.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text") textParts.push(part.text);
      }
    }
  }
  return textParts.join("\n") || "(no output)";
}

// --- MCP Server ---

const server = new Server(
  { name: "gptcc", version: "2.2.12" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ask_gpt54",
      description:
        "Send a prompt to GPT-5.4 via Codex backend (ChatGPT subscription). For: code generation, review, debugging, second opinions.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Main instruction/question" },
          context: { type: "string", description: "Optional context (code, summaries)" },
          system: { type: "string", description: "System prompt override" },
          model: { type: "string", description: "Model (default: gpt-5.4)", default: "gpt-5.4" },
        },
        required: ["prompt"],
      },
    },
    {
      name: "review_with_gpt54",
      description:
        "Code review via GPT-5.4. Optimized for cross-verification with Claude.",
      inputSchema: {
        type: "object",
        properties: {
          code: { type: "string", description: "Code to review" },
          instruction: { type: "string", description: "Review focus", default: "Review for bugs, security, and quality." },
          language: { type: "string", description: "Programming language" },
        },
        required: ["code"],
      },
    },
  ],
}));

// Prompt design principles for GPT (from GPT-5.4 self-review):
//   - Markdown headers for structure
//   - Constraints BEFORE data
//   - ONE task-specific depth cue (not stacked tone directives)
//   - Explicit output format
//   - No "be concise" + "thorough" contradictions
//   - No Anthropic-style tone guidance

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "ask_gpt54") {
      const model = args.model || "gpt-5.4";

      // Minimal system prompt — let the user's task carry the specifics
      const systemContent = args.system || "You are a senior software engineer.";

      // User message follows structured format: constraints → data
      const userParts = [];
      if (args.context) {
        userParts.push("## Context");
        userParts.push(args.context);
        userParts.push("");
      }
      userParts.push("## Task");
      userParts.push(args.prompt);

      const result = await callGPT(model, [
        { role: "system", content: systemContent },
        { role: "user", content: userParts.join("\n") },
      ]);
      return { content: [{ type: "text", text: result }] };
    }

    if (name === "review_with_gpt54") {
      // Task-specific: code review as independent second opinion
      // ONE depth cue: "trace evidence to conclusion"
      // Output schema explicit
      const systemContent =
`You are performing an independent code review.
Your role: flag only issues supported by evidence in the code itself.`;

      const userParts = [
        "## Task",
        args.instruction || "Find bugs, security issues, and correctness problems.",
        "",
        "## Non-goals",
        "- Style preferences, naming nits, formatting",
        "- Speculative refactoring not related to a concrete issue",
        "- Confirming things are fine — only report issues",
        "",
        "## Output format",
        "For each issue (zero or more, ordered by severity):",
        "```",
        "- [severity: critical|high|medium|low] <file>:<line>",
        "  Problem: <one-sentence description>",
        "  Evidence: <quote or reference from the code>",
        "  Fix: <minimal change>",
        "```",
        "If nothing to report, output exactly: `No issues found after checking: <list what you verified>`",
        "",
        "## Code to review",
      ];
      if (args.language) userParts.push(`Language: ${args.language}`);
      userParts.push("```");
      userParts.push(args.code);
      userParts.push("```");

      const result = await callGPT("gpt-5.4", [
        { role: "system", content: systemContent },
        { role: "user", content: userParts.join("\n") },
      ]);
      return { content: [{ type: "text", text: result }] };
    }

    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
