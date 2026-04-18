#!/bin/bash
# autopatch.sh — Called by launchd when ~/.local/bin/claude changes.
# 1. Waits for binary to stabilize
# 2. Attempts auto-patch
# 3. On failure: self-updates gptcc from npm, retries
# 4. On final failure: restores backup + macOS notification

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BINARY="$HOME/.local/bin/claude"
LOG="$HOME/Library/Logs/gptcc-patch.log"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

notify() {
  osascript -e "display notification \"$1\" with title \"GPT for Claude Code\" subtitle \"$2\"" 2>/dev/null
}

# Wait for binary to finish writing
prev_size=0
for i in $(seq 1 30); do
  curr_size=$(stat -f%z "$BINARY" 2>/dev/null || echo 0)
  if [ "$curr_size" -gt 0 ] && [ "$curr_size" = "$prev_size" ]; then
    break
  fi
  prev_size=$curr_size
  sleep 1
done

if [ ! -f "$BINARY" ]; then
  log "ERROR: Binary not found at $BINARY"
  exit 1
fi

# Already patched?
if python3 -c "
import sys
data = open(sys.argv[1], 'rb').read()
sys.exit(0 if b'\"gpt-5.4\",\"gpt-5.4-fast\"' in data else 1)
" "$BINARY" 2>/dev/null; then
  log "Binary already patched, skipping."
  exit 0
fi

log "Claude Code binary changed — attempting auto-patch..."

# Fresh backup of unpatched binary
cp "$BINARY" "${BINARY}.backup" 2>/dev/null

# Attempt 1: patch with current version
if python3 "$SCRIPT_DIR/patch-claude.py" --auto >> "$LOG" 2>&1; then
  log "Auto-patch successful."
  notify "Auto-patch successful" "Claude Code updated & patched"
  exit 0
fi

log "Patch failed with current version. Checking for gptcc updates..."

# Attempt 2: self-update from npm, then retry
if command -v npm &>/dev/null; then
  LATEST=$(npm view gptcc version 2>/dev/null)

  if [ -n "$LATEST" ]; then
    log "Updating gptcc to latest ($LATEST)..."
    if npm install -g gptcc@latest >> "$LOG" 2>&1; then
      log "Updated. Refreshing installed scripts..."
      # Copy fresh scripts from global npm install to our INSTALL_DIR
      NPM_ROOT=$(npm root -g 2>/dev/null)
      if [ -f "$NPM_ROOT/gptcc/scripts/patch-claude.py" ]; then
        cp "$NPM_ROOT/gptcc/scripts/patch-claude.py" "$SCRIPT_DIR/"
        cp "$NPM_ROOT/gptcc/scripts/autopatch.sh" "$SCRIPT_DIR/"
        cp "$NPM_ROOT/gptcc/lib/proxy.mjs" "$SCRIPT_DIR/"
        chmod +x "$SCRIPT_DIR/patch-claude.py" "$SCRIPT_DIR/autopatch.sh"
        log "Scripts refreshed. Retrying patch..."
        if python3 "$SCRIPT_DIR/patch-claude.py" --auto >> "$LOG" 2>&1; then
          log "Auto-patch successful after self-update."
          notify "Auto-patch successful" "gptcc updated to $LATEST"
          exit 0
        fi
      fi
    fi
  fi
fi

# All attempts failed
log "Auto-patch failed. Run: gptcc diagnose"

# Restore backup
if [ -f "${BINARY}.backup" ]; then
  cp "${BINARY}.backup" "$BINARY"
  codesign --force --sign - "$BINARY" 2>/dev/null
  log "Restored from backup."
fi

notify "Patch failed — manual update needed" "Run: gptcc diagnose"
exit 1
