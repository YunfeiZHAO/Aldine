#!/usr/bin/env bash
# Install the Aldine bridge as a macOS LaunchAgent (starts at login, restarts if it stops).
# Re-run any time to reinstall or pick up new settings. Remove it with ./uninstall.sh.
#
# Settings (environment variables, all optional). A re-run keeps the values of the
# current install for any you leave unset.
#   ALDINE_BRIDGE_PORT     port on 127.0.0.1 (default 8766)
#   ALDINE_BRIDGE_ORIGINS  comma-separated Aldine origins allowed to call the bridge
#                          (default: https://paper.yunfeizhao.com and local dev origins)
#   ALDINE_BRIDGE_SHELL    0 to give Claude no shell at all (default 1: sandboxed Bash)
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
# The value an existing install was given, so a plain re-run does not reset it.
installed() { [ -f "$PLIST" ] && plutil -extract "EnvironmentVariables.$1" raw -o - "$PLIST" 2>/dev/null || true; }

PORT="${ALDINE_BRIDGE_PORT:-$(installed ALDINE_BRIDGE_PORT)}"
PORT="${PORT:-8766}"
ORIGINS="${ALDINE_BRIDGE_ORIGINS:-$(installed ALDINE_BRIDGE_ORIGINS)}"
ORIGINS="${ORIGINS:-https://paper.yunfeizhao.com,http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000,http://localhost:8080,http://127.0.0.1:8080}"
SHELL_ON="${ALDINE_BRIDGE_SHELL:-$(installed ALDINE_BRIDGE_SHELL)}"
SHELL_ON="${SHELL_ON:-1}"
CLAUDE_BIN="${CLAUDE_BIN:-$(installed CLAUDE_BIN)}"
PLUGIN="${ALDINE_PLUGIN_DIR:-$(installed ALDINE_PLUGIN_DIR)}"
PLUGIN="${PLUGIN:-$SCRIPT_DIR/../claude-plugin/aldine}"

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

if [ "$SHELL_ON" != "0" ]; then
  echo "Setting up the bridge's Python environment (~/.aldine-bridge/venv)…"
  "$PYTHON" "$SCRIPT_DIR/setup_env.py" || echo "warning: venv setup failed — Claude's shell falls back to the system python. Re-run: python3 $SCRIPT_DIR/setup_env.py" >&2
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
        <key>ALDINE_BRIDGE_SHELL</key>
        <string>$(xml_escape "$SHELL_ON")</string>
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
echo "Shell:   $([ "$SHELL_ON" = "0" ] && echo off || echo "sandboxed, venv ~/.aldine-bridge/venv")"
echo "Log:     $LOG"
echo
echo "Check it:  curl -s http://127.0.0.1:$PORT/health"
echo "In Aldine: Chat → settings → Local Claude Code, URL http://127.0.0.1:$PORT"
