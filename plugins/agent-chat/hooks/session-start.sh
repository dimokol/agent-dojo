#!/bin/sh
# Registers this tab at start, /resume, /clear and fork, so a resumed conversation is back in its
# rooms. Without Node 24.15+ it stays quiet; the MCP server reports the version problem in /mcp.
command -v node >/dev/null 2>&1 || exit 0
node "${0%/*}/../server/claude-session-hook.mjs" 2>/dev/null || exit 0
