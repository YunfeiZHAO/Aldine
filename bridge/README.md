# Aldine bridge: your local Claude Code in the chat

The **Local Claude Code** provider in Aldine's sidebar chat runs the `claude` CLI on
your own computer, under your own Claude login. The bridge is the small local server
that connects the two. Each time you send a message, it starts `claude` with this
project's Aldine tools (MCP) and the Aldine skills loaded for that one run, so Claude
can read, edit and compile the open project. Nothing is installed into Claude Code,
and its config is never changed.

Edits show up live in the editor, as if a collaborator were typing. Each one is
committed with **Claude** as the author, so you can review or revert it in History.

## What you need

- **macOS or Linux, with `python3` (3.9+).** `install.sh` uses macOS's launchd; on
  Linux, run `server.py` directly or under systemd.
- **Claude Code**, installed and logged in. `claude --version` should work in a
  terminal.
- **An Aldine server with the MCP connector on.** For an operator, that means:
  - `ALDINE_MCP=1` always.
  - With accounts off, also `ALDINE_MCP_TOKEN=<any long random string>`.
  - With accounts on, nothing else: the chat creates a token for you.

  Without these, the chat still works through the bridge, but Claude can only
  answer and says why it could not edit.

## 1. Start the bridge

**Permanently (macOS):** it starts at login and restarts if it stops.

```bash
cd bridge
./install.sh
```

**For the Aldine instance you use**, allow its address. The local dev addresses
(`localhost:5173`, `:3000`, `:8080`) are allowed by default:

```bash
ALDINE_BRIDGE_ORIGINS="https://latex.example.org,http://localhost:5173" ./install.sh
```

**Just for now, in a terminal:**

```bash
python3 bridge/server.py
```

Check it is up:

```bash
curl -s http://127.0.0.1:8766/health
# {"service": "aldine", "ok": true, "claude": "2.x (Claude Code)", "skills": ".../claude-plugin/aldine"}
```

## 2. Connect the chat

1. Open a project and click the **Chat** tab in the sidebar.
2. Choose **Local Claude Code** as the provider.
3. Open the settings (gear). Set the URL to `http://127.0.0.1:8766` if it isn't
   already, and click **Check connection**. It should say *Connected · <version>*.
4. Optionally set a model (`sonnet`, `opus`, `haiku` or a full model name). Leave it
   empty to use your Claude Code default.

## 3. Use it

Ask for a change the way you would ask a co-author:

- "Make the abstract shorter, under 150 words."
- Select a paragraph, then ask: "Rewrite this in the passive voice."
- "The build fails. Fix it." (uses the `latex-fix-build` skill and compiles)
- "Add a citation for arXiv 1706.03762 after 'attention' in the introduction."

Under the answer, each step Claude took is listed, for example *Reading main.tex*,
*Editing main.tex* or *Compiling*. To undo an edit, use **History** and revert that
commit. If you only want a suggestion, say so ("don't edit, just suggest"), and the
answer comes back as text with Insert and Replace selection buttons.

Pressing **Stop** ends the `claude` process right away.

## Running next to other bridges

The bridge in `read_paper/bridge` can stay installed and running alongside this
one. They share nothing:

| | read_paper bridge | Aldine bridge |
|---|---|---|
| Port | 8765 | 8766 |
| LaunchAgent | `com.readpaper.bridge` | `com.aldine.bridge` |
| Log | `~/Library/Logs/readpaper-bridge.log` | `~/Library/Logs/aldine-bridge.log` |
| Work dir | `~/.readpaper-bridge/` | `~/.aldine-bridge/` |

The chat only talks to a bridge whose `/health` says `"service": "aldine"`. If the
URL points at another bridge (for example an old saved setting of
`http://127.0.0.1:8765`), **Check connection** says so, and sending is refused
before any text leaves the browser. Other bridges ignore the project block and may
run `claude` with every tool enabled.

## Settings

Set these as environment variables before `./install.sh` (re-run it to change them)
or before `python3 server.py`.

