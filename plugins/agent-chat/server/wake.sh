#!/bin/sh
# Agent Chat wake waiter, a Claude Code async hook with asyncRewake (SessionStart, Stop and
# StopFailure). It waits while the session is idle. When mail arrives, the server leaves a ring
# file and writes a byte to this waiter's named pipe; the waiter prints the ring's wake text to
# stderr and exits 2, which starts a turn. Exit 0 means nothing to do.
# Idle cost on macOS: one blocked sh, about 1.3 MB and no CPU. Windows runs agent-chat-win.exe wake.
# File layout: wake-ring.mjs and agent-chat-win.exe next to this file.
case $(uname -s) in
  # Windows always wakes through this hook: the native waiter (about 1 MB), else the Node one.
  MINGW*|MSYS*|CYGWIN*)
    [ -x "${0%/*}/agent-chat-win.exe" ] && exec "${0%/*}/agent-chat-win.exe" wake
    command -v node >/dev/null 2>&1 || exit 0
    exec node "${0%/*}/wake-hook.mjs" ;;
esac
[ "$AGENT_CHAT_WAKE" = hook ] || exit 0
pid=$CLAUDE_PID
case $pid in ''|*[!0-9]*) exit 0 ;; esac
kill -0 "$pid" 2>/dev/null || exit 0
# Only an interactive session can be woken; `claude -p` waits for its hooks before it exits.
case $CLAUDE_CODE_ENTRYPOINT in sdk*) exit 0 ;; esac
[ "$CLAUDE_CODE_SESSION_ATTENDED" = 0 ] && exit 0
exec </dev/null
umask 077

dir=${AGENT_CHAT_WAKE_DIR:-${AGENT_CHAT_STATE_ROOT:-$HOME/.local/state/agent-chat}/wake}
mkdir -p "$dir" && chmod 700 "$dir" || exit 0
me=$$
pipe=$dir/pipe-$pid-$me
ring=$dir/ring-$pid
mark=$dir/armed-$pid.json
taken=$dir/taken-$pid-$me

quit() { rm -f "$pipe"; [ "$(sed -n 's/.*"waiter":\([0-9]*\).*/\1/p' "$mark" 2>/dev/null)" = "$me" ] && rm -f "$mark"; exit "${1:-0}"; }
trap 'quit 0' TERM INT HUP

rm -f "$pipe"; mkfifo -m 600 "$pipe" || exit 0
# Open read-write so the pipe always has a reader from here on: a ring sent before the first
# read still lands in the pipe instead of failing with "no reader".
exec 3<>"$pipe"

# Newest waiter wins: take over the mark, then stop the previous waiter.
old=$(sed -n 's/.*"waiter":\([0-9]*\).*/\1/p' "$mark" 2>/dev/null)
printf '{"waiter":%s,"event":null,"at":%s000}\n' "$me" "$(date +%s)" > "$mark.$me.tmp" && mv -f "$mark.$me.tmp" "$mark" || quit 0
[ -n "$old" ] && [ "$old" != "$me" ] && kill -TERM "$old" 2>/dev/null

while :; do
  if mv "$ring" "$taken" 2>/dev/null; then
    text=$(sed -n 1p "$taken"); rm -f "$taken"
    if [ -n "$text" ]; then
      rm -f "$pipe"; [ "$(sed -n 's/.*"waiter":\([0-9]*\).*/\1/p' "$mark" 2>/dev/null)" = "$me" ] && rm -f "$mark"
      printf '%s\n' "$text" >&2
      exit 2
    fi
  fi
  # Blocks with no CPU until the server writes a byte. A signal interrupts it (stderr muted).
  { IFS= read -r _ <&3; } 2>/dev/null || quit 0
  kill -0 "$pid" 2>/dev/null || quit 0
done
