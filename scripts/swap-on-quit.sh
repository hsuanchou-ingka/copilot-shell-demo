#!/bin/bash
# Waits for the running app to quit, swaps in the fresh build, then relaunches it.
# The app cannot replace itself while a conversation is hosted inside it.
set -u

PID="$1"
SOURCE="$2"
TARGET="/Applications/HC Copilot.app"
LOG="$HOME/Library/Logs/hc-copilot-swap.log"

echo "$(date) waiting for pid $PID" >> "$LOG"
while kill -0 "$PID" 2>/dev/null; do
  sleep 1
done

sleep 2

if [ ! -d "$SOURCE" ]; then
  echo "$(date) source missing: $SOURCE" >> "$LOG"
  exit 1
fi

rm -rf "$TARGET.old"
if [ -d "$TARGET" ]; then
  mv "$TARGET" "$TARGET.old" 2>>"$LOG"
fi

if ditto "$SOURCE" "$TARGET" 2>>"$LOG"; then
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  rm -rf "$TARGET.old"
  echo "$(date) installed, relaunching" >> "$LOG"
  open "$TARGET"
else
  echo "$(date) install failed, rolling back" >> "$LOG"
  rm -rf "$TARGET"
  mv "$TARGET.old" "$TARGET" 2>>"$LOG"
  open "$TARGET"
fi
