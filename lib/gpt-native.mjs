// GPT-native preprocessing of Anthropic-style system prompts.
// Stateless pure helpers so they can be tested in isolation.

const TONE_PATTERNS = [
  /^\s*be\s+concise\.?\s*$/gim,
  /\bbe\s+concise\b[^.\n]*\.?/gi,
  /\bthink\s+step\s+by\s+step\b[^.\n]*\.?/gi,
  /\bthink\s+carefully\b[^.\n]*\.?/gi,
  /\bthink\s+deeply\b[^.\n]*\.?/gi,
  /\bthink\s+hard\b[^.\n]*\.?/gi,
  /\blet'?s\s+think\b[^.\n]*\.?/gi,
];

export function stripClaudeToneGuidance(text) {
  if (typeof text !== "string") return text;
  let out = text;
  for (const pat of TONE_PATTERNS) out = out.replace(pat, "");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

const HIGH_EFFORT = /\b(review|diff|bug|root\s*cause|diagnos\w*|incident|race\s*condition|security\s*issue)\b/i;
const MEDIUM_EFFORT = /\b(generate|write|create|draft|scaffold|implement|refactor)\b/i;

export function inferReasoningEffort(prompt) {
  const s = String(prompt || "");
  if (HIGH_EFFORT.test(s)) return "high";
  if (MEDIUM_EFFORT.test(s)) return "medium";
  return "low";
}
