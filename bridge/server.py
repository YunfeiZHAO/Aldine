#!/usr/bin/env python3
"""Local Claude Code bridge for Aldine's sidebar chat (see README.md in this folder).

Runs on the user's own machine. Aldine's chat panel (provider "Local Claude Code") POSTs a
prompt here; the bridge runs the local `claude` CLI, which uses the user's own login, and
streams the result back as NDJSON.

When the request carries an `aldine` block (the project's MCP URL plus a token the Aldine
server issued for that one project), claude starts with that MCP server and the Aldine
plugin's skills loaded for this run only, so it can read, edit and compile the project.
Nothing is installed or written to Claude Code's config. In that mode claude has no
shell, file or web tools: document text is untrusted input, and the worst a prompt
injection can reach is the one project the token is scoped to. Without the block, claude
runs with no tools at all and only chats.

Stdlib only; works with the system python3 (3.9+). Binds 127.0.0.1.

Wire protocol of POST /run (NDJSON, one JSON object per line):
  - events: {"type": "item.started" | "item.completed", "item": {...}} for tool calls,
    and one {"type": "agent_message", "text": ...} carrying the answer.
  - control lines: {"bridge": "done"} at success, or {"bridge": "error", "message": ...}.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

HOST = "127.0.0.1"
PORT = int(os.environ.get("ALDINE_BRIDGE_PORT", "8766"))
MAX_TOOL_OUTPUT = 8000
MAX_BODY = 4 * 1024 * 1024
# An empty working directory, so no project's CLAUDE.md or settings leak into the run.
WORK_DIR = Path(os.environ.get("ALDINE_BRIDGE_WORKDIR", str(Path.home() / ".aldine-bridge" / "work")))
DEFAULT_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,"
    "http://localhost:3000,http://127.0.0.1:3000,"
    "http://localhost:8080,http://127.0.0.1:8080"
)

# Aldine tools the chat never gets: they reach beyond the open project or out of Aldine.
BLOCKED_TOOLS = [
    "mcp__aldine__create_project",
    "mcp__aldine__trash_project",
    "mcp__aldine__list_projects",
    "mcp__aldine__upload_to_reader",
]

PROJECT_ID_RE = re.compile(r"^[a-z0-9]{4,20}$")


def allowed_origins() -> List[str]:
    raw = os.environ.get("ALDINE_BRIDGE_ORIGINS", DEFAULT_ORIGINS)
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]


def origin_allowed(origin: Optional[str], allowed: List[str]) -> bool:
    """No Origin header means a non-browser client (curl); browsers always send one on POST."""
    if not origin:
        return True
    return "*" in allowed or origin.rstrip("/") in allowed


def host_allowed(host: Optional[str], port: int) -> bool:
    """Refuse DNS-rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host."""
    return host in ("127.0.0.1:%d" % port, "localhost:%d" % port)


def plugin_dir() -> Optional[Path]:
    env = os.environ.get("ALDINE_PLUGIN_DIR")
    candidates = [Path(env)] if env else []
    candidates.append(Path(__file__).resolve().parent.parent / "claude-plugin" / "aldine")
    for c in candidates:
        if (c / ".claude-plugin" / "plugin.json").is_file():
            return c
    return None


def find_claude() -> Optional[str]:
    """Locate the `claude` binary. A LaunchAgent's PATH is minimal, so check common spots too."""
    override = os.environ.get("CLAUDE_BIN")
    if override and Path(override).exists():
        return override
    found = shutil.which("claude")
    if found:
        return found
    for candidate in (
        Path.home() / ".local" / "bin" / "claude",
        Path.home() / ".claude" / "local" / "claude",
        Path("/opt/homebrew/bin/claude"),
        Path("/usr/local/bin/claude"),
    ):
        if candidate.exists():
            return str(candidate)
    return None


def claude_version(claude_bin: str) -> Optional[str]:
    try:
        out = subprocess.run([claude_bin, "--version"], capture_output=True, text=True, timeout=10)
        return (out.stdout or out.stderr or "").strip() or None
    except Exception:
        return None


