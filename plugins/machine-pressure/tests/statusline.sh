#!/bin/sh
# Shared status line: client.sh starts server.mjs, renders through it, replaces a dead server
# (its socket or endpoint file left behind) and picks up config changes. Needs node and curl.
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/../statusline
command -v node >/dev/null && command -v curl >/dev/null || { echo "  skip  (needs node and curl)"; exit 0; }
WORK=$(mktemp -d)
: "${WORK:?mktemp failed}"
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1 (got: $2)"; }
has() { case $3 in *"$2"*) ok "$1" ;; *) bad "$1 want *$2*" "$3" ;; esac; }

# Unix socket paths are limited to ~104 bytes, so the state dir sits in a short temp path.
export SHARED_STATUSLINE_DIR="$WORK/s" SHARED_STATUSLINE_CONFIG="$WORK/config.json" NO_COLOR=1
mkdir -p "$WORK/bin"
sh "$SRC/install.sh" "$WORK/bin" >/dev/null
# The server is a native process; on Windows (Git Bash) only taskkill reaches it by its pid.
stop_server() {
  [ -f "$WORK/s/server.pid" ] || return 0
  pid=$(cat "$WORK/s/server.pid"); rm -f "$WORK/s/server.pid"
  if command -v taskkill >/dev/null 2>&1; then taskkill //F //PID "$pid" >/dev/null 2>&1; else kill -9 "$pid" 2>/dev/null; fi
  sleep 0.3
}
up() { [ -S "$WORK/s/sock" ] || [ -f "$WORK/s/endpoint" ]; }
cleanup() { stop_server; rm -rf "${WORK:?}"; }
trap cleanup EXIT

NOW=$(date +%s)
INPUT=$(printf '{"session_id":"x","model":{"display_name":"Test Model"},"cwd":"%s","context_window":{"current_usage":{"input_tokens":1500,"cache_read_input_tokens":0}},"rate_limits":{"five_hour":{"used_percentage":12.5,"resets_at":%s}}}' "$HERE" $((NOW + 3700)))
render() { printf '%s' "$INPUT" | sh "$WORK/bin/client.sh"; }

echo "== first render starts the server"
out=$(render); has "placeholder while starting" "starting" "$out"
i=0; while ! up && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done
i=0; while [ ! -f "$WORK/s/server.pid" ] && [ $i -lt 20 ]; do sleep 0.1; i=$((i+1)); done
out=$(render)
has "model" "Test Model" "$out"
has "context tokens" "1.5k" "$out"
has "five-hour usage" "12.5%" "$out"
has "five-hour reset" "1hr 1m" "$out"
has "pressure row" "pressure " "$out"

echo "== config is reread when it changes"
printf '{"lines":[[{"type":"text","text":"hello"},"model"]]}' >"$WORK/config.json"
out=$(render); has "custom layout" "hello | Test Model" "$out"
case $out in *pressure*) bad "pressure row gone" "$out" ;; *) ok "pressure row gone" ;; esac
printf '{"lines":' >"$WORK/config.json"
out=$(render); has "broken config named" "shared-statusline config:" "$out"
rm -f "$WORK/config.json"

echo "== a dead server's socket or endpoint file is replaced"
stop_server; up && ok "dead server left its socket or endpoint" || bad "dead server left its socket" "-"
out=$(render); has "placeholder after crash" "starting" "$out"
i=0; out=""; while [ $i -lt 30 ]; do out=$(render); case $out in *Test*) break ;; esac; sleep 0.1; i=$((i+1)); done
has "renders again" "Test Model" "$out"

echo "== timing"
start=$(node -e 'console.log(Date.now())')
n=0; while [ $n -lt 20 ]; do render >/dev/null; n=$((n+1)); done
end=$(node -e 'console.log(Date.now())')
echo "  info  $(( (end - start) / 20 )) ms per render (20 renders)"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
