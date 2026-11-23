# lazy-mcp

Claude Code and Codex start every configured MCP server in every session. lazy-mcp sits in front of a stdio server and starts it only when one of its tools is called. Until then a bash process of about 2 MB answers the handshake and the tool list from a cache.

## What it saves

Measured on a MacBook (16 GB, 9 Claude Code tabs), per tab, for servers most tabs never call:

| Server | Started in every tab | Behind lazy-mcp, until a tool is called |
| --- | --- | --- |
| Slack (Node) | 23 MB | 2 MB |
| Blender (Python) | 70 to 100 MB | 2 MB |

With 9 tabs that's about 0.8 GB for Blender alone. The first tool call in a session pays the server's normal start-up time, plus a replayed handshake (a few ms).

## Install

    claude plugin marketplace add dimokol/agent-dojo
    claude plugin install lazy-mcp@dimokol

Then ask "make my slack MCP lazy". The skill copies the script to `~/.claude/scripts/lazy-mcp.sh`, shows the config change and waits for your go. By hand: copy `skills/lazy-mcp/lazy-mcp.sh` somewhere fixed and wrap the entry:

    "slack": { "command": "/Users/me/.claude/scripts/lazy-mcp.sh", "args": ["slack", "--", "npx", "-y", "slack-mcp-server"] }

Codex (`~/.codex/config.toml`):

    [mcp_servers.slack]
    command = "/Users/me/.claude/scripts/lazy-mcp.sh"
    args = ["slack", "--", "npx", "-y", "slack-mcp-server"]

## How it works

- `initialize`, `tools/list`, `resources/list`, `resources/templates/list`, `prompts/list` and `ping` come from `~/.cache/lazy-mcp/<name>-<checksum>/`. `server/discover` (the stateless handshake Claude Code tries first) gets "method not found", as most servers answer today.
- The cache is filled by running the server once when it's missing or older than 7 days, and refreshed each time the real server starts.
- Any other request starts the server, replays the client's `initialize`, and from then on every line passes straight through.
- When the client closes, the server gets 5 seconds to exit on its own, then it's stopped.
- If the cache can't be filled, or `jq` is missing, the shim runs the server directly. A server never goes missing because of the shim. A failed fill leaves `prime-failed` in the cache folder, and for 24 hours the shim runs the server directly without trying again (delete the file to retry now).
- Filling the cache has one deadline, 10 s by default, so it never holds the client past its connection timeout.
- The shim watches the process that started it. If that dies without closing the shim's input (a forced kill), the shim stops the server and exits.

| Env var | Default | What it does |
| --- | --- | --- |
| `LAZY_MCP_CACHE` | `~/.cache/lazy-mcp` | Cache folder |
| `LAZY_MCP_LOG` | `~/Library/Logs/lazy-mcp.log` (macOS), `$XDG_STATE_HOME/lazy-mcp/lazy-mcp.log` (Linux), `%LOCALAPPDATA%\lazy-mcp\lazy-mcp.log` (Windows) | One line per start, never message contents. 1 MB, then one older copy |
| `LAZY_MCP_TRACE` | off | `1` also logs each method name |
| `LAZY_MCP_GRACE` | 5 | Seconds a server gets to exit after the client closes |
| `LAZY_MCP_PRIME_TIMEOUT` | 10 | Seconds the whole cache fill may take |
| `LAZY_MCP_TRANSPORT` | `fifo`, or `coproc` on Git Bash, MSYS and Cygwin | How the shim talks to the server it starts |

## Limits

- Stdio servers only. A server whose tool list changes while it runs shows the cached list until it starts.
- Needs bash and `jq`. macOS's bash 3.2 works (named pipes). Windows needs Git Bash; there the shim always uses a bash coproc, since a native server (node.exe, python.exe) can't open an msys named pipe. When the parent is a native Windows process its PID isn't visible to bash, so the parent watch relies on the input closing.
- Tests run on macOS and Linux in CI (`bash tests/run.sh`).

## Turn it off

Put the old `command` and `args` back, then `claude plugin disable lazy-mcp@dimokol`.
