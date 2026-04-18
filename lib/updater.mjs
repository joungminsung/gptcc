// Auto-updater: checks npm registry on every CLI invocation.
// Caches the check result for 24 hours to avoid spamming npm.
// Set GPTCC_NO_UPDATE=1 to disable.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { homedir, platform, tmpdir } from "os";
import { join, dirname } from "path";
import { spawnSync } from "child_process";
import { createRequire } from "module";

// Resolve npm executable next to the Node binary we're running.
// Prevents PATH hijacking: a compromised shell with evil `npm` on PATH can't
// trick us into running it during auto-update.
function resolveNpmExecutable() {
  const nodeDir = dirname(process.execPath);
  const candidates = platform() === "win32"
    ? [join(nodeDir, "npm.cmd"), join(nodeDir, "npm")]
    : [join(nodeDir, "npm")];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return "npm"; // Fall back to PATH — no better option
}

function getCacheDir() {
  // Respect XDG_CACHE_HOME if set
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, "gptcc");
  }
  const p = platform();
  if (p === "darwin") {
    return join(homedir(), "Library", "Caches", "gptcc");
  }
  if (p === "win32") {
    return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "gptcc", "cache");
  }
  // Linux/other: XDG default
  return join(homedir(), ".cache", "gptcc");
}

const CACHE_DIR = getCacheDir();
const CACHE_FILE = join(CACHE_DIR, "update-check.json");
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const PKG_NAME = "gptcc";

function getCurrentVersion() {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json");
    return pkg.version;
  } catch {
    return null;
  }
}

function getCache() {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    if (Date.now() - data.checkedAt > CACHE_TTL) return null;
    return data;
  } catch {
    return null;
  }
}

function setCache(latest) {
  try {
    if (!existsSync(CACHE_DIR)) {
      mkdirSync(CACHE_DIR, { recursive: true });
    }
    writeFileSync(
      CACHE_FILE,
      JSON.stringify({ latest, checkedAt: Date.now() }),
      "utf-8"
    );
  } catch {}
}

async function fetchLatestVersion() {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG_NAME}/latest`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.version || null;
  } catch {
    return null;
  }
}

function compareVersions(a, b) {
  // Strip prerelease/metadata for comparison
  const clean = (v) => v.replace(/[-+].*$/, "");
  const pa = clean(a).split(".").map(Number);
  const pb = clean(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (isNaN(na) || isNaN(nb)) return 0; // can't compare, skip update
    if (na < nb) return -1;
    if (na > nb) return 1;
  }
  return 0;
}

export async function checkAndUpdate() {
  // Opt-out via env var
  if (process.env.GPTCC_NO_UPDATE === "1") return false;

  const current = getCurrentVersion();
  if (!current) return false;

  // Check cache first
  const cache = getCache();
  let latest;

  if (cache) {
    latest = cache.latest;
  } else {
    latest = await fetchLatestVersion();
    if (latest) setCache(latest);
  }

  if (!latest) return false;
  if (compareVersions(current, latest) >= 0) return false;

  // New version available — auto-update
  console.log(`\n  Updating gptcc: ${current} → ${latest}...`);

  const result = spawnSync(resolveNpmExecutable(), ["install", "-g", `${PKG_NAME}@latest`], {
    stdio: "pipe",
    timeout: 60000,
  });

  if (result.status === 0) {
    console.log(`  Updated to ${latest}!\n`);
    // Clear cache
    try {
      const { unlinkSync } = await import("fs");
      unlinkSync(CACHE_FILE);
    } catch {}
    return true;
  }

  console.log(`  Auto-update failed. Run manually: npm install -g ${PKG_NAME}@latest\n`);
  return false;
}
