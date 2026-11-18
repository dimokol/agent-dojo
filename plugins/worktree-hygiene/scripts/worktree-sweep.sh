#!/usr/bin/env bash
# worktree-sweep: removes git worktrees and local branches whose work already lives on a remote, so
# merged worktrees (each with its own node_modules) don't pile up.
#
# A worktree is removed only when ALL of these hold:
#   - git status is empty (no changes, no untracked files)
#   - HEAD is reachable from a remote branch after a successful fetch (pushed or merged)
#   - no process has its working directory inside it (lsof, or /proc on Linux; Windows has
#     neither, and there a process holding files open makes the removal fail instead)
#   - nothing outside node_modules changed for IDLE minutes (protects a worktree a session just
#     made and drives by absolute paths)
#   - every ignored file is a rebuildable artifact or also exists in the main checkout (env
#     copies, fixtures); a non-empty .scratch always keeps it
# A local branch is deleted when it isn't checked out anywhere, isn't main, master, dev, develop
# or the remote's default branch, and its tip is reachable from a remote branch.
# Dirty, unpushed or in-use work is never touched. Every decision is logged.
#
# Usage:
#   worktree-sweep.sh --dry-run    print what would go, change nothing
#   worktree-sweep.sh              sweep now
#   worktree-sweep.sh --hook       Claude Code SessionStart: returns at once, sweeps in the
#                                  background at most once per interval, only when turned on
# Settings (plugin option, else env var, else default):
#   auto_sweep       WORKTREE_SWEEP_AUTO          false   --hook does nothing unless true
#   sweep_roots      WORKTREE_SWEEP_ROOTS         empty   folders to search for repos (JSON array
#                                                         or comma list); empty = the repo the
#                                                         session starts in
#   sweep_idle_min   WORKTREE_SWEEP_IDLE_MIN      120     minutes a worktree must be untouched
#                    WORKTREE_SWEEP_INTERVAL_MIN  60      minimum gap between hook sweeps
# Log: ~/Library/Logs/worktree-sweep.log (macOS), $XDG_STATE_HOME/worktree-sweep/ (Linux),
# %LOCALAPPDATA%\worktree-sweep\ (Windows), or $WORKTREE_SWEEP_LOG. 1 MB, then one older copy.
set -u

opt() { # key envname default
  local u; u=$(printf '%s' "$1" | tr 'a-z' 'A-Z')
  local v; eval "v=\${CLAUDE_PLUGIN_OPTION_$u:-}"
  [ -n "$v" ] || eval "v=\${$2:-}"
  printf '%s' "${v:-$3}"
}
truthy() { case $(printf '%s' "$1" | tr 'A-Z' 'a-z') in 1|true|yes|on) return 0 ;; esac; return 1; }

AUTO=$(opt auto_sweep WORKTREE_SWEEP_AUTO false)
ROOTS_RAW=$(opt sweep_roots WORKTREE_SWEEP_ROOTS "")
IDLE_MIN=$(opt sweep_idle_min WORKTREE_SWEEP_IDLE_MIN 120)
INTERVAL_MIN=${WORKTREE_SWEEP_INTERVAL_MIN:-60}
case $IDLE_MIN in ''|*[!0-9]*) IDLE_MIN=120 ;; esac
case $INTERVAL_MIN in ''|*[!0-9]*) INTERVAL_MIN=60 ;; esac

case "$(uname -s 2>/dev/null)" in
  Darwin) LOGDIR="$HOME/Library/Logs" ;;
  MINGW*|MSYS*|CYGWIN*) LOGDIR="${LOCALAPPDATA:-$HOME/AppData/Local}/worktree-sweep" ;;
  Linux) LOGDIR="${XDG_STATE_HOME:-$HOME/.local/state}/worktree-sweep" ;;
  *) LOGDIR="$HOME/.cache/worktree-sweep" ;;
esac
LOG=${WORKTREE_SWEEP_LOG:-$LOGDIR/worktree-sweep.log}
STATE="${XDG_CACHE_HOME:-$HOME/.cache}/worktree-sweep"
mkdir -p "$STATE" "$(dirname "$LOG")" 2>/dev/null

# Roots, one per line, ~ expanded. Empty means: the repo of the folder this runs in.
roots() {
  local raw=$ROOTS_RAW
  case $raw in
    \[*) if command -v jq >/dev/null 2>&1; then printf '%s' "$raw" | jq -r '.[]' 2>/dev/null
         else printf '%s' "$raw" | sed 's/^\[//; s/\]$//' | tr ',' '\n' | sed 's/^ *"//; s/" *$//'; fi ;;
    *) printf '%s' "$raw" | tr ',' '\n' ;;
  esac | sed 's/^ *//; s/ *$//' | sed "s#^~#$HOME#" | grep -v '^$'
}

if [ "${1:-}" = "--hook" ]; then
  cat >/dev/null 2>&1 # drain the hook's JSON
  truthy "$AUTO" || exit 0
  # One stamp per scope: a roots list, or the session's repo.
  scope=${ROOTS_RAW:-$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)}
  [ -n "$scope" ] || exit 0
  key=$(printf '%s' "$scope" | cksum | cut -d' ' -f1)
  stamp="$STATE/$key.stamp"
  [ -f "$stamp" ] && [ -z "$(find "$stamp" -mmin +"$INTERVAL_MIN" 2>/dev/null)" ] && exit 0
  touch "$stamp"
  NICE=""; command -v nice >/dev/null 2>&1 && NICE="nice -n 10"
  nohup $NICE bash "$0" </dev/null >/dev/null 2>&1 &
  exit 0
