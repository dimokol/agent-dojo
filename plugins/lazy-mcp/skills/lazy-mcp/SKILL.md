---
name: lazy-mcp
description: Wrap a stdio MCP server so it starts only when one of its tools is called. Use when the user asks to make an MCP server lazy, to cut the memory MCP servers use in every Claude Code or Codex session, or when several tabs each run the same rarely used server (Slack, Blender, a database).
---

# lazy-mcp

`lazy-mcp.sh`, next to this file, answers the MCP handshake and the tool list from a cache and starts the real server on the first tool call. You edit the user's MCP config to put it in front of a server. Show the change and wait for the user's go before writing any config file.

## Steps

1. Copy the script to a fixed path, since the plugin folder changes with each version. Recopy it after a plugin update:
   `mkdir -p ~/.claude/scripts && cp "<this skill's folder>/lazy-mcp.sh" ~/.claude/scripts/ && chmod +x ~/.claude/scripts/lazy-mcp.sh`
2. Find the server's entry. Claude Code: `claude mcp get <name>`, then the file it names (`~/.claude.json`, a project's `.mcp.json`). Codex: `~/.codex/config.toml`, `[mcp_servers.<name>]`.
3. Only wrap stdio servers (`command` + `args`). Remote `http`/`sse` servers already cost nothing locally; leave them.
4. Rewrite the entry so the old command and args follow `<name> --`. Keep `env` as it is.
   Before: `"command": "npx", "args": ["-y", "some-mcp"]`
   After: `"command": "/Users/me/.claude/scripts/lazy-mcp.sh", "args": ["some", "--", "npx", "-y", "some-mcp"]`
   On Windows, `command` is Git Bash's bash (usually `C:\\Program Files\\Git\\bin\\bash.exe`, never `C:\\Windows\\System32\\bash.exe`, which is WSL) and the script path goes first in `args`. The real command must be one Git Bash can run (`npx`, `node`, `uvx` work).
5. Show the diff, get the go, write it, then ask the user to restart the session. Check with `/mcp` that the server is listed with its tools.

## When not to wrap

- Servers the user calls in most sessions: the first call pays the start-up time (often 1 to 3 s), and nothing is saved.
- Servers whose tool list changes at run time (`listChanged` notifications): the cached list is refreshed only when the real server starts.
- Machines without `jq`: the shim then runs the server directly. Nothing breaks, and nothing is saved.

To undo, put the old `command` and `args` back.
