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
