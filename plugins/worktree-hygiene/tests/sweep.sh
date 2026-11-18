#!/usr/bin/env bash
# worktree-sweep against throwaway repos: what it removes, what it keeps, and the hook's opt-in.
HERE=$(cd "$(dirname "$0")" && pwd)
SWEEP=$HERE/../scripts/worktree-sweep.sh
WORK=$(mktemp -d); : "${WORK:?}"; WORK=$(cd "$WORK" && pwd -P)
SLEEPER=""
trap '[ -n "$SLEEPER" ] && kill $SLEEPER 2>/dev/null; rm -rf "${WORK:?}"' EXIT
export HOME=$WORK/home XDG_CACHE_HOME=$WORK/cache WORKTREE_SWEEP_LOG=$WORK/sweep.log WORKTREE_SWEEP_IDLE_MIN=0
unset CLAUDE_PLUGIN_OPTION_AUTO_SWEEP CLAUDE_PLUGIN_OPTION_SWEEP_ROOTS WORKTREE_SWEEP_AUTO WORKTREE_SWEEP_ROOTS
mkdir -p "$HOME"
export GIT_CONFIG_GLOBAL=$WORK/gitconfig
git config --global user.email t@example.com; git config --global user.name t
git config --global init.defaultBranch main
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1"; }
gone() { if [ ! -e "$2" ]; then ok "$1"; else bad "$1 ($2 still there)"; fi; }
kept() { if [ -e "$2" ]; then ok "$1"; else bad "$1 ($2 removed)"; fi; }
branch_gone() { if git -C "$R" show-ref -q "refs/heads/$2"; then bad "$1"; else ok "$1"; fi; }
branch_kept() { if git -C "$R" show-ref -q "refs/heads/$2"; then ok "$1"; else bad "$1"; fi; }

setup() {
  rm -rf "$WORK/remote.git" "$WORK/src"
  git init -q --bare "$WORK/remote.git"
  R=$WORK/src/repo
  git clone -q "$WORK/remote.git" "$R" 2>/dev/null
  echo a >"$R/a"; printf 'node_modules/\n.env\n.scratch/\n' >"$R/.gitignore"
  git -C "$R" add -A; git -C "$R" commit -qm init; git -C "$R" push -q origin main 2>/dev/null
  git -C "$R" remote set-head origin -a >/dev/null 2>&1
  wt() { # name pushed?
    git -C "$R" worktree add -q "$WORK/src/$1" -b "$1" 2>/dev/null
    echo "$1" >"$WORK/src/$1/$1"; git -C "$WORK/src/$1" add -A; git -C "$WORK/src/$1" commit -qm "$1"
    [ "$2" = pushed ] && git -C "$WORK/src/$1" push -q origin "$1" 2>/dev/null
    return 0
  }
  wt merged pushed
  mkdir -p "$WORK/src/merged/node_modules/x"; echo 1 >"$WORK/src/merged/node_modules/x/i.js"
  wt dirty pushed; echo change >>"$WORK/src/dirty/a"
  wt unpushed local
  wt scratch pushed; mkdir -p "$WORK/src/scratch/.scratch"; echo n >"$WORK/src/scratch/.scratch/notes.md"
  wt envonly pushed; echo SECRET=1 >"$WORK/src/envonly/.env"
  wt busy pushed
  git -C "$R" branch -q pushed-branch; git -C "$R" push -q origin pushed-branch 2>/dev/null
  git -C "$R" branch -q local-branch; git -C "$R" commit -q --allow-empty -m x; git -C "$R" branch -q -f local-branch HEAD
  git -C "$R" reset -q --hard origin/main
}

echo "== dry run changes nothing"
setup
(cd "$R" && bash "$SWEEP" --dry-run >/dev/null)
kept "dry run keeps merged" "$WORK/src/merged"
grep -q "DRY git -C .* worktree remove --force $WORK/src/merged" "$WORK/sweep.log" && ok "dry run names it" || bad "dry run names it"

echo "== sweep"
(cd "$WORK/src/busy" && exec sleep 30) & SLEEPER=$!
sleep 0.3
(cd "$R" && bash "$SWEEP" >/dev/null)
gone "clean, pushed, idle worktree removed (node_modules rebuilds)" "$WORK/src/merged"
kept "uncommitted changes kept" "$WORK/src/dirty"
kept "unpushed commit kept" "$WORK/src/unpushed"
kept ".scratch with files kept" "$WORK/src/scratch"
kept "ignored file only in the worktree kept" "$WORK/src/envonly"
if command -v lsof >/dev/null || [ -e /proc/self/cwd ]; then kept "worktree with a process inside kept" "$WORK/src/busy"; fi
branch_gone "pushed branch, not checked out, deleted" pushed-branch
branch_kept "unpushed branch kept" local-branch
branch_kept "main kept" main
branch_gone "removed worktree's branch deleted (it's on the remote)" merged
kill $SLEEPER 2>/dev/null; wait $SLEEPER 2>/dev/null; SLEEPER=""

echo "== idle guard"
setup
(cd "$R" && WORKTREE_SWEEP_IDLE_MIN=120 bash "$SWEEP" >/dev/null)
kept "freshly touched worktree kept" "$WORK/src/merged"

echo "== roots mode"
setup
(cd "$WORK" && WORKTREE_SWEEP_ROOTS="[\"$WORK/src\"]" bash "$SWEEP" >/dev/null)
gone "found through sweep_roots" "$WORK/src/merged"

echo "== hook"
setup
(cd "$R" && echo '{}' | bash "$SWEEP" --hook); sleep 1
kept "hook does nothing while auto_sweep is off" "$WORK/src/merged"
(cd "$R" && echo '{}' | CLAUDE_PLUGIN_OPTION_AUTO_SWEEP=true bash "$SWEEP" --hook)
i=0; while [ -e "$WORK/src/merged" ] && [ $i -lt 50 ]; do sleep 0.2; i=$((i+1)); done
gone "hook sweeps in the background when on" "$WORK/src/merged"
git -C "$R" worktree add -q "$WORK/src/merged" merged 2>/dev/null
(cd "$R" && echo '{}' | WORKTREE_SWEEP_AUTO=1 bash "$SWEEP" --hook); sleep 1
kept "second hook inside the interval does nothing" "$WORK/src/merged"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
