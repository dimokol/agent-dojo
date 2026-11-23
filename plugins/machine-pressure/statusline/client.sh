#!/bin/sh
# Claude Code statusLine command for the shared status line. Hands this tab's status JSON to the
# one server (server.mjs, next to this file) and prints its reply. When nothing answers, it starts
# the server and prints a placeholder; the next render gets the real lines. After two starts in a
# row with no render getting through, it says the server failed and names the log.
#
# macOS and Linux talk over a unix socket. On Windows (Git Bash) the server writes
# "<port> <token>" to the endpoint file and this script uses loopback TCP. curl, not nc: macOS nc
# quits when its input ends, before the reply arrives.
#
# Per tab, sent with each request: CLAUDE_CONFIG_DIR, and in X-Env the tab's AGENT_CHAT_ROOT,
# AGENT_CHAT_STATE_ROOT and pressure thresholds, so tabs of different profiles each get their own.
#
# Every process start costs 25 to 30 ms under Git Bash, so a render starts only curl: X-Env is
# built with builtins, and stdin goes straight to curl. A value needs one sed only when it holds
# % & + or a space, which in practice means a path with a space.
D=${SHARED_STATUSLINE_DIR:-$HOME/.cache/shared-statusline}
XENV=
for k in AGENT_CHAT_ROOT AGENT_CHAT_STATE_ROOT; do
  eval "v=\${$k:-}"
  [ -n "$v" ] || continue
  case $v in *[%\&+\ ]*) v=$(printf '%s' "$v" | sed 's/%/%25/g; s/&/%26/g; s/+/%2B/g; s/ /%20/g') ;; esac
  XENV="$XENV$k=$v&"
done
for t in CPU_AMBER CPU_RED RAM_AMBER RAM_RED SWAP_AMBER SWAP_RED DISK_AMBER_GB DISK_RED_GB LOAD_AMBER_X LOAD_RED_X; do
  for k in CLAUDE_PLUGIN_OPTION_$t MACHINE_PRESSURE_$t; do
    eval "v=\${$k:-}"
    case $v in ''|*[!0-9.]*) ;; *) XENV="$XENV$k=$v&" ;; esac
  done
done

ask() { # reads the status JSON from stdin
  if [ -f "$D/endpoint" ]; then
    read -r PORT TOKEN <"$D/endpoint"
    curl -sf --max-time 2 -H "X-Token: $TOKEN" -H "X-Config-Dir: ${CLAUDE_CONFIG_DIR:-}" \
      -H "X-Env: $XENV" --data-binary @- "http://127.0.0.1:$PORT/" 2>/dev/null
  else
    curl -sf --max-time 2 --unix-socket "$D/sock" -H "X-Config-Dir: ${CLAUDE_CONFIG_DIR:-}" \
      -H "X-Env: $XENV" --data-binary @- http://shared-statusline/ 2>/dev/null
  fi
}
FAILS="$D/start-fails"
if ask; then [ -f "$FAILS" ] && rm -f "$FAILS"; exit 0; fi

mkdir -p "$D"
LOG="$D/server.log"
L="$D/start.lock"
# A lock left by a killed start is stale after a minute.
[ -d "$L" ] && [ -n "$(find "$L" -maxdepth 0 -mmin +1 2>/dev/null)" ] && rmdir "$L" 2>/dev/null
if mkdir "$L" 2>/dev/null; then
  NODE=${SHARED_STATUSLINE_NODE:-$(command -v node)}
  if [ -z "$NODE" ]; then
    rmdir "$L"; printf 'shared-statusline: node not found (set SHARED_STATUSLINE_NODE)'; exit 0
  fi
  # Bounded: one 1 MB log plus one older copy.
  [ -n "$(find "$LOG" -size +1024k 2>/dev/null)" ] && mv -f "$LOG" "$LOG.1"
  case "$(uname -s 2>/dev/null)" in
    # node.exe is a native process: msys hangups don't reach it, and nohup would only leave a
    # nohup.exe parent running for as long as the server lives.
    MINGW*|MSYS*|CYGWIN*) "$NODE" "$(dirname "$0")/server.mjs" </dev/null >>"$LOG" 2>&1 & ;;
    *) nohup "$NODE" "$(dirname "$0")/server.mjs" </dev/null >>"$LOG" 2>&1 & ;;
  esac
  sleep 1
  rmdir "$L"
  # stdin went to the first curl, so there's nothing to re-send: count this start as failed until
  # a render gets through (that removes the file). Two in a row means the server can't start.
  n=; [ -f "$FAILS" ] && read -r n <"$FAILS"; n=$(( ${n:-0} + 1 )); echo "$n" >"$FAILS"
fi
n=; [ -f "$FAILS" ] && read -r n <"$FAILS"
if [ "${n:-0}" -ge 2 ]; then
  P=$LOG; command -v cygpath >/dev/null 2>&1 && P=$(cygpath -m "$LOG")
  printf 'shared-statusline: server failed, see %s' "$P"
else
  printf 'statusline starting...'
fi
