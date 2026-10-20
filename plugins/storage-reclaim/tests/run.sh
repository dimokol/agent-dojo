#!/usr/bin/env bash
# Runs scan.sh against a fake HOME: checks the table, what it holds back and why,
# and that it deletes nothing. macOS (lsof, BSD tools); disk-map has its own suite.
set -u
here=$(cd "$(dirname "$0")" && pwd)
scan="$here/../skills/storage-reclaim/scripts/scan.sh"
fail=0
check() { if [ "$2" = ok ]; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
has()   { case "$out" in *"$1"*) echo ok;; *) echo bad;; esac; }
hasnt() { case "$out" in *"$1"*) echo bad;; *) echo ok;; esac; }

for t in zsh git lsof python3; do command -v $t >/dev/null 2>&1 || { echo "$t not installed, skipping"; exit 0; }; done

fake=$(mktemp -d) || exit 1
: "${fake:?mktemp failed}"
fake=$(cd "$fake" && pwd -P)
pids=()
trap 'kill "${pids[@]}" 2>/dev/null; rm -rf "${fake:?}"' EXIT

old=$(( $(date +%s) - 30 * 86400 ))
stamp=$(date -r "$old" +%Y%m%d%H%M)
export GIT_AUTHOR_DATE="@$old +0000" GIT_COMMITTER_DATE="@$old +0000"
g() { git -c user.email=t@example.com -c user.name=t -c init.defaultBranch=main -c advice.detachedHead=false "$@"; }
mb() { mkdir -p "$(dirname "$1")"; dd if=/dev/zero of="$1" bs=1048576 count="$2" 2>/dev/null; }
node_project() {  # node_project DIR: a committed package.json with ignored node_modules and .next
  mkdir -p "$1"
  echo '{}' > "$1/package.json"
  printf 'node_modules/\n.next/\n.env\n' > "$1/.gitignore"
  g -C "$1" init -q && g -C "$1" add . && g -C "$1" commit -qm init
  mb "$1/node_modules/pkg/index.js" 2
  mb "$1/.next/cache/x" 1
}

D=$fake/Documents
node_project "$D/idle-app"
node_project "$D/busy-app"
node_project "$D/locked-app"; mkdir -p "$D/locked-app/.locks"; echo held > "$D/locked-app/.locks/session-a"
mkdir -p "$D/proj-worktrees/feat"; echo '{}' > "$D/proj-worktrees/feat/package.json"; mb "$D/proj-worktrees/feat/node_modules/a/b" 1
# A dist/ that git tracks is content, not build output.
mkdir -p "$D/tracked-dist/dist"; echo '{}' > "$D/tracked-dist/package.json"; echo keep > "$D/tracked-dist/dist/app.js"
g -C "$D/tracked-dist" init -q && g -C "$D/tracked-dist" add . && g -C "$D/tracked-dist" commit -qm init

# A repo with an origin and three worktrees: merged and clean, locked, and one whose .env differs.
g init -q --bare "$fake/remotes/origin.git"
node_project "$D/repo"
echo 'A=1' > "$D/repo/.env"
g -C "$D/repo" remote add origin "$fake/remotes/origin.git"
g -C "$D/repo" push -q origin main
for b in merged envdiff; do g -C "$D/repo" worktree add -q "$D/repo-wt/$b" -b "$b"; done
g -C "$D/repo-wt/merged" commit -q --allow-empty -m work
g -C "$D/repo" merge -q --ff-only merged && g -C "$D/repo" push -q origin main
mb "$D/repo-wt/merged/node_modules/x" 1
cp "$D/repo/.env" "$D/repo-wt/merged/.env"
g -C "$D/repo-wt/envdiff" push -q origin envdiff; echo 'A=2' > "$D/repo-wt/envdiff/.env"
g -C "$D/repo" worktree add -q "$D/repo-wt/locked" -b locked && g -C "$D/repo" push -q origin locked
g -C "$D/repo" worktree lock --reason "agent running" "$D/repo-wt/locked"

