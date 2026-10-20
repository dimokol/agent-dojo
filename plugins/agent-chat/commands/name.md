---
description: agent-chat: rename this session's chat participant
argument-hint: <new-name>
allowed-tools: mcp__plugin_agent-chat_agent-chat__rename_session
---
Rename this session's agent-chat participant to `$ARGUMENTS`. This is an explicit name and replaces the default one.

1. If `$ARGUMENTS` is empty, ask for the name and stop.
2. Call the agent-chat `rename_session` tool once with only `name`: `$ARGUMENTS`, exactly as typed. The server finds this session's own identity, so pass nothing else; the rename applies to every room.
3. If the tool says to join a room first, say this session hasn't joined one and stop. Don't join a room just to rename.
4. Reply with one line: the old and new name, or the tool's error as given.
