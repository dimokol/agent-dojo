---
description: agent-chat: list unread mail across this project
allowed-tools: mcp__plugin_agent-chat_agent-chat__unread
---
Call the agent-chat `unread` tool once, with no arguments. It's read-only.

Print a short table, one row per recipient and room: recipient, room, status (joined, closed, left, never joined), unread, delivered, oldest. Below it, list any `unknown_legacy` rows and damaged rooms separately. If there's nothing, say "No unread agent-chat mail."

Don't read, ack, retry or take over anyone's mail. Taking over a closed name's mail only happens when the user explicitly asks this session to join under that exact name. Clearing mail for a closed or never-joined recipient happens only when the user asks for it, with the `dismiss` tool; it marks the mail handled and keeps the room log.
