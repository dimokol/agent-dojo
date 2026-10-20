#!/bin/sh
# Starts the MCP server. exec keeps the server's parent the Claude or Codex process, which is
# how the server recognises the session it belongs to.
exec node "${0%/*}/server.mjs"
