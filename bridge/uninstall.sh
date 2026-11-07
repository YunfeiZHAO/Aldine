#!/usr/bin/env bash
# Remove the Aldine bridge LaunchAgent.
set -euo pipefail

PLIST="$HOME/Library/LaunchAgents/com.aldine.bridge.plist"

if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $PLIST"
else
  echo "Not installed (no $PLIST)"
fi
