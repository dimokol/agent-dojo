#!/usr/bin/env bash
# lazy-mcp: start a stdio MCP server only when a tool is actually called.
#
# Claude Code starts every configured MCP server in every session. A server most sessions never use
# still costs its full memory in each tab (25 to 100 MB for typical Node or Python servers). This
# shim, a bash process of about 2 MB, answers the handshake, tools/list, resources/list,
# prompts/list and ping from a cache. On the first other request (a tools/call) it starts the real
# server, replays the handshake to it, and from then on passes every line through.
#
# Usage in an MCP config:
#   "command": "<path>/lazy-mcp.sh", "args": ["<name>", "--", "<real command>", "<args>"...]
# On Windows "command" is Git Bash's bash.exe and the script path goes first in "args".
#
# Cache: ~/.cache/lazy-mcp/<name>-<checksum of the command>/. It's filled by running the real
# server once when missing or older than 7 days, and refreshed every time the real server starts.
# Log: one line per start, never message contents. ~/Library/Logs/lazy-mcp.log on macOS,
# $XDG_STATE_HOME/lazy-mcp/lazy-mcp.log on Linux, %LOCALAPPDATA%\lazy-mcp\lazy-mcp.log on Windows,
# or $LAZY_MCP_LOG. LAZY_MCP_TRACE=1 also logs each method name.
# Without jq, or when the cache can't be filled, it runs the real server directly. A failed fill
# leaves a prime-failed marker, and for the next 24 hours the shim runs the server directly
# without trying again.
set -u
NAME=${1:?usage: lazy-mcp.sh <name> -- <command> [args...]}; shift; [ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "lazy-mcp: no command after --" >&2; exit 2; }
PARENT=$PPID

KEY=$(printf '%s\0' "$@" | cksum | cut -d' ' -f1)
CACHE="${LAZY_MCP_CACHE:-$HOME/.cache/lazy-mcp}/$NAME-$KEY"
OS=${LAZY_MCP_UNAME:-$(uname -s 2>/dev/null)} # LAZY_MCP_UNAME: tests only
case "$OS" in
  Darwin) LOGDIR="$HOME/Library/Logs" ;;
  MINGW*|MSYS*|CYGWIN*) LOGDIR="${LOCALAPPDATA:-$HOME/AppData/Local}/lazy-mcp" ;;
  *) LOGDIR="${XDG_STATE_HOME:-$HOME/.local/state}/lazy-mcp" ;;
esac
LOG=${LAZY_MCP_LOG:-$LOGDIR/lazy-mcp.log}
mkdir -p "$CACHE" "$(dirname "$LOG")" 2>/dev/null
log() {
  # Bounded: one 1 MB file plus one older copy.
  [ -n "$(find "$LOG" -size +1024k 2>/dev/null)" ] && mv -f "$LOG" "$LOG.1"
  printf '%s %s[%s] %s\n' "$(date '+%F %T')" "$NAME" "$$" "$*" >>"$LOG" 2>/dev/null
}

# A server that dies mid-handshake must not kill the shim with SIGPIPE; the real server and any
# direct exec get the default back.
trap '' PIPE
run_direct() { trap - PIPE EXIT; rm -rf "${TMP:-/nonexistent}"; exec "$@"; }

if ! command -v jq >/dev/null 2>&1; then log "jq not found, running the server directly"; run_direct "$@"; fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/lazy-mcp.XXXXXX")
REAL_PID=""
cleanup() { [ -n "$REAL_PID" ] && kill "$REAL_PID" 2>/dev/null; rm -rf "$TMP"; }
trap cleanup EXIT

PROTO_RE='"protocolVersion"[[:space:]]*:[[:space:]]*"([^"]+)"'
ID_RE='"id"[[:space:]]*:[[:space:]]*("[^"]*"|-?[0-9]+)'
METHOD_RE='"method"[[:space:]]*:[[:space:]]*"([^"]+)"'
DEFAULT_INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"lazy-mcp","version":"1"}}}'