C=$fake/Library/Caches
mb "$C/dropme/blob" 3; mb "$C/keepme/blob" 3; mb "$C/kept-by-decision/blob" 3
mkdir -p "$C/ms-playwright-mcp/brave/Default"; echo s > "$C/ms-playwright-mcp/brave/Default/Cookies"
mb "$fake/Downloads/photos.zip" 101
# Downloaded Playwright browsers next to the MCP's login profile (cookies four levels down).
mb "$C/ms-playwright/chromium-1200/chrome" 2
mkdir -p "$C/ms-playwright/mcp-chrome-profile/Default/Network"; echo s > "$C/ms-playwright/mcp-chrome-profile/Default/Network/Cookies"
# Names a glob would misread, a glob that protects a file inside a cache, and a dotfile lock.
mb "$C/C#tool/blob" 1; mb "$C/bar (old)/blob" 1; mb "$C/appx/keep.db" 1; mb "$C/appx/tmp" 1
node_project "$D/dotlock-app"; mkdir -p "$D/dotlock-app/.locks"; echo held > "$D/dotlock-app/.locks/.session-a"
# Outside git, a dist/ may be the only copy.
mkdir -p "$D/thesis/dist"; echo x > "$D/thesis/requirements.txt"; echo draft > "$D/thesis/dist/paper.pdf"
# A project root reached through a symlink, with a process running inside a non-git project.
mkdir -p "$fake/real-dev/code/tool/.venv/lib"; echo x > "$fake/real-dev/code/tool/requirements.txt"; mb "$fake/real-dev/code/tool/.venv/lib/big" 1
ln -s "$fake/real-dev" "$fake/Dev"
# An editor extension downgraded on purpose: extensions.json names the older one.
E=$fake/.vscode/extensions; mb "$E/pub.ext-1.0.0/a" 1; mb "$E/pub.ext-2.0.0/a" 1
echo '[{"identifier":{"id":"pub.ext"},"relativeLocation":"pub.ext-1.0.0"}]' > "$E/extensions.json"

# Everything old enough to count as idle.
find "$fake" -exec touch -h -t "$stamp" {} + 2>/dev/null

conf=$fake/.config/storage-reclaim; mkdir -p "$conf"
printf '~/Library/Caches/keepme\tthe user said keep\n' > "$conf/never-touch.txt"
printf '~/Library/Caches/C#tool\tliteral name\n~/Library/Caches/appx/*.db\ta file inside a cache\n' >> "$conf/never-touch.txt"
printf 'date\tpath\tdecision\trecheck\tnote\n2026-01-01\t~/Library/Caches/kept-by-decision\tkeep\t2999-01-01\ttest\n2026-01-01\t~/Library/Caches/bar (old)\tkeep\tnever\ttest\n' > "$conf/decisions.tsv"

# A process sitting in busy-app's root with nothing open under node_modules: the gap lsof alone misses.
(cd "$D/busy-app" && exec sleep 300) & pids+=($!); disown $!
(cd "$fake/Dev/code/tool" && exec sleep 300) & pids+=($!); disown $!

# A simulator runtime no device uses, through a stand-in xcrun.
mkdir -p "$fake/bin"
cat > "$fake/bin/xcrun" <<'EOF'
#!/bin/sh
case "$*" in
  "simctl runtime list -j") echo '{"AAAA-1111": {"runtimeIdentifier": "com.apple.CoreSimulator.SimRuntime.iOS-18-3", "version": "18.3.1", "build": "22D8075", "sizeBytes": 8400000000, "deletable": true, "path": "/nonexistent/AAAA.dmg", "mountPath": "/nonexistent/mnt/AAAA"}}' ;;
  "simctl list devices -j") echo '{"devices": {}}' ;;
esac
EOF
chmod +x "$fake/bin/xcrun"