def parse_aldine(raw: Any) -> Tuple[Optional[Dict[str, str]], Optional[str]]:
    """Validate the request's `aldine` block. Returns (block, None), (None, None) when absent,
    or (None, error message)."""
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, "aldine must be an object"
    url = raw.get("mcpUrl")
    token = raw.get("token")
    project = raw.get("projectId")
    active = raw.get("activeFile")
    if not isinstance(url, str) or not re.match(r"^https?://[^\s]+$", url):
        return None, "aldine.mcpUrl must be an http(s) URL"
    if not isinstance(token, str) or not token or any(c in token for c in "\r\n"):
        return None, "aldine.token is required"
    if not isinstance(project, str) or not PROJECT_ID_RE.match(project):
        return None, "aldine.projectId is not a project id"
    if active is not None and (not isinstance(active, str) or len(active) > 500 or any(c in active for c in "\r\n")):
        return None, "aldine.activeFile must be a file path"
    return {"mcpUrl": url, "token": token, "projectId": project, "activeFile": active or ""}, None


def mcp_config(aldine: Dict[str, str]) -> Dict[str, Any]:
    return {"mcpServers": {"aldine": {
        "type": "http",
        "url": aldine["mcpUrl"],
        "headers": {"Authorization": "Bearer " + aldine["token"]},
    }}}


def system_prompt(aldine: Dict[str, str]) -> str:
    opened = ("The user has %s open in the editor. " % aldine["activeFile"]) if aldine["activeFile"] else ""
    return (
        "You are working in Aldine project %s through the mcp__aldine__ tools; pass that id as "
        "`project` when a tool asks for it. %s"
        "Read a file with mcp__aldine__read_file before editing it with mcp__aldine__edit_file, "
        "and copy quotes verbatim from what you read. Edits show up live in the user's editor "
        "and are committed under your name, so make the change rather than pasting replacement code."
        % (aldine["projectId"], opened)
    )


def build_command(claude_bin: str, model: Optional[str], aldine: Optional[Dict[str, str]],
                  mcp_config_path: Optional[str], plugin: Optional[Path]) -> List[str]:
    cmd = [claude_bin, "-p", "--output-format", "stream-json", "--verbose",
           "--strict-mcp-config", "--permission-mode", "dontAsk"]
    if model:
        cmd += ["--model", model]
    if aldine is None:
        return cmd + ["--tools", ""]
    cmd += ["--mcp-config", str(mcp_config_path)]
    cmd += ["--tools", "Skill"]
    cmd += ["--allowedTools", "mcp__aldine", "Skill"]
    cmd += ["--disallowedTools", *BLOCKED_TOOLS]
    if plugin is not None:
        cmd += ["--plugin-dir", str(plugin)]
    cmd += ["--append-system-prompt", system_prompt(aldine)]
    return cmd


