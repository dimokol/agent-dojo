#!/bin/sh
# Runs on every prompt, so Node starts only when there is something to say: unread mail for this
# session, or a failed Claude version check.
state=${AGENT_CHAT_STATE_ROOT:-$HOME/.local/state/agent-chat}
# Gates are session-<id>.<project>.gate, or session-<id>.gate from an older server; any will do.
set -- "$state/notices/session-${CLAUDE_CODE_SESSION_ID:-none}"*.gate
[ -f "$1" ] || [ -f "$state/verification/attention" ] || exit 0
command -v node >/dev/null 2>&1 || exit 0
node "${0%/*}/../server/claude-session-hook.mjs" --flags 2>/dev/null || exit 0