mkdir -p "$fake/cwd"; echo junk > "$fake/cwd/zzz-file"   # a first run must not read the cwd
snapshot() { (cd "$fake" && find . -path ./.config -prune -o -path ./.local -prune -o -print | LC_ALL=C sort && find . -path ./.config -prune -o -path ./.local -prune -o -type f -exec cksum {} + | LC_ALL=C sort); }
before=$(snapshot)

run() { env -u XDG_CONFIG_HOME HOME="$fake" PATH="$fake/bin:$PATH" STORAGE_RECLAIM_MIN_MB=0 STORAGE_RECLAIM_ROWS=50 \
  STORAGE_RECLAIM_PROJECT_ROOTS="$fake/Documents:$fake/Dev/code" \
  STORAGE_RECLAIM_LOCK_DIR=.locks STORAGE_RECLAIM_WORKTREE_SUFFIX=-worktrees zsh "$scan" "$@" 2>&1; }
out=$(cd "$fake/cwd" && run); status=$?
after=$(snapshot)

[ "$status" -eq 0 ] && s=ok || s=bad; check "exits 0" $s
case "$out" in "QUICK WINS · "*) s=ok;; *) s=bad;; esac; check "starts with the QUICK WINS line" $s
check "prints the back legend" "$(has 'back: none = junk')"
check "prints a rec line" "$(has 'rec = Q')"
for sec in WORKTREES PROJECTS "SYSTEM SIDE" "NEEDS A LOOK" "HELD BACK" ACTIONS; do check "prints section: $sec" "$(has "=== $sec")"; done

row() { printf '%s\n' "$out" | sed -n '/^QUICK WINS/,/^back:/p' | grep -F -- "$1"; }
id_of() { row "$1" | awk '{ print $1 }'; }
rec=$(printf '%s\n' "$out" | sed -n 's/^rec = \(.*\) · .*/\1/p')

i=$(id_of 'idle-app'); [ -n "$i" ] && s=ok || s=bad; check "idle project gets a rebuild row" $s
row 'idle-app' | grep -q 'node_modules, .next' && s=ok || s=bad; check "idle row names node_modules and .next" $s
case " $rec " in *" $i "*) s=ok;; *) s=bad;; esac; check "idle project is in rec" $s
[ -z "$(id_of 'busy-app')" ] && s=ok || s=bad; check "busy project (process cwd at its root) gets no row" $s
case "$out" in *"~/Documents/busy-app/node_modules  [in use]"*) s=ok;; *) s=bad;; esac; check "busy node_modules listed under HELD BACK" $s
[ -z "$(id_of 'tracked-dist')" ] && s=ok || s=bad; check "a dist/ git tracks is not proposed" $s
[ -z "$(id_of 'locked-app')" ] && s=ok || s=bad; check "a project holding a lock file is not proposed" $s
case "$out" in *"locked-app/node_modules  [locked]"*) s=ok;; *) s=bad;; esac; check "lock_dir hold is named" $s
[ -z "$(id_of 'proj-worktrees')" ] && s=ok || s=bad; check "worktree_suffix folders are not proposed" $s

w=$(id_of 'worktree ~/Documents/repo-wt/merged'); [ -n "$w" ] && s=ok || s=bad; check "merged clean worktree gets a git row" $s
row 'repo-wt/merged' | grep -q ' git ' && s=ok || s=bad; check "worktree row is labelled git" $s
[ -z "$(id_of 'repo-wt/envdiff')" ] && s=ok || s=bad; check "worktree whose .env differs is not proposed" $s
case "$out" in *"repo-wt/envdiff  [envdiff, 0 dirty"*"local-only files: 1]"*) s=ok;; *) s=bad;; esac; check "envdiff shows 1 local-only file" $s
[ -z "$(id_of 'repo-wt/locked')" ] && s=ok || s=bad; check "locked worktree is not proposed" $s
check "locked worktree shows its reason" "$(has 'LOCKED (agent running)')"
case "$out" in *"$(printf 'git -C %s worktree remove %s' "$D/repo" "$D/repo-wt/merged")"*) s=ok;; *) s=bad;; esac
check "worktree action is git worktree remove" $s

