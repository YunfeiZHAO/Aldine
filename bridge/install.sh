#!/usr/bin/env bash
# Install the Aldine bridge as a macOS LaunchAgent (starts at login, restarts if it stops).
# Re-run any time to reinstall or pick up new settings. Remove it with ./uninstall.sh.
#
# Settings (environment variables, all optional):
#   ALDINE_BRIDGE_PORT     port on 127.0.0.1 (default 8766)
#   ALDINE_BRIDGE_ORIGINS  comma-separated Aldine origins allowed to call the bridge,
#                          e.g. https://latex.example.org (default: local dev origins)
#   ALDINE_PLUGIN_DIR      the Aldine Claude Code plugin whose skills each run loads
#                          (default: ../claude-plugin/aldine in this repo)
#   CLAUDE_BIN             path to the claude CLI, when it is not on PATH
set -euo pipefail

LABEL="com.aldine.bridge"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER="$SCRIPT_DIR/server.py"
PYTHON="$(command -v python3 || true)"
LOG="$HOME/Library/Logs/aldine-bridge.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${ALDINE_BRIDGE_PORT:-8766}"
ORIGINS="${ALDINE_BRIDGE_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080}"
PLUGIN="${ALDINE_PLUGIN_DIR:-$SCRIPT_DIR/../claude-plugin/aldine}"

if [ -z "$PYTHON" ]; then
  echo "error: python3 not found on PATH" >&2
  exit 1
fi
if [ -f "$PLUGIN/.claude-plugin/plugin.json" ]; then
  PLUGIN="$(cd "$PLUGIN" && pwd)"
else
  echo "warning: no Aldine plugin at $PLUGIN — Claude can still edit, but without the Aldine skills." >&2
  echo "         Set ALDINE_PLUGIN_DIR to the claude-plugin/aldine folder and re-run." >&2
  PLUGIN=""
fi

xml_escape() { sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' <<<"$1"; }

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

{
  cat <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$(xml_escape "$PYTHON")</string>
        <string>$(xml_escape "$SERVER")</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
        <key>ALDINE_BRIDGE_PORT</key>
        <string>$(xml_escape "$PORT")</string>
        <key>ALDINE_BRIDGE_ORIGINS</key>
        <string>$(xml_escape "$ORIGINS")</string>
EOF
  if [ -n "$PLUGIN" ]; then
    printf '        <key>ALDINE_PLUGIN_DIR</key>\n        <string>%s</string>\n' "$(xml_escape "$PLUGIN")"
  fi
  if [ -n "${CLAUDE_BIN:-}" ]; then
    printf '        <key>CLAUDE_BIN</key>\n        <string>%s</string>\n' "$(xml_escape "$CLAUDE_BIN")"
  fi
  cat <<EOF
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>$LOG</string>
    <key>StandardErrorPath</key>
    <string>$LOG</string>
</dict>
</plist>
EOF
} > "$PLIST"

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

echo "Installed LaunchAgent: $PLIST"
echo "Server:  $SERVER"
echo "Port:    $PORT"
echo "Origins: $ORIGINS"
echo "Skills:  ${PLUGIN:-none}"
echo "Log:     $LOG"
echo
echo "Check it:  curl -s http://127.0.0.1:$PORT/health"
echo "In Aldine: Chat → settings → Local Claude Code, URL http://127.0.0.1:$PORT"
