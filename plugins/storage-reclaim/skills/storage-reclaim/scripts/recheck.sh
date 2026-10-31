#!/usr/bin/env zsh
# storage-reclaim: the delete-time re-check. Run it on a row's paths right before deleting them.
#
# Usage: zsh recheck.sh [--rm] [--] PATH...
#   Without --rm it only reports. With --rm it deletes every path that passes and prints, per path,
#   the size du measured and what df gained, then free space before and after.
#   Exit 0 when every path passed (or went), 1 when any was held.
#
# A path is held when:
#   - a process has a file open under it, or its cwd is inside it;
#   - a command line names it, or (for a path inside a git repo) a process that isn't an agent CLI
#     has its cwd in that repo or a command line names the repo;
#   - it is an app's cache (apps.tsv in the keep-lists folder) and the app runs;
#   - it matches never-touch.txt.
# This script's own process chain, up to the agent that ran it, is left out: its command lines
# name the very paths being checked.

emulate -L zsh
setopt null_glob extended_glob

do_rm=0
while (( $# )); do
  case $1 in
    --rm) do_rm=1; shift ;;
    --) shift; break ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) break ;;
  esac
done
(( $# )) || { print -u2 "usage: zsh recheck.sh [--rm] [--] PATH..."; exit 2; }

conf="${XDG_CONFIG_HOME:-$HOME/.config}/storage-reclaim"
vol=$HOME; [[ -d /System/Volumes/Data ]] && vol=/System/Volumes/Data
freek() { df -k "$vol" | awk 'NR == 2 { print $4 }'; }
gb() { awk -v b="$1" 'BEGIN { printf "%.2f", b / 1e9 }'; }
tilde() { print -r -- "${1/#$HOME/~}"; }

typeset -A PPIDOF PCMD PCWD SELF AGENT
for l in ${(f)"$(ps -axo pid=,ppid=,command= 2>/dev/null)"}; do
  l=${l## #}; pid=${l%% *}; l=${l#* }; l=${l## #}; PPIDOF[$pid]=${l%% *}; PCMD[$pid]=${l#* }
done
# An empty or failed process list would turn every in-use check off: stop instead.
(( ${#PCMD} >= 5 )) || { print -u2 "ps listed only ${#PCMD} processes; without a process list nothing can be checked for use, so nothing is deleted."; exit 1; }
p=$$; while [[ -n $p && $p != (0|1) && -z ${SELF[$p]} ]]; do SELF[$p]=1; p=${PPIDOF[$p]}; done
for pid in ${(k)PCMD}; do c=${${PCMD[$pid]}%% *}; [[ ${c:t} == (claude|codex) ]] && AGENT[$pid]=1; done
for pid in ${(k)PCMD}; do
  c=${${PCMD[$pid]}%% *}; [[ -n ${AGENT[${PPIDOF[$pid]}]} && ${c:t} == (-|)(zsh|bash|sh|fish) ]] && AGENT[$pid]=1
done
for l in ${(f)"$(lsof -a -d cwd -Fpn 2>/dev/null)"}; do
  case $l in p*) pid=${l#p} ;; n*) PCWD[$pid]=${l#n} ;; esac
done
# Open files, by process, without this script's chain (about 30 s on a busy machine).
open=$(lsof -Fpn 2>/dev/null | awk -v self=" ${(k)SELF} " '
  /^p/ { skip = index(self, " " substr($0, 2) " ") > 0; next }
  /^n/ && !skip { print substr($0, 2) }')

typeset -a NEVER APPDIR APPBUN
if [[ -f $conf/never-touch.txt ]]; then
  while IFS=$'\t' read -r e _; do
    [[ -z $e || $e == \#* ]] && continue
    e=${e/#\~/$HOME}; while [[ $e == ?*/ ]]; do e=${e%/}; done; NEVER+=("$e")
  done < "$conf/never-touch.txt"
fi
if [[ -f $conf/apps.tsv ]]; then
  while IFS=$'\t' read -r e a _; do
    [[ -z $e || $e == \#* || -z $a ]] && continue
    [[ $e == [~/]* ]] || e="~/Library/Caches/$e"
    APPDIR+=("${e/#\~/$HOME}"); APPBUN+=("$a")
  done < "$conf/apps.tsv"
fi

why() {  # why PATH: REPLY = the reason PATH is held, empty when it may go
  local p=$1 e i pid top g
  REPLY=
  for e in $NEVER; do
    if [[ $e == *[*?]* ]]; then
      g=${e//(#m)[\#\(\)\|\~\^\[\]\<\>]/\\$MATCH}
      [[ $p == ${~g} || $p == ${~g}/* ]] && { REPLY="never-touch ($e)"; return; }
    else
      [[ $p == "$e" || $p == "$e"/* || $e == "$p"/* ]] && { REPLY="never-touch ($(tilde "$e"))"; return; }
    fi
  done
  e=$(print -r -- "$open" | awk -v p="$p" '$0 == p || index($0, p "/") == 1 { print; exit }')
  [[ -n $e ]] && { REPLY="open: $e"; return; }
  for pid in ${(k)PCWD}; do
    [[ -n ${SELF[$pid]} ]] && continue
    [[ ${PCWD[$pid]} == "$p" || ${PCWD[$pid]} == "$p"/* ]] && { REPLY="cwd of pid $pid: ${${PCMD[$pid]}[1,80]}"; return; }
  done
  for pid in ${(k)PCMD}; do
    [[ -n ${SELF[$pid]} ]] && continue
    [[ ${PCMD[$pid]} == *${(b)p}(|[/ \"\']*) ]] && { REPLY="named by pid $pid: ${${PCMD[$pid]}[1,80]}"; return; }
  done
  for (( i = 1; i <= $#APPDIR; i++ )); do
    [[ $p == "${APPDIR[i]}" || $p == "${APPDIR[i]}"/* || ${APPDIR[i]} == "$p"/* ]] || continue
    for pid in ${(k)PCMD}; do
      [[ ${PCMD[$pid]} == */${APPBUN[i]}/Contents/MacOS/* && ${PCMD[$pid]} != *--user-data-dir=* ]] \
        && { REPLY="${APPBUN[i]%.app} is running (pid $pid); quit it first"; return; }
    done
  done
  # Build output inside a repo: a dev server or watcher started in the repo may be using it.
  if top=$(git -C "${p:h}" rev-parse --show-toplevel 2>/dev/null) && [[ $top != $p ]]; then
    for pid in ${(k)PCWD}; do
      [[ -n ${SELF[$pid]}${AGENT[$pid]} ]] && continue
      [[ ${PCWD[$pid]} == "$top" || ${PCWD[$pid]} == "$top"/* ]] && { REPLY="runs in $(tilde "$top"), pid $pid: ${${PCMD[$pid]}[1,80]}"; return; }
    done
    for pid in ${(k)PCMD}; do
      [[ -n ${SELF[$pid]}${AGENT[$pid]} ]] && continue
      [[ ${PCMD[$pid]} == *"$top"/* ]] && { REPLY="names $(tilde "$top"), pid $pid: ${${PCMD[$pid]}[1,80]}"; return; }
    done
  fi
}

f0=$(freek); bad=0
for p in "$@"; do
  p=${p/#\~/$HOME}; while [[ $p == ?*/ ]]; do p=${p%/}; done
  [[ -e $p || -L $p ]] || { print -r -- "gone   $(tilde "$p")"; continue; }
  p=${p:a}
  why "$p"
  if [[ -n $REPLY ]]; then print -r -- "HELD   $(tilde "$p")  ($REPLY)"; bad=1; continue; fi
  if (( ! do_rm )); then print -r -- "ok     $(tilde "$p")"; continue; fi
  k=$(du -xsk "$p" 2>/dev/null | awk '{ print $1 }'); b=$(freek)
  rm -rf -- "$p" 2>/dev/null || { chmod -R u+w -- "$p" 2>/dev/null; rm -rf -- "$p" 2>/dev/null; }
  a=$(freek)
  if [[ -e $p ]]; then print -r -- "PARTLY $(tilde "$p")  (still there after chmod -R u+w; check permissions)"; bad=1
  else print -r -- "freed  $(tilde "$p")  du $(gb $(( ${k:-0} * 1024 ))) GB, df +$(gb $(( (a - b) * 1024 ))) GB"; fi
done
(( do_rm )) && print -r -- "free on $vol: $(gb $(( f0 * 1024 ))) → $(gb $(( $(freek) * 1024 ))) GB"
exit $bad
