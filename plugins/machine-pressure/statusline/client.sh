#!/bin/sh
# Claude Code statusLine command for the shared status line. Hands this tab's status JSON to the
# one server (server.mjs, next to this file) and prints its reply. When nothing answers, it starts
# the server and prints a placeholder for this one render.
#
# macOS and Linux talk over a unix socket. On Windows (Git Bash) the server writes
# "<port> <token>" to the endpoint file and this script uses loopback TCP. curl, not nc: macOS nc
# quits when its input ends, before the reply arrives.
D=${SHARED_STATUSLINE_DIR:-$HOME/.cache/shared-statusline}
if [ -f "$D/endpoint" ]; then
  read -r PORT TOKEN <"$D/endpoint"
  curl -sf --max-time 2 -H "X-Token: $TOKEN" -H "X-Config-Dir: ${CLAUDE_CONFIG_DIR:-}" \
    --data-binary @- "http://127.0.0.1:$PORT/" 2>/dev/null && exit 0
else
  curl -sf --max-time 2 --unix-socket "$D/sock" -H "X-Config-Dir: ${CLAUDE_CONFIG_DIR:-}" \
    --data-binary @- http://shared-statusline/ 2>/dev/null && exit 0
fi
mkdir -p "$D"
L="$D/start.lock"
# A lock left by a killed start is stale after a minute.
[ -d "$L" ] && [ -n "$(find "$L" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$L" 2>/dev/null
if mkdir "$L" 2>/dev/null; then
  NODE=${SHARED_STATUSLINE_NODE:-$(command -v node)}
  if [ -n "$NODE" ]; then
    nohup "$NODE" "$(dirname "$0")/server.mjs" </dev/null >>"$D/server.log" 2>&1 &
    sleep 1
  fi
  rmdir "$L"
  [ -n "$NODE" ] || { printf 'shared-statusline: node not found (set SHARED_STATUSLINE_NODE)'; exit 0; }
fi
printf 'statusline starting...'
