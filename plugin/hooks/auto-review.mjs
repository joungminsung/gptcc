// Auto-review hook helpers + entry point.
//
// Invoked by Claude Code in two modes based on the first argv:
//   node auto-review.mjs record  (called from PostToolUse)
//   node auto-review.mjs stop    (called from Stop)
//
// The helpers are exported for unit tests.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { readConfig, defaultConfigPath } from "../../lib/config.mjs";

export const DEFAULT_PENDING_PATH = join(homedir(), ".gptcc", "state", "pending-review.json");

export function readPending(path = DEFAULT_PENDING_PATH) {
  if (!existsSync(path)) return [];
  try {
    const arr = JSON.parse(readFileSync(path, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writePending(path, list) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(list, null, 2), "utf8");
}

export function recordChange(path, entry) {
  const list = readPending(path);
  const existing = list.find((e) => e.file === entry.file);
  if (existing) existing.lines += entry.lines || 0;
  else list.push({ file: entry.file, lines: entry.lines || 0 });
  writePending(path, list);
}

export function clearPending(path = DEFAULT_PENDING_PATH) {
  writePending(path, []);
}

export function shouldReview(config, pending) {
  if (!config.autoReview) return false;
  const total = pending.reduce((sum, e) => sum + (e.lines || 0), 0);
  return total >= (config.autoReviewMinLines || 0) && pending.length > 0;
}

export function buildReviewInstruction(pending) {
  const files = pending.map((e) => `- ${e.file} (~${e.lines} lines changed)`).join("\n");
  return [
    "Auto review: dispatch a gpt-reviewer subagent to independently review the changes below.",
    "",
    "Files:",
    files,
    "",
    "Use `Agent(subagent_type: \"gpt-reviewer\", prompt: ...)` with a diff-based prompt.",
    "After the subagent returns, present its findings to me verbatim (or 'No material issues found.').",
  ].join("\n");
}

async function mainRecord() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }

  const toolName = payload.tool_name || payload.toolName;
  if (!["Edit", "Write", "MultiEdit"].includes(toolName)) return;

  const input = payload.tool_input || payload.toolInput || {};
  const file = input.file_path || input.filePath || "<unknown>";

  const bodies = [input.new_string, input.content, input.new_content].filter((x) => typeof x === "string");
  const lines = bodies.reduce((n, s) => n + s.split("\n").length, 0);

  recordChange(DEFAULT_PENDING_PATH, { file, lines });
}

function mainStop() {
  const cfg = readConfig(defaultConfigPath());
  const pending = readPending(DEFAULT_PENDING_PATH);
  if (!shouldReview(cfg, pending)) return;

  const instruction = buildReviewInstruction(pending);
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: instruction,
  }));
  clearPending(DEFAULT_PENDING_PATH);
}

const mode = process.argv[2];
if (mode === "record") await mainRecord();
else if (mode === "stop") mainStop();