q=$(id_of '~/Library/Caches/dropme'); [ -n "$q" ] && s=ok || s=bad; check "a cache gets a regrows row" $s
[ -z "$(id_of 'keepme')" ] && s=ok || s=bad; check "never-touch path is not proposed" $s
check "never-touch hold is named" "$(has 'Caches/keepme  [never-touch]')"
[ -z "$(id_of 'kept-by-decision')" ] && s=ok || s=bad; check "a keep decision before its recheck is not proposed" $s
[ -z "$(id_of 'ms-playwright-mcp')" ] && s=ok || s=bad; check "a browser profile is not proposed as a cache" $s
[ -z "$(id_of 'photos.zip')" ] && s=ok || s=bad; check "an archive never gets an ID" $s
check "the archive is counted under needs a look" "$(has 'needs a look: 1 files')"

r=$(id_of 'iOS 18.3.1 simulator runtime'); [ -n "$r" ] && s=ok || s=bad; check "an unused simulator runtime gets a download row" $s
check "runtime action is simctl runtime delete" "$(has 'xcrun simctl runtime delete AAAA-1111')"

b=$(id_of 'ms-playwright: 1 browser build'); [ -n "$b" ] && s=ok || s=bad; check "playwright browser builds get a row" $s
case "$out" in *"rm -rf $C/ms-playwright/chromium-1200"*) s=ok;; *) s=bad;; esac; check "the row deletes only the browser build" $s
case "$out" in *"rm -rf $C/ms-playwright "*|*"rm -rf $C/ms-playwright"$'\n'*|*"ms-playwright/mcp-chrome-profile "*) s=bad;; *) s=ok;; esac
check "the MCP login profile is never in an action" $s
[ -z "$(id_of 'C#tool')" ] && s=ok || s=bad; check "never-touch path with # is held" $s
[ -z "$(id_of 'bar (old)')" ] && s=ok || s=bad; check "keep decision for a path with ( ) is held" $s
[ -z "$(id_of 'Caches/appx')" ] && s=ok || s=bad; check "a cache holding a never-touch glob match is held" $s
[ -z "$(id_of 'dotlock-app')" ] && s=ok || s=bad; check "a lock folder with only dotfiles still locks" $s
[ -z "$(id_of 'thesis')" ] && s=ok || s=bad; check "dist/ outside git is not proposed" $s
[ -z "$(id_of 'code/tool')" ] && s=ok || s=bad; check "a running project under a symlinked root is not idle" $s
case "$out" in *"rm -rf $E/pub.ext-2.0.0"*) s=ok;; *) s=bad;; esac; check "the extension version not in use is proposed" $s
case "$out" in *"$E/pub.ext-1.0.0"*) s=bad;; *) s=ok;; esac; check "the active (older) extension version is kept" $s
check "prints the survey-only footer" "$(has 'nothing deleted')"
[ "$before" = "$after" ] && s=ok || s=bad; check "fake HOME unchanged outside the keep-lists (nothing deleted)" $s

# First run without keep-lists copies the templates.
rm -rf "$conf"; out2=$(run)
[ -f "$conf/never-touch.txt" ] && [ -f "$conf/decisions.tsv" ] && s=ok || s=bad; check "first run copies the keep-list templates" $s
grep -qv '^#' "$conf/never-touch.txt" && s=bad || s=ok; check "never-touch template holds comments only" $s

if command -v dua >/dev/null 2>&1; then
  check "full scan writes a map" "$(has 'map: ')"
  check "first full run says so, never reads the cwd" "$(has '(first run')"
  check "full scan prints WHAT GREW" "$(has '=== WHAT GREW')"
else
  echo "skip full scan: dua not installed"
fi

[ "$fail" -eq 0 ] && echo "all passed" || echo "failures"
exit "$fail"
