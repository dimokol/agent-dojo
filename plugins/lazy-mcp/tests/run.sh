#!/usr/bin/env bash
# lazy-mcp against a fake MCP server: the cache fills once, the handshake and lists are answered
# without starting the server, and the first tools/call starts it and gets its reply.
# Needs bash, jq and node.
HERE=$(cd "$(dirname "$0")" && pwd)
SHIM=$HERE/../skills/lazy-mcp/lazy-mcp.sh
for t in jq node; do command -v $t >/dev/null || { echo "skip (needs $t)"; exit 0; }; done
WORK=$(mktemp -d); : "${WORK:?}"; trap 'rm -rf "${WORK:?}"' EXIT
export LAZY_MCP_GRACE=1 LAZY_MCP_CACHE=$WORK/cache LAZY_MCP_LOG=$WORK/lazy.log FAKE_LOG=$WORK/starts
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1 (got: $2)"; }
eq() { if [ "$2" = "$3" ]; then ok "$1"; else bad "$1 want=$2" "$3"; fi; }
starts() { [ -f "$FAKE_LOG" ] && wc -l <"$FAKE_LOG" | tr -d ' ' || echo 0; }
INIT='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'

session() { # stdin: request lines; keeps stdin open briefly so replies can arrive
  { cat; sleep "${HOLD:-0.2}"; } | bash "$SHIM" fake -- node "$HERE/fake-server.mjs"
}

run_suite() {
  rm -rf "$WORK/cache" "$FAKE_LOG"
  echo "== handshake from the cache (${LAZY_MCP_TRANSPORT:-fifo})"
  out=$(printf '%s\n' '{"jsonrpc":"2.0","id":0,"method":"server/discover"}' "$INIT" \
    '{"jsonrpc":"2.0","method":"notifications/initialized"}' '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
    '{"jsonrpc":"2.0","id":3,"method":"ping"}' '{"jsonrpc":"2.0","id":4,"method":"prompts/list"}' | session)
  eq "prime started the server once" 1 "$(starts)"
  eq "server/discover is method not found" -32601 "$(sed -n 1p <<<"$out" | jq .error.code)"
  eq "initialize echoes the client's protocol" '"2025-11-25"' "$(sed -n 2p <<<"$out" | jq .result.protocolVersion)"
  eq "tools/list from the cache" '"echo"' "$(sed -n 3p <<<"$out" | jq '.result.tools[0].name')"
  eq "ping answered" '{}' "$(sed -n 4p <<<"$out" | jq -c .result)"
  eq "prompts/list empty default" '[]' "$(sed -n 5p <<<"$out" | jq -c .result.prompts)"
  out=$(printf '%s\n' "$INIT" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | session)
  eq "a second session starts nothing" 1 "$(starts)"

  echo "== first tool call starts the server"
  out=$(printf '%s\n' "$INIT" '{"jsonrpc":"2.0","id":"c1","method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}' \
    '{"jsonrpc":"2.0","id":"c2","method":"tools/call","params":{"name":"echo","arguments":{"text":"again"}}}' | HOLD=1.5 session)
  eq "server started for the call" 2 "$(starts)"
  eq "call reply passed through" '"echo:hi"' "$(grep '"c1"' <<<"$out" | jq '.result.content[0].text')"
  eq "later calls go straight through" '"echo:again"' "$(grep '"c2"' <<<"$out" | jq '.result.content[0].text')"
  eq "no handshake replies leak to the client" 0 "$(grep -c lazy- <<<"$out")"
}

run_suite
if [ "${BASH_VERSINFO[0]}" -ge 4 ]; then LAZY_MCP_TRANSPORT=coproc run_suite; else echo "== coproc: skipped (bash $BASH_VERSION)"; fi

echo "== a broken server runs directly"
out=$(printf '%s\n' "$INIT" | bash "$SHIM" broken -- sh -c 'read l; echo direct' 2>/dev/null)
eq "falls back to the plain command" direct "$out"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