| Variable | Default | Meaning |
|---|---|---|
| `ALDINE_BRIDGE_PORT` | `8766` | Port on 127.0.0.1 |
| `ALDINE_BRIDGE_ORIGINS` | `localhost` / `127.0.0.1` on 5173, 3000, 8080 | Comma-separated Aldine addresses allowed to use the bridge. `*` allows every website: don't. |
| `ALDINE_PLUGIN_DIR` | `../claude-plugin/aldine` | The Aldine skills. Editing works without them. |
| `CLAUDE_BIN` | found on `PATH` | Path to `claude`, if it is somewhere unusual |
| `ALDINE_BRIDGE_WORKDIR` | `~/.aldine-bridge/work` | Empty folder `claude` runs in |

Log (macOS install): `~/Library/Logs/aldine-bridge.log`. Remove the service:
`./uninstall.sh`.

## Troubleshooting

| You see | Do |
|---|---|
| *Could not reach the Claude Code bridge* | The bridge isn't running. Run `curl -s http://127.0.0.1:8766/health`, check the log, and re-run `./install.sh`. |
| *A different bridge answers here* / *is not the Aldine bridge* | The URL points at another bridge (read_paper's is on 8765). Set `http://127.0.0.1:8766` and start this one. |
| *Origin … is not allowed* | Add your Aldine address to `ALDINE_BRIDGE_ORIGINS` and re-run `./install.sh`. |
| *Chat only: … no MCP connector* | The server needs `ALDINE_MCP=1`. |
| *Chat only: … has no token* | Accounts are off, so the server needs `ALDINE_MCP_TOKEN`. |
| *claude CLI not found* | Set `CLAUDE_BIN=/path/to/claude` and re-run `./install.sh`. |
| *claude exited with code 1: …* | Usually not logged in. Run `claude` once in a terminal. |
| Port 8766 is taken | `ALDINE_BRIDGE_PORT=8777 ./install.sh`, then set that URL in the chat settings. |

## How it works

```
Aldine chat (browser)
  ① POST /api/projects/:id/ai/bridge-token  → Aldine server issues a token for this project
  ② POST http://127.0.0.1:8766/run
        {prompt, model, aldine: {mcpUrl, token, projectId, activeFile}}
        ▼
bridge/server.py (your computer)
  claude -p --output-format stream-json
         --mcp-config <0600 temp file with the URL + token> --strict-mcp-config
         --plugin-dir claude-plugin/aldine
         --tools Skill --allowedTools mcp__aldine Skill
         --disallowedTools mcp__aldine__{create_project,trash_project,list_projects,upload_to_reader}
         --permission-mode dontAsk
         --append-system-prompt "<project id, open file>"
        ▼
Aldine /mcp → edit_file merges into the live document, commits as "Claude"
        ▼
NDJSON back to the chat: item.started / item.completed per tool, agent_message, {"bridge":"done"}
```

## Security

- **No shell, file or web tools while editing.** Claude only has the `mcp__aldine__*`
  tools and Skill. Document text is untrusted: a collaborator could write
  instructions into a `.tex` file. The most such text can do is edit this one
  project, and every edit is a revertable commit.
- **A narrow token.** It covers only the open project and expires after 12 hours.
  Asking again replaces the old one, and you can revoke it in Aldine under
  Settings → Agent access. The bridge writes it to a 0600 temp file that it deletes
  after the run, never to the command line (which `ps` shows), and never to disk
  for longer.
- **Only your Aldine can use it.** Requests from other web pages are refused by the
  origin allowlist. Requests whose Host is not `127.0.0.1` or `localhost` are
  refused too (DNS rebinding).
- **Plain chat has no tools at all.** A request without the `aldine` block runs
  `claude` with every tool disabled.

## Development

```bash
python3 -m unittest -v bridge/test_server.py     # from the repo root
```

Stdlib only, no dependencies. The browser side is `streamLocalBridge` in
`apps/web/src/util/chat.ts`, and the token route is `ai/bridge-token` in
`apps/server/src/routes.ts`.