def _flatten_tool_result(content: Any) -> str:
    """claude tool_result content is either a string or a list of {type:text, text:...} blocks."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[str] = []
        for block in content:
            if isinstance(block, dict):
                text = block.get("text")
                if isinstance(text, str):
                    parts.append(text)
                elif block.get("type") == "image":
                    parts.append("[image]")
            elif isinstance(block, str):
                parts.append(block)
        return "\n".join(parts)
    return ""


def _tool_kind(name: str) -> str:
    lowered = (name or "").lower()
    if lowered == "bash":
        return "command_execution"
    if lowered in ("websearch", "webfetch", "web_search"):
        return "web_search"
    return "tool_use"


class ClaudeTranslator:
    """Turn claude stream-json events into the chat's events: item.started when a tool is
    called, item.completed when its result arrives, and one final agent_message."""

    def __init__(self) -> None:
        self.session_id: Optional[str] = None
        self.model: Optional[str] = None
        self.last_text: str = ""
        self.pending: Dict[str, Dict[str, Any]] = {}

    def handle(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        etype = event.get("type")
        if etype == "system":
            if isinstance(event.get("session_id"), str):
                self.session_id = event["session_id"]
            if isinstance(event.get("model"), str):
                self.model = event["model"]
            return []
        if etype == "assistant":
            return self._handle_assistant(event)
        if etype == "user":
            return self._handle_user(event)
        if etype == "result":
            return self._handle_result(event)
        return []

    def _handle_assistant(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        message = event.get("message") or {}
        if isinstance(message.get("model"), str):
            self.model = message["model"]
        for block in message.get("content") or []:
            if not isinstance(block, dict):
                continue
            btype = block.get("type")
            if btype == "text":
                text = block.get("text")
                if isinstance(text, str) and text.strip():
                    self.last_text = text.strip()
            elif btype == "tool_use":
                tool_id = str(block.get("id") or "")
                name = str(block.get("name") or "tool")
                kind = _tool_kind(name)
                tool_input = block.get("input") or {}
                item: Dict[str, Any] = {"id": tool_id, "type": kind, "status": "in_progress", "name": name}
                if kind == "command_execution":
                    item["command"] = str(tool_input.get("command") or json.dumps(tool_input, ensure_ascii=False))
                elif kind == "web_search":
                    item["query"] = str(tool_input.get("query") or tool_input.get("url") or "")
                else:
                    item["command"] = json.dumps(tool_input, ensure_ascii=False)[:MAX_TOOL_OUTPUT]
                self.pending[tool_id] = item
                out.append({"type": "item.started", "item": dict(item)})
        return out

    def _handle_user(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        out: List[Dict[str, Any]] = []
        message = event.get("message") or {}
        for block in message.get("content") or []:
            if not isinstance(block, dict) or block.get("type") != "tool_result":
                continue
            tool_id = str(block.get("tool_use_id") or "")
            text = _flatten_tool_result(block.get("content"))
            if len(text) > MAX_TOOL_OUTPUT:
                text = text[:MAX_TOOL_OUTPUT] + "\n…(truncated)"
            item = dict(self.pending.get(tool_id) or {"id": tool_id, "type": "tool_use"})
            item["status"] = "failed" if block.get("is_error") else "completed"
            item["aggregated_output"] = text
            out.append({"type": "item.completed", "item": item})
        return out

    def _handle_result(self, event: Dict[str, Any]) -> List[Dict[str, Any]]:
        result_text = event.get("result")
        answer = result_text if isinstance(result_text, str) and result_text.strip() else self.last_text
        usage = event.get("usage") if isinstance(event.get("usage"), dict) else {}
        final: Dict[str, Any] = {"type": "agent_message", "text": answer or ""}
        if usage:
            final["usage"] = {
                "input_tokens": usage.get("input_tokens") or 0,
                "output_tokens": usage.get("output_tokens") or 0,
            }
        if self.model:
            final["model"] = self.model
        return [final]


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"  # connection closes at end, so the client reads the stream to EOF

    def log_message(self, fmt: str, *args: Any) -> None:
        sys.stderr.write("[bridge] " + (fmt % args) + "\n")

    def _origin_ok(self) -> bool:
        return host_allowed(self.headers.get("Host"), PORT) and origin_allowed(self.headers.get("Origin"), allowed_origins())

    def _cors_headers(self) -> None:
        origin = self.headers.get("Origin")
        if origin and origin_allowed(origin, allowed_origins()):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "content-type")
            # Chrome Private Network Access: an https page calling localhost needs this.
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _refuse_origin(self) -> None:
        if not host_allowed(self.headers.get("Host"), PORT):
            self._send_json(403, {"error": "Call the bridge as http://127.0.0.1:%d or http://localhost:%d." % (PORT, PORT)})
            return
        self._send_json(403, {"error": "Origin %s is not allowed. Add it to ALDINE_BRIDGE_ORIGINS and restart the bridge."
                              % self.headers.get("Origin")})

    def do_OPTIONS(self) -> None:
        if not self._origin_ok():
            self._refuse_origin()
            return
        self.send_response(204)
        self._cors_headers()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _send_json(self, code: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self._cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path.split("?", 1)[0] != "/health":
            self._send_json(404, {"error": "not found"})
            return
        if not self._origin_ok():
            self._refuse_origin()
            return
        claude_bin = find_claude()
        plugin = plugin_dir()
        self._send_json(200, {
            "service": "aldine",
            "ok": claude_bin is not None,
            "claude": claude_version(claude_bin) if claude_bin else None,
            "skills": str(plugin) if plugin else None,
        })

    def do_POST(self) -> None:
        if self.path.split("?", 1)[0] != "/run":
            self._send_json(404, {"error": "not found"})
            return
        if not self._origin_ok():
            self._refuse_origin()
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                self._send_json(413, {"error": "request too large"})
                return
            raw = self.rfile.read(length) if length else b""
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except Exception as exc:  # noqa: BLE001
            self._send_json(400, {"error": "bad JSON body: %s" % exc})
            return
        if not isinstance(payload, dict):
            self._send_json(400, {"error": "body must be a JSON object"})
            return
        prompt = str(payload.get("prompt") or "")
        if not prompt.strip():
            self._send_json(400, {"error": "prompt is required"})
            return
        aldine, err = parse_aldine(payload.get("aldine"))
        if err:
            self._send_json(400, {"error": err})
            return
        model = payload.get("model")
        self._run_claude(prompt, model.strip() if isinstance(model, str) and model.strip() else None, aldine)

    def _begin_stream(self) -> None:
        self.send_response(200)
        self._cors_headers()
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

    def _emit(self, obj: Dict[str, Any]) -> None:
        self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
        self.wfile.flush()

    def _run_claude(self, prompt: str, model: Optional[str], aldine: Optional[Dict[str, str]]) -> None:
        claude_bin = find_claude()
        self._begin_stream()
        if not claude_bin:
            self._emit({"bridge": "error", "message": "claude CLI not found on this machine. Install Claude Code or set CLAUDE_BIN."})
            return
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        config_path: Optional[str] = None
        try:
            if aldine is not None:
                # A 0600 file, not an argument: argv (and the token in it) is visible in `ps`.
                fd, config_path = tempfile.mkstemp(prefix="mcp-", suffix=".json", dir=str(WORK_DIR.parent))
                with os.fdopen(fd, "w") as f:
                    json.dump(mcp_config(aldine), f)
            cmd = build_command(claude_bin, model, aldine, config_path, plugin_dir())
            self._stream(cmd, prompt)
        finally:
            if config_path:
                try:
                    os.unlink(config_path)
                except OSError:
                    pass

    def _stream(self, cmd: List[str], prompt: str) -> None:
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(WORK_DIR), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                stderr=subprocess.PIPE, text=True, bufsize=1,
            )
        except Exception as exc:  # noqa: BLE001
            self._emit({"bridge": "error", "message": "failed to launch claude: %s" % exc})
            return

        stderr_chunks: List[str] = []

        def drain_stderr() -> None:
            try:
                for line in proc.stderr:  # type: ignore[union-attr]
                    stderr_chunks.append(line)
            except Exception:
                pass

        threading.Thread(target=drain_stderr, daemon=True).start()

        try:
            proc.stdin.write(prompt)  # type: ignore[union-attr]
            proc.stdin.close()  # type: ignore[union-attr]
        except Exception as exc:  # noqa: BLE001
            self._emit({"bridge": "error", "message": "failed to send prompt: %s" % exc})
            proc.kill()
            return

        translator = ClaudeTranslator()
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line.startswith("{"):
                    continue
                try:
                    event = json.loads(line)
                except json.JSONDecodeError:
                    continue
                for out in translator.handle(event):
                    self._emit(out)
        except (BrokenPipeError, ConnectionResetError):
            # The user pressed Stop or left the page: don't let claude keep editing.
            proc.kill()
            proc.wait()
            return
        code = proc.wait()
        try:
            if code == 0:
                self._emit({"bridge": "done"})
            else:
                tail = "".join(stderr_chunks)[-1000:].strip()
                self._emit({"bridge": "error", "message": "claude exited with code %s%s" % (code, (": " + tail) if tail else "")})
        except (BrokenPipeError, ConnectionResetError):
            pass


def main() -> None:
    claude_bin = find_claude()
    plugin = plugin_dir()
    sys.stderr.write("[bridge] claude %s\n" % (("found: " + (claude_version(claude_bin) or claude_bin)) if claude_bin else "NOT FOUND (set CLAUDE_BIN)"))
    sys.stderr.write("[bridge] aldine skills: %s\n" % (plugin or "not found (set ALDINE_PLUGIN_DIR); editing still works"))
    sys.stderr.write("[bridge] allowed origins: %s\n" % ", ".join(allowed_origins()))
    sys.stderr.write("[bridge] listening on http://%s:%d\n" % (HOST, PORT))
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