# Starts the real server with its stdin on fd 3 and its stdout on fd 4. Named pipes on macOS and
# Linux. On Git Bash, Cygwin and MSYS a bash 4+ coproc: mkfifo works there, but the fifo is an
# msys object that a native Windows server (node.exe, python.exe) can't open, so every write
# fails. LAZY_MCP_TRANSPORT=fifo|coproc overrides the choice.
case "${LAZY_MCP_TRANSPORT:-}" in
  fifo|coproc) TRANSPORT=$LAZY_MCP_TRANSPORT ;;
  *) case "$OS" in MINGW*|MSYS*|CYGWIN*) TRANSPORT=coproc ;; *) TRANSPORT=fifo ;; esac ;;
esac
start_real() {
  if [ "$TRANSPORT" = fifo ] && mkfifo "$TMP/in" "$TMP/out" 2>/dev/null; then
    (trap - PIPE; exec "$@") <"$TMP/in" >"$TMP/out" &
    REAL_PID=$!
    disown "$REAL_PID" 2>/dev/null # no "Terminated" job notice when it's stopped
    exec 3>"$TMP/in" 4<"$TMP/out"
    rm -f "$TMP/in" "$TMP/out"
    return 0
  fi
  if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then
    # eval: bash 3.2 (macOS /bin/bash) can't even parse coproc.
    eval 'coproc LAZY_REAL { trap - PIPE; exec "$@"; }'
    eval 'REAL_PID=$LAZY_REAL_PID; exec 3>&"${LAZY_REAL[1]}" 4<&"${LAZY_REAL[0]}"'
    return 0
  fi
  log "transport $TRANSPORT unavailable (bash ${BASH_VERSION})"
  return 1
}
stop_real() {
  exec 3>&- 4<&-
  kill "$REAL_PID" 2>/dev/null; wait "$REAL_PID" 2>/dev/null; REAL_PID=""
}

# One deadline for a whole exchange (DEADLINE, in $SECONDS), not one per read: Claude Code waits a
# limited time for the shim's first reply, and priming runs before that reply.
await_id() { # print the response line carrying id $1 (other lines are dropped)
  local line left
  while left=$((DEADLINE - SECONDS)); [ "$left" -gt 0 ] && IFS= read -r -t "$left" line <&4; do
    line=${line%$'\r'}
    [[ "$line" =~ $ID_RE ]] && [ "${BASH_REMATCH[1]}" = "\"$1\"" ] && { printf '%s\n' "$line"; return 0; }
  done
  return 1
}

save_result() { # $1 file, stdin a response line; keeps only .result. Fails when there was none.
  jq -c '.result // empty' >"$CACHE/$1.tmp.$$" 2>/dev/null && [ -s "$CACHE/$1.tmp.$$" ] && mv -f "$CACHE/$1.tmp.$$" "$CACHE/$1" && return 0
  rm -f "$CACHE/$1.tmp.$$"; return 1
}

# Writes one line to the server. In a subshell: when the server is gone the write fails, and bash
# would keep the unwritten bytes in its printf buffer and flush them into the next output (the log).
send() { (printf '%s\n' "$1" >&3) 2>/dev/null; }

refresh_lists() { # ask a running, initialized server for its lists and cache them
  local caps; caps=$(jq -c '.capabilities // {}' "$CACHE/init.json" 2>/dev/null)
  send '{"jsonrpc":"2.0","id":"lazy-tools","method":"tools/list","params":{}}' || return 1
  await_id lazy-tools | save_result tools.json
  if [[ "$caps" == *'"resources"'* ]]; then
    send '{"jsonrpc":"2.0","id":"lazy-res","method":"resources/list","params":{}}'
    await_id lazy-res | save_result resources.json
    send '{"jsonrpc":"2.0","id":"lazy-rtpl","method":"resources/templates/list","params":{}}'
    await_id lazy-rtpl | save_result templates.json
  fi
  if [[ "$caps" == *'"prompts"'* ]]; then
    send '{"jsonrpc":"2.0","id":"lazy-prompts","method":"prompts/list","params":{}}'
    await_id lazy-prompts | save_result prompts.json
  fi
}

init_real() { # $1: the client's initialize line (id rewritten)
  local line; line=$(printf '%s' "$1" | jq -c '.id = "lazy-init"')
  send "$line" || return 1
  await_id lazy-init | save_result init.json || return 1
  send '{"jsonrpc":"2.0","method":"notifications/initialized"}'
}

prime() { # no cache yet: run the real server once to fill it
  log "prime ($TRANSPORT)"
  DEADLINE=$((SECONDS + ${LAZY_MCP_PRIME_TIMEOUT:-10}))
  start_real "$@" || return 1
  init_real "$DEFAULT_INIT" && refresh_lists
  stop_real
}