fi

DRY=0; [ "${1:-}" = "--dry-run" ] && DRY=1
LOCK="$STATE/lock"
# A lock older than 3 hours belongs to a sweep that died.
[ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null
mkdir "$LOCK" 2>/dev/null || { echo "another sweep is running"; exit 0; }
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
export GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND="ssh -o BatchMode=yes -o ConnectTimeout=10"

log() {
  [ -n "$(find "$LOG" -size +1024k 2>/dev/null)" ] && mv -f "$LOG" "$LOG.1"
  printf '%s %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"
}
act() { if [ $DRY = 1 ]; then log "DRY $*"; else log "DO  $*"; "$@" >>"$LOG" 2>&1 || log "ERR $*"; fi; }

# Ignored paths that a build or install recreates.
REBUILDABLE='(^|/)(node_modules|\.next|\.expo|dist|build|\.turbo|coverage|\.husky/_|\.vercel|__pycache__|\.venv|target)(/|$)|\.tsbuildinfo$|(next|expo)-env\.d\.ts$|\.DS_Store$'

# Working directories of running processes, one per line.
if command -v lsof >/dev/null 2>&1; then
  cwds=$(lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')
elif [ -d /proc/self/cwd ] || [ -L /proc/self/cwd ]; then
  cwds=$(for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done)
else
  cwds=""
fi

on_remote() { [ -n "$(git -C "$1" branch -r --contains "$2" 2>/dev/null | head -1)" ]; }

recently_touched() {
  [ -n "$(find "$1" -path '*/node_modules' -prune -o -path "$1/.git" -prune -o -type f -mmin -"$IDLE_MIN" -print 2>/dev/null | head -1)" ]
}

ignored_ok() { # $1 worktree, $2 main checkout
  local p
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    if [[ "$p" == .scratch* ]]; then
      [ -z "$(find "$1/.scratch" -type f 2>/dev/null | head -1)" ] && continue
      echo ".scratch has files"; return 1
    fi
    [[ "$p" =~ $REBUILDABLE ]] && continue
    [ -e "$2/${p%/}" ] && continue
    echo "only here: $p"; return 1
  done < <(git -C "$1" status --porcelain --ignored 2>/dev/null | sed -n 's/^!! //p')
}

sweep_repo() {
  local main=$1 wt head why trunk checked_out br
  git -C "$main" remote get-url origin >/dev/null 2>&1 || return
  git -C "$main" fetch --prune --quiet origin 2>/dev/null || { log "skip $main: fetch failed"; return; }
  while IFS= read -r wt; do
    [ "$wt" = "$main" ] && continue
    [ -d "$wt" ] || { act git -C "$main" worktree prune; continue; }
    why=""
    [ -n "$(git -C "$wt" status --porcelain 2>/dev/null | head -1)" ] && why="uncommitted changes"
    head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
    [ -z "$why" ] && ! on_remote "$main" "$head" && why="HEAD not on a remote"
    [ -z "$why" ] && [ -n "$cwds" ] && grep -qxF "$wt" <<<"$cwds" && why="process inside"
    [ -z "$why" ] && [ -n "$cwds" ] && grep -qF "$wt/" <<<"$cwds" && why="process inside"
    [ -z "$why" ] && recently_touched "$wt" && why="touched in the last $IDLE_MIN min"
    [ -z "$why" ] && why=$(ignored_ok "$wt" "$main")
    if [ -n "$why" ]; then log "keep $wt ($why)"; continue; fi
    act git -C "$main" worktree remove --force "$wt"
  done < <(git -C "$main" worktree list --porcelain | sed -n 's/^worktree //p')

  trunk=$(git -C "$main" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); trunk=${trunk#origin/}
  checked_out=$(git -C "$main" worktree list --porcelain | sed -n 's#^branch refs/heads/##p')
  while IFS= read -r br; do
    case "$br" in main|master|dev|develop|"$trunk") continue ;; esac
    grep -qxF "$br" <<<"$checked_out" && continue
    on_remote "$main" "refs/heads/$br" || continue
    act git -C "$main" branch -D "$br"
  done < <(git -C "$main" for-each-ref --format='%(refname:short)' refs/heads)
}

log "run start (dry=$DRY)"
found=0
if [ -n "$(roots)" ]; then
  while IFS= read -r gitdir; do
    found=$((found + 1))
    sweep_repo "$(dirname "$gitdir")"
  done < <(roots | while IFS= read -r r; do
             find "$r" -maxdepth 5 -type d -path '*/.git/worktrees' -prune 2>/dev/null
           done | sed 's#/worktrees$##')
  [ $found = 0 ] && log "no repos with worktrees under: $(roots | tr '\n' ' ')"
else
  common=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  if [ -n "$common" ] && [ "$(basename "$common")" = .git ]; then
    found=1; sweep_repo "$(dirname "$common")"
  else
    log "not in a git repo with a .git folder: $PWD"
  fi
fi
log "run end ($found repos)"
