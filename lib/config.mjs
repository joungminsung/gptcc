// Pure config module. No side effects beyond the explicit file path given.

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = Object.freeze({
  fastmode: false,
  autoReview: false,
  autoReviewMinLines: 0,
  superWork: false,
});

// CLI keys (kebab-case) → JSON keys (camelCase)
const CLI_TO_JSON = {
  "fastmode": "fastmode",
  "auto-review": "autoReview",
  "auto-review-min-lines": "autoReviewMinLines",
  "super-work": "superWork",
};

export const VALID_KEYS = Object.keys(CLI_TO_JSON);

export function defaultConfigPath() {
  return join(homedir(), ".gptcc", "config.json");
}

export function readConfig(path = defaultConfigPath()) {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...pickKnown(parsed) };
  } catch (err) {
    console.error(`[gptcc/config] parse failed for ${path}: ${err.message}. Using defaults.`);
    return { ...DEFAULTS };
  }
}

function pickKnown(obj) {
  const out = {};
  for (const jsonKey of Object.keys(DEFAULTS)) {
    if (jsonKey in obj) out[jsonKey] = obj[jsonKey];
  }
  return out;
}

export function writeConfig(path, config) {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function coerce(jsonKey, rawValue) {
  if (jsonKey === "autoReviewMinLines") {
    const n = parseInt(rawValue, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error(`invalid integer: ${rawValue}`);
    return n;
  }
  // boolean
  const s = String(rawValue).toLowerCase();
  if (["on", "true", "1", "yes"].includes(s)) return true;
  if (["off", "false", "0", "no"].includes(s)) return false;
  throw new Error(`invalid boolean: ${rawValue}`);
}

export function setKey(path, cliKey, rawValue) {
  const jsonKey = CLI_TO_JSON[cliKey];
  if (!jsonKey) throw new Error(`unknown key: ${cliKey}`);
  const value = coerce(jsonKey, rawValue);
  const current = readConfig(path);
  writeConfig(path, { ...current, [jsonKey]: value });
}

export function resetConfig(path) {
  writeConfig(path, { ...DEFAULTS });
}
