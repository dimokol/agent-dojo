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
# Without jq, or when the cache can't be filled, it runs the real server directly.
set -u
NAME=${1:?usage: lazy-mcp.sh <name> -- <command> [args...]}; shift; [ "${1:-}" = "--" ] && shift
[ $# -gt 0 ] || { echo "lazy-mcp: no command after --" >&2; exit 2; }

KEY=$(printf '%s\0' "$@" | cksum | cut -d' ' -f1)
CACHE="${LAZY_MCP_CACHE:-$HOME/.cache/lazy-mcp}/$NAME-$KEY"
case "$(uname -s 2>/dev/null)" in
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

# Starts the real server with its stdin on fd 3 and its stdout on fd 4. Named pipes where mkfifo
# works (macOS, Linux); otherwise a bash 4+ coproc (Git Bash on Windows). LAZY_MCP_TRANSPORT=coproc
# forces the coproc path.
start_real() {
  if [ "${LAZY_MCP_TRANSPORT:-}" != coproc ] && mkfifo "$TMP/in" "$TMP/out" 2>/dev/null; then
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
  log "no mkfifo and no coproc (bash ${BASH_VERSION})"
  return 1
}
stop_real() {
  exec 3>&- 4<&-
  kill "$REAL_PID" 2>/dev/null; wait "$REAL_PID" 2>/dev/null; REAL_PID=""
}

await_id() { # print the response line carrying id $1 (other lines are dropped)
  local line
  while IFS= read -r -t 30 line <&4; do
    line=${line%$'\r'}
    [[ "$line" =~ $ID_RE ]] && [ "${BASH_REMATCH[1]}" = "\"$1\"" ] && { printf '%s\n' "$line"; return 0; }
  done
  return 1
}

save_result() { # $1 file, stdin a response line; keeps only .result
  jq -c '.result // empty' >"$CACHE/$1.tmp" 2>/dev/null && [ -s "$CACHE/$1.tmp" ] && mv -f "$CACHE/$1.tmp" "$CACHE/$1" || rm -f "$CACHE/$1.tmp"
}

refresh_lists() { # ask a running, initialized server for its lists and cache them
  local caps; caps=$(jq -c '.capabilities // {}' "$CACHE/init.json" 2>/dev/null)
  printf '{"jsonrpc":"2.0","id":"lazy-tools","method":"tools/list","params":{}}\n' >&3
  await_id lazy-tools | save_result tools.json
  if [[ "$caps" == *'"resources"'* ]]; then
    printf '{"jsonrpc":"2.0","id":"lazy-res","method":"resources/list","params":{}}\n' >&3
    await_id lazy-res | save_result resources.json
    printf '{"jsonrpc":"2.0","id":"lazy-rtpl","method":"resources/templates/list","params":{}}\n' >&3
    await_id lazy-rtpl | save_result templates.json
  fi
  if [[ "$caps" == *'"prompts"'* ]]; then
    printf '{"jsonrpc":"2.0","id":"lazy-prompts","method":"prompts/list","params":{}}\n' >&3
    await_id lazy-prompts | save_result prompts.json
  fi
}

init_real() { # $1: the client's initialize line (id rewritten)
  local line; line=$(printf '%s' "$1" | jq -c '.id = "lazy-init"')
  printf '%s\n' "$line" >&3
  await_id lazy-init | save_result init.json || return 1
  printf '{"jsonrpc":"2.0","method":"notifications/initialized"}\n' >&3
}

prime() { # no cache yet: run the real server once to fill it
  log "prime"
  start_real "$@" || return 1
  init_real "$DEFAULT_INIT" && refresh_lists
  stop_real
}

if [ ! -s "$CACHE/init.json" ] || [ ! -s "$CACHE/tools.json" ] || [ -n "$(find "$CACHE/tools.json" -mtime +7 2>/dev/null)" ]; then
  prime "$@"
fi
if [ ! -s "$CACHE/init.json" ] || [ ! -s "$CACHE/tools.json" ]; then
  log "prime failed, running the server directly"; run_direct "$@"
fi

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
    server/discover) printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32601,"message":"Method not found"}}\n' "$id"; continue ;;
    ping) reply "$id" '{}'; continue ;;
    tools/list) reply "$id" "$(cat "$CACHE/tools.json")"; continue ;;
    resources/list) reply "$id" "$(cached resources.json '{"resources":[]}')"; continue ;;
    resources/templates/list) reply "$id" "$(cached templates.json '{"resourceTemplates":[]}')"; continue ;;
    prompts/list) reply "$id" "$(cached prompts.json '{"prompts":[]}')"; continue ;;
  esac
  # First real request: start the server, replay the handshake, then pass everything through.
  log "start on $method"
  start_real "$@" || run_direct "$@"
  if init_real "${INIT_LINE:-$DEFAULT_INIT}"; then refresh_lists; else log "real init failed"; fi
  printf '%s\n' "$line" >&3
  cat <&4 3>&- &     # server -> client (must not hold the server's stdin open)
  cat >&3             # client -> server, until the client closes stdin
  exec 3>&-
  # Not every server exits when its stdin closes: give it a grace period, then stop it.
  for ((i = 0; i < ${LAZY_MCP_GRACE:-5} * 10; i++)); do kill -0 "$REAL_PID" 2>/dev/null || break; sleep 0.1; done
  exit 0 # the EXIT trap stops the server if it's still there
done