complete() { [ -s "$CACHE/init.json" ] && [ -s "$CACHE/tools.json" ]; }
FAILED="$CACHE/prime-failed"
if ! complete && [ -n "$(find "$FAILED" -mmin -1440 2>/dev/null)" ]; then
  log "prime failed within the last day, running the server directly"; run_direct "$@"
fi
if ! complete || [ -n "$(find "$CACHE/tools.json" -mtime +7 2>/dev/null)" ]; then
  prime "$@"
fi
if ! complete; then
  touch "$FAILED"
  log "prime failed, running the server directly (no retry for 24 h; delete $FAILED to retry now)"; run_direct "$@"
fi
rm -f "$FAILED"

reply() { printf '{"jsonrpc":"2.0","id":%s,"result":%s}\n' "$1" "$2"; }
cached() { if [ -s "$CACHE/$1" ]; then cat "$CACHE/$1"; else printf '%s' "$2"; fi; }

INIT_LINE=""
while IFS= read -r line; do
  line=${line%$'\r'}
  [[ "$line" =~ $METHOD_RE ]] || continue # responses to server requests can't happen before start
  method=${BASH_REMATCH[1]}
  [ -n "${LAZY_MCP_TRACE:-}" ] && log "recv $method"
  id=""; [[ "$line" =~ $ID_RE ]] && id=${BASH_REMATCH[1]}
  case "$method" in
    initialize)
      INIT_LINE=$line
      proto=""; [[ "$line" =~ $PROTO_RE ]] && proto=${BASH_REMATCH[1]}
      res=$(cat "$CACHE/init.json"); [ -n "$proto" ] && res=$(printf '%s' "$res" | jq -c --arg p "$proto" '.protocolVersion = $p')
      reply "$id" "$res"; continue ;;
    notifications/*) continue ;;
    # Claude Code probes the newer stateless handshake first and falls back to initialize when a
    # server answers "method not found", which is what most servers answer today.
    server/discover)
      [ -n "$id" ] || continue # without an id it's a notification: no reply
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id"; continue ;;
    ping) reply "$id" '{}'; continue ;;
    tools/list) reply "$id" "$(cat "$CACHE/tools.json")"; continue ;;
    resources/list) reply "$id" "$(cached resources.json '{"resources":[]}')"; continue ;;
    resources/templates/list) reply "$id" "$(cached templates.json '{"resourceTemplates":[]}')"; continue ;;
    prompts/list) reply "$id" "$(cached prompts.json '{"prompts":[]}')"; continue ;;
  esac
  # First real request: start the server, replay the handshake, then pass everything through.
  log "start on $method ($TRANSPORT)"
  DEADLINE=$((SECONDS + 30))
  start_real "$@" || run_direct "$@"
  if init_real "${INIT_LINE:-$DEFAULT_INIT}"; then refresh_lists; else log "real init failed"; fi
  send "$line"
  cat <&4 3>&- &       # server -> client (must not hold the server's stdin open)
  OUT_PID=$!
  cat <&0 >&3 4<&- &   # client -> server, until the client closes stdin
  IN_PID=$!
  # A parent killed outright (taskkill /F on claude.exe) may leave stdin open in another process,
  # so EOF never comes. Watch the parent too. PID 1 means it's unknown (a native Windows parent).
  if [ "$PARENT" -gt 1 ]; then
    ( while kill -0 "$PARENT" 2>/dev/null; do sleep 2; done
      log "parent $PARENT gone, stopping"; kill "$IN_PID" "$OUT_PID" "$REAL_PID" 2>/dev/null ) &
    WATCH_PID=$!
    disown "$WATCH_PID" 2>/dev/null
  fi
  wait "$IN_PID"
  exec 3>&-
  [ -n "${WATCH_PID:-}" ] && kill "$WATCH_PID" 2>/dev/null
  # Not every server exits when its stdin closes: give it a grace period, then stop it.
  for ((i = 0; i < ${LAZY_MCP_GRACE:-5} * 10; i++)); do kill -0 "$REAL_PID" 2>/dev/null || break; sleep 0.1; done
  exit 0 # the EXIT trap stops the server if it's still there
done
