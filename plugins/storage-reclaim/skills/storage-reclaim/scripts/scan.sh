#!/usr/bin/env zsh
# storage-reclaim: read-only survey. It deletes nothing. Its only writes are its own
# snapshots (~/.local/state/storage-reclaim: the newest 3, then one a week, none past 45 days)
# and, on the first run, the keep-lists copied from the templates (~/.config/storage-reclaim).
#
# Usage: zsh scan.sh   (about a minute; without dua, sizes come from du and take longer)
#
# Prints QUICK WINS first (the table to act on and the rec set), then the details,
# then the exact command behind each ID.
#
# Settings: plugin option, then env var, then default.
#   lock_dir         CLAUDE_PLUGIN_OPTION_LOCK_DIR         STORAGE_RECLAIM_LOCK_DIR         empty: skip
#   worktree_suffix  CLAUDE_PLUGIN_OPTION_WORKTREE_SUFFIX  STORAGE_RECLAIM_WORKTREE_SUFFIX  empty: skip
#   project_roots    CLAUDE_PLUGIN_OPTION_PROJECT_ROOTS    STORAGE_RECLAIM_PROJECT_ROOTS    colon-separated
#   idle_days        CLAUDE_PLUGIN_OPTION_IDLE_DAYS        STORAGE_RECLAIM_IDLE_DAYS        7
# STORAGE_RECLAIM_MIN_MB (default 200) and STORAGE_RECLAIM_ROWS (default 10) shape the table.
# STORAGE_RECLAIM_LOOK_MB (default 1000): content folders under the project roots listed in NEEDS A LOOK.
# STORAGE_RECLAIM_MAP_MIN_FREE_MB (default 500): below this much free space the map is skipped.

emulate -L zsh
setopt null_glob extended_glob
export GIT_OPTIONAL_LOCKS=0   # git status would otherwise rewrite each index it reads

t0=$SECONDS

LOCK_DIR=${CLAUDE_PLUGIN_OPTION_LOCK_DIR:-${STORAGE_RECLAIM_LOCK_DIR:-}}
WT_SUFFIX=${CLAUDE_PLUGIN_OPTION_WORKTREE_SUFFIX:-${STORAGE_RECLAIM_WORKTREE_SUFFIX:-}}
roots_cfg=${CLAUDE_PLUGIN_OPTION_PROJECT_ROOTS:-${STORAGE_RECLAIM_PROJECT_ROOTS:-}}
IDLE=${CLAUDE_PLUGIN_OPTION_IDLE_DAYS:-${STORAGE_RECLAIM_IDLE_DAYS:-7}}
MIN=$(( ${STORAGE_RECLAIM_MIN_MB:-200} * 1000000 ))
ROWS=${STORAGE_RECLAIM_ROWS:-10}
LOOKMIN=$(( ${STORAGE_RECLAIM_LOOK_MB:-1000} * 1000000 ))
MAPFREE=$(( ${STORAGE_RECLAIM_MAP_MIN_FREE_MB:-500} * 1000000 ))
# Unexpanded plugin placeholders mean unset.
[[ $LOCK_DIR == *'${'* ]] && LOCK_DIR=
[[ $WT_SUFFIX == *'${'* ]] && WT_SUFFIX=
[[ $roots_cfg == *'${'* ]] && roots_cfg=
[[ $IDLE == <-> ]] || IDLE=7
(( IDLE >= 1 )) || IDLE=1

typeset -a ROOTS
if [[ -n $roots_cfg ]]; then
  for r in ${(s.:.)roots_cfg}; do r=${r/#\~/$HOME}; [[ -d $r ]] && ROOTS+=("${r:A}"); done
else
  for r in "$HOME"/{Documents,Projects,code,Developer,src}; do [[ -d $r ]] && ROOTS+=("${r:A}"); done
fi
typeset -U ROOTS   # real paths: lsof reports those, so a symlinked root must not hide a running process

here=${0:A:h}
skill=${here:h}
map="${skill:h}/disk-map/scripts/map.sh"
report="${skill:h}/disk-map/scripts/report.py"
state="${XDG_STATE_HOME:-$HOME/.local/state}/storage-reclaim"
conf="${XDG_CONFIG_HOME:-$HOME/.config}/storage-reclaim"
mkdir -p "$conf"
for f in never-touch.txt decisions.tsv apps.tsv; do [[ -e $conf/$f ]] || cp "$skill/$f" "$conf/$f"; done

command -v lsof >/dev/null || { print -u2 "lsof is missing; without it nothing can be checked for use, so the scan stops."; exit 1; }

cands=$(mktemp); held=$(mktemp); body=$(mktemp); acts=$(mktemp); db=$(mktemp)
trap 'rm -f "$cands" "$held" "$body" "$acts" "$db"' EXIT   # command lines can hold tokens; never keep them

now=$(date +%s)
today=$(date +%Y-%m-%d)
h()     { printf '\n=== %s ===\n' "$1"; }
tilde() { print -r -- "${1/#$HOME/~}"; }
n_of()  { (( $1 == 1 )) && print -r -- "1 $2" || print -r -- "$1 ${2}s"; }
gb()    { awk -v b="$1" 'BEGIN { printf "%.1f", b / 1e9 }'; }
typeset -A SZ   # bytes per home path, from the disk-map snapshot in a full scan
typeset -A MEMO  # du results, so a path is measured once
bytes() {  # sets REPLY to the size of $1 in bytes; no subshell, so the memo sticks
  local rel=${1#$HOME/} k
  if [[ $1 == $HOME/* && -n ${SZ[$rel]} ]]; then REPLY=${SZ[$rel]}; return; fi
  [[ -n ${MEMO[$1]} ]] && { REPLY=${MEMO[$1]}; return; }
  k=$(du -xsk "$1" 2>/dev/null | awk '{ print $1 }')
  REPLY=$(( ${k:-0} * 1024 )); MEMO[$1]=$REPLY
}
sum_bytes() {  # one du call for the lot: hardlinks shared between the paths count once
  (( $# == 1 )) && { bytes "$1"; return; }
  local t=0 p k
  for p in "$@"; do [[ $p == $HOME/* && -n ${SZ[${p#$HOME/}]} ]] || { t=-1; break; }; (( t += ${SZ[${p#$HOME/}]} )); done
  (( t >= 0 )) && { REPLY=$t; return; }
  k=$(du -xsck "$@" 2>/dev/null | tail -1 | awk '{ print $1 }')
  REPLY=$(( ${k:-0} * 1024 ))
}

# ---------------------------------------------------------------------------
# What must not go: keep-lists, locks, other sessions' folders, anything in use.

typeset -a NEVER=('*/.git' '*/.env*') KEEP LOCKED_TREES ASKP ASKO APPDIR APPBUN
entry() {  # reply = the entry as written and as a real path (candidates are real paths)
  local e=${1/#\~/$HOME} pre dir
  while [[ $e == ?*/ ]]; do e=${e%/}; done
  reply=("$e")
  if [[ $e != *[*?]* ]]; then
    [[ -e $e ]] && reply+=("${e:A}")
  else
    pre=${e%%[*?]*}; dir=${pre%/*}
    [[ -d $dir ]] && reply+=("${dir:A}${e#$dir}")
  fi
  reply=(${(u)reply})
}
while IFS=$'\t' read -r p _; do
  [[ -z $p || $p == \#* ]] && continue
  entry "$p"; NEVER+=($reply)
done < "$conf/never-touch.txt"
while IFS=$'\t' read -r d p dec re note; do
  [[ -z $d || $d == \#* || $d == date ]] && continue
  [[ $dec == keep || $dec == 'user handles' || $dec == ask ]] || continue
  [[ $re == <->-<->-<-> && $re < $today ]] && continue   # recheck date passed: propose again
  entry "$p"
  if [[ $dec == ask ]]; then   # another session owns it: the row stays, out of rec, naming whom to ask
    for e in $reply; do ASKP+=("$e"); ASKO+=("${${note%%:*}:-its owner}"); done
  else
    KEEP+=($reply)
  fi
done < "$conf/decisions.tsv"
# Caches an app keeps using while it runs: folder under ~/Library/Caches (or a ~ path), then the app bundle.
if [[ -f $conf/apps.tsv ]]; then
  while IFS=$'\t' read -r p a _; do
    [[ -z $p || $p == \#* || -z $a ]] && continue
    [[ $p == [~/]* ]] || p="~/Library/Caches/$p"
    APPDIR+=("${p/#\~/$HOME}"); APPBUN+=("$a")
  done < "$conf/apps.tsv"
fi
covers() {  # covers PATH ENTRY...: PATH is an entry, sits under one, or holds one. Entries are literal.
  local p=$1 e; shift
  for e in "$@"; do [[ $p == "$e" || $p == "$e"/* || $e == "$p"/* ]] && return 0; done
  return 1
}
never() {  # like covers, but never-touch lines with * or ? are globs
  local p=$1 pat g hit
  covers "$p" ${NEVER:#*[*?]*} && return 0
  for pat in ${(M)NEVER:#*[*?]*}; do
    # Only * and ? are wildcards: escape what extended_glob would read in a name like "C#tool (old)".
    g=${pat//(#m)[\#\(\)\|\~\^\[\]\<\>]/\\$MATCH}
    [[ $p == ${~g} || $p == ${~g}/* ]] && return 0
    [[ $pat == */.git || $pat == */.env\* ]] && continue   # built-ins: every repo holds one
    # A candidate that holds a match would delete it too.
    if [[ $pat == /* ]]; then
      for hit in ${~g}(ND); do [[ $hit == "$p"/* ]] && return 0; done
    elif [[ -d $p ]]; then
      [[ -n $(find "$p" -maxdepth 8 -path "$pat" -print -quit 2>/dev/null) ]] && return 0
    fi
  done
  return 1
}

if [[ -n $LOCK_DIR && ${#ROOTS} -gt 0 ]]; then
  for d in ${(f)"$(find $ROOTS -maxdepth 5 -name "$LOCK_DIR" -type d -prune 2>/dev/null)"}; do
    locks=("$d"/*(ND)); (( $#locks )) && LOCKED_TREES+=("${d:h}")
  done
fi

# Every process, open file, working directory and command line, gathered once (about 30 s).
typeset -A PPIDOF PCMD PCWD SELF AGENT
for l in ${(f)"$(ps -axo pid=,ppid=,command= 2>/dev/null)"}; do
  l=${l## #}; pid=${l%% *}; l=${l#* }; l=${l## #}; PPIDOF[$pid]=${l%% *}; PCMD[$pid]=${l#* }
done
# An empty or failed process list would turn every in-use check off: stop instead.
(( ${#PCMD} >= 5 )) || { print -u2 "ps listed only ${#PCMD} processes; without a process list nothing can be checked for use, so the scan stops."; exit 1; }
# The scan's own chain, up to the agent that started it: its command lines name the paths it checks.
p=$$; while [[ -n $p && $p != (0|1) && -z ${SELF[$p]} ]]; do SELF[$p]=1; p=${PPIDOF[$p]}; done
# Agent CLIs and the shells they spawn sit at a repo root all day: that cwd says nothing about build output.
for pid in ${(k)PCMD}; do c=${${PCMD[$pid]}%% *}; [[ ${c:t} == (claude|codex) ]] && AGENT[$pid]=1; done
for pid in ${(k)PCMD}; do
  c=${${PCMD[$pid]}%% *}; [[ -n ${AGENT[${PPIDOF[$pid]}]} && ${c:t} == (-|)(zsh|bash|sh|fish) ]] && AGENT[$pid]=1
done
{ lsof -Fn 2>/dev/null | sed -n 's/^n//p'; for pid in ${(k)PCMD}; do [[ -n ${SELF[$pid]} ]] || print -r -- "${PCMD[$pid]}"; done; } | sort -u > "$db"
for l in ${(f)"$(lsof -a -d cwd -Fpn 2>/dev/null)"}; do
  case $l in p*) pid=${l#p} ;; n*) PCWD[$pid]=${l#n} ;; esac
done
typeset -aU CWDS CWDS_USE   # CWDS: any process works there (idle). CWDS_USE: one that isn't an agent or this scan.
for pid in ${(k)PCWD}; do
  CWDS+=("${PCWD[$pid]}"); [[ -n ${SELF[$pid]}${AGENT[$pid]} ]] || CWDS_USE+=("${PCWD[$pid]}")
done
# Paths named on command lines, relative ones resolved against the process's cwd: a dev server
# started from a parent folder (`python app1/server.py`, `npm --prefix app1 run dev`) is inside app1.
typeset -aU ARGPATHS
for pid in ${(k)PCMD}; do
  [[ -n ${SELF[$pid]} ]] && continue
  l=${PCMD[$pid]}; cwd=${PCWD[$pid]}
  for tok in ${(z)l}; do
    tok=${(Q)tok}; tok=${tok#--*=}
    [[ $tok == -* || $tok == '' ]] && continue
    [[ $tok == /* ]] || { [[ -n $cwd ]] || continue; tok=$cwd/$tok; }
    [[ $tok == $HOME/?* && -e $tok ]] && ARGPATHS+=("${tok:A}")
  done
done
named_in() {  # named_in DIR: a command line names DIR or something inside it
  local a; for a in $ARGPATHS; do [[ $a == $1 || $a == $1/* ]] && return 0; done; return 1
}
used() {  # used PATH [PROJECT]: a process has it open, names it, or runs inside the project above it
  grep -qF -- "$1" "$db" && return 0
  [[ -n $2 ]] || return 1
  local c
  for c in $CWDS_USE; do [[ $1 == $c/* && ( $c == $2 || $c == $2/* ) ]] && return 0; done
  named_in "$2"
}
app_running() {  # app_running PATH: REPLY = the app (apps.tsv) whose cache PATH is or holds, while it runs
  local i pid
  for (( i = 1; i <= $#APPDIR; i++ )); do
    [[ $1 == ${APPDIR[i]} || $1 == ${APPDIR[i]}/* || ${APPDIR[i]} == $1/* ]] || continue
    for pid in ${(k)PCMD}; do
      # A browser started on its own --user-data-dir (a test or agent browser) keeps its cache there.
      [[ ${PCMD[$pid]} == */${APPBUN[i]}/Contents/MacOS/* && ${PCMD[$pid]} != *--user-data-dir=* ]] && { REPLY=${APPBUN[i]%.app}; return 0; }
    done
  done
  return 1
}
ask_owner() {  # ask_owner PATH: REPLY = the session decisions.tsv says to ask before PATH goes
  local i
  for (( i = 1; i <= $#ASKP; i++ )); do
    [[ $1 == ${ASKP[i]} || $1 == ${ASKP[i]}/* || ${ASKP[i]} == $1/* ]] && { REPLY=${ASKO[i]}; return 0; }
  done
  return 1
}
# Package-manager caches keep bare git repos of their own (uv git-v0, cargo git): no user checkout.
PM_CACHES=("$HOME/.cache/uv" "$HOME/.cache/pip" "$HOME/.cargo/git" "$HOME/.cargo/registry" "$HOME/go/pkg/mod" "$HOME/.gradle/caches" "$HOME/.npm")
why_held() {
  never "$1" && { print never-touch; return; }
  # A git checkout inside (pip -e sources in .venv/src, a dev pod) may hold unpushed work.
  local pm=0 e; for e in $PM_CACHES; do [[ $1 == $e || $1 == $e/* ]] && pm=1; done
  (( ! pm )) && [[ $1 != $2 && -d $1 && -n $(find "$1" -maxdepth 4 -name .git -print -quit 2>/dev/null) ]] && { print 'holds a git checkout'; return; }
  app_running "$1" && { print 'app running'; return; }
  covers "$1" $KEEP && { print kept; return; }
  [[ -n $WT_SUFFIX && ( $1 == *$WT_SUFFIX/* || $1 == *$WT_SUFFIX ) ]] && { print 'session folder'; return; }
  local t; for t in $LOCKED_TREES; do [[ $1 == $t || $1 == $t/* ]] && { print locked; return; }; done
  used "$1" "$2" && print 'in use'
}
sift() {  # sift PROJECT PATH...: reply = the paths free to go; the rest are logged as held
  local top=$1 p r; shift; reply=()
  for p in "$@"; do
    r=$(why_held "$p" "$top")
    if [[ -n $r ]]; then bytes "$p"; print -r -- "$r"$'\t'"$REPLY"$'\t'"$(tilde "$p")" >> "$held"; else reply+=("$p"); fi
  done
}
cand() {  # cand BACK CLASS REC WHAT ACTION BYTES PATH...  (ACTION rm: delete the paths; BYTES -: measure them)
  local back=$1 cls=$2 rec=$3 what=$4 act=$5 b=$6 p; shift 6
  [[ $b == - ]] && { sum_bytes "$@"; b=$REPLY; }
  for p in "$@"; do ask_owner "$p" && { rec=0; what+=" · ask $REPLY first"; break; }; done
  # recheck.sh repeats the in-use check right before it deletes, and prints what each path freed.
  [[ $act == rm ]] && act="zsh ${(q)here}/recheck.sh --rm -- ${(j: :)${(q)@}}"
  print -r -- "$b"$'\t'"$back"$'\t'"$cls"$'\t'"$rec"$'\t'"$what"$'\t'"$act" >> "$cands"
}

# Agent sessions in the last IDLE days, by project folder.
typeset -A CSLUG; typeset -aU CODEX_CWDS
cdirs=("$HOME"/.claude*/projects(N-/)); [[ -n $CLAUDE_CONFIG_DIR ]] && cdirs+=("$CLAUDE_CONFIG_DIR"/projects(N-/))
(( $#cdirs )) && for f in ${(f)"$(find -H $cdirs -maxdepth 2 -name '*.jsonl' -mtime -$IDLE 2>/dev/null)"}; do CSLUG[${f:h:t}]=1; done
xdirs=("$HOME"/.codex*/sessions(N-/)); [[ -n $CODEX_HOME ]] && xdirs+=("$CODEX_HOME"/sessions(N-/))
(( $#xdirs )) && for f in ${(f)"$(find -H $xdirs -name '*.jsonl' -mtime -$IDLE 2>/dev/null)"}; do
  c=$(head -n 1 "$f" 2>/dev/null | grep -o '"cwd":"[^"]*"' | head -1); c=${c#\"cwd\":\"}; c=${c%\"}
  [[ -n $c ]] && CODEX_CWDS+=("$c")
done
slug() { print -r -- "${1//[^a-zA-Z0-9]/-}"; }
session_recent() {
  local s=$(slug "$1") k c
  for k in ${(k)CSLUG}; do [[ $k == $s || $k == $s-* ]] && return 0; done
  for c in $CODEX_CWDS; do [[ $c == $1 || $c == $1/* ]] && return 0; done
  return 1
}
PRUNE=(-name node_modules -o -name .git -o -name .next -o -name build -o -name dist -o -name target -o -name .venv -o -name Pods -o -name .gradle -o -name .turbo -o -name vendor)
IDLE_NOTE=
idle() {  # idle DIR: no commit, file edit or agent session in IDLE days, nothing running in it
  local t=$1 ct c
  ct=$(git -C "$t" log -1 --format=%ct 2>/dev/null); ct=${ct:-0}
  (( now - ct < IDLE * 86400 )) && { IDLE_NOTE='commit'; return 1; }
  [[ -n $(find "$t" \( $PRUNE \) -prune -o -type f -mtime -$IDLE -print -quit 2>/dev/null) ]] && { IDLE_NOTE='edited'; return 1; }
  session_recent "$t" && { IDLE_NOTE='agent session'; return 1; }
  grep -qF -- "$t/" "$db" && { IDLE_NOTE='running'; return 1; }
  for c in $CWDS; do [[ $c == $t || $c == $t/* ]] && { IDLE_NOTE='running'; return 1; }; done
  named_in "$t" && { IDLE_NOTE='running'; return 1; }
  IDLE_NOTE=$(( ct ? (now - ct) / 86400 : -1 ))
  return 0
}
age_note() { (( IDLE_NOTE >= 0 )) && print -r -- "idle, last commit $IDLE_NOTE d" || print -r -- "idle $IDLE+ d"; }

simrt() {  # simrt RUNTIMES_JSON DEVICES_JSON: uuid, bytes, name, build, mount, devices, deletable, dropped
  python3 -I - "$1" "$2" <<'PY'
import glob, json, os, sys
try:
    rts = json.loads(sys.argv[1] or '{}')
    devs = json.loads(sys.argv[2] or '{}').get('devices', {})
except ValueError:
    sys.exit()
for uid, r in rts.items():
    rid = r.get('runtimeIdentifier', '')
    name = rid.rsplit('.', 1)[-1].split('-')[0] + ' ' + r.get('version', '?')
    path, build = r.get('path', ''), r.get('build', '')
    # A runtime whose asset an Xcode update dropped from the catalogue: deleting it frees nothing.
    asset, dropped = path, 0
    while asset not in ('', '/') and not asset.endswith('.asset'):
        asset = os.path.dirname(asset)
    if asset.endswith('.asset'):
        xml = ''.join(open(x, errors='replace').read() for x in glob.glob(os.path.join(os.path.dirname(asset), '*.xml')))
        dropped = int(f'<string>{build}</string>' not in xml)
    print('\t'.join(map(str, [uid, r.get('sizeBytes', 0), name, build, r.get('mountPath') or path,
                              len(devs.get(rid, [])), int(bool(r.get('deletable', True))), dropped])))
PY
}

details() {

# ---------------------------------------------------------------------------
h "SCAN"
rl=(); for r in $ROOTS; do rl+=("$(tilde "$r")"); done
print -r -- "$(date '+%Y-%m-%d %H:%M') · project roots: ${(j:, :)rl:-none found}"
print -r -- "keep-lists: $(tilde "$conf")/never-touch.txt, decisions.tsv"

snap=
h "WHAT GREW SINCE THE LAST RUN (home folder)"
vol=$HOME; [[ -d /System/Volumes/Data ]] && vol=/System/Volumes/Data
free0=$(( $(df -k "$vol" | awk 'NR == 2 { print $4 }') * 1024 ))
if (( free0 < MAPFREE )); then
  # A full disk is when this runs most; the snapshot and its treemap need a few MB each.
  print -r -- "(map skipped: $(( free0 / 1000000 )) MB free, under $(( MAPFREE / 1000000 )) MB; sizes come from du, no diff this run)"
elif [[ -f $map ]] && command -v dua >/dev/null; then
  mkdir -p "$state"
  # Compare against the newest snapshot at least 20 hours old; a minutes-old one shows nothing.
  prev=
  for f in "$state"/*.stacks(N.om.mh+19) "$state"/*.stacks(N.om); do
    [[ $(head -c 10 "$f") == '#disk-map ' ]] && { prev=$f; break; }
  done
  bash "$map" "$HOME" "$state" 6 > "$state/last-map.log" 2>&1
  snap=$(sed -n 's/^snapshot: //p' "$state/last-map.log" | tail -1)
  if [[ -f $snap ]]; then
    print -r -- "map: ${snap%.stacks}.html (lists every folder name under ~; don't share it)"
    while IFS=$'\t' read -r b p; do SZ[$p]=$b; done < <(python3 -I "$report" prefixes "$snap" --min 1000000)
    if [[ -n $prev && $prev != $snap ]]; then
      python3 -I "$report" diff "$prev" "$snap" --depth 4 --top 12
    else
      print -r -- "(first run: the next run shows the diff)"
    fi
    # Keep the newest 3, then the newest of each week up to 45 days, for the diff.
    olds=("$state"/*.stacks(N.om)); typeset -A wk
    for old in ${olds[4,-1]}; do
      w=$(date -r "$old" +%G-%V)
      if [[ -n $(find "$old" -mtime +45) || -n ${wk[$w]} ]]; then rm -f "$old" "${old%.stacks}".{txt,html,unreadable}
      else wk[$w]=1; fi
    done
    for f in "$state"/*.(txt|html|unreadable)(N.); do [[ -e ${f%.*}.stacks ]] || rm -f "$f"; done   # orphans
  else
    print -r -- "(the map failed; see $(tilde "$state")/last-map.log)"
  fi
else
  print -r -- "(no map: needs dua, brew install dua-cli)"
fi

# ---------------------------------------------------------------------------
h "WORKTREES"
typeset -gA GITROW
remote_refs() {  # read-only: no fetch, nothing local changes
  git -C "$1" remote get-url origin >/dev/null 2>&1 || return 1
  GIT_TERMINAL_PROMPT=0 GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -o BatchMode=yes -o ConnectTimeout=5} \
    perl -e 'alarm shift; exec @ARGV' 6 git -C "$1" ls-remote --symref origin HEAD 'refs/heads/*' 2>/dev/null
}
# Skipped only when an install or a build provably recreates it. Generic names (dist, build,
# .data, .cache) can hold a local database or the only copy, so they count as local-only.
LOCAL_ONLY_SKIP='(^|/)(node_modules|\.next|\.nuxt|\.turbo|\.vite|\.expo|\.gradle|\.cxx|Pods|DerivedData|__pycache__|\.venv|venv|\.dart_tool)(/|$)|\.DS_Store$|\.tsbuildinfo$'
wt_rows=()
repos=(); (( $#ROOTS )) && repos=(${(f)"$(find $ROOTS -maxdepth 4 -name .git -type d -prune 2>/dev/null)"})
wtrepos=()
for g in $repos; do (( $(git -C "${g:h}" worktree list --porcelain 2>/dev/null | grep -c '^worktree ') > 1 )) && wtrepos+=("${g:h}"); done
# One ls-remote per repo with worktrees, all at once: each takes about 2 s over the network.
rdir=$(mktemp -d); i=0
for repo in $wtrepos; do (( i++ )); { remote_refs "$repo" > "$rdir/$i" || rm -f "$rdir/$i"; } & done
wait
i=0
for repo in $wtrepos; do
  (( i++ )); online=0; refs=
  [[ -f $rdir/$i ]] && { online=1; refs=$(<"$rdir/$i"); }
  def=$(print -r -- "$refs" | sed -n 's|^ref: refs/heads/\([^[:space:]]*\)[[:space:]]*HEAD$|\1|p')
  rdef=$(print -r -- "$refs" | awk '$2 == "HEAD" { print $1 }')
  main= wt= sha= br= lock= lockwhy=
  { git -C "$repo" worktree list --porcelain 2>/dev/null; print; } | while IFS= read -r line; do
    case $line in
      'worktree '*) wt=${line#worktree }; [[ -z $main ]] && main=$wt ;;
      'HEAD '*)     sha=${line#HEAD } ;;
      'branch '*)   br=${line#branch refs/heads/} ;;
      locked*)      lock=1; lockwhy=${line#locked}; lockwhy=${lockwhy# } ;;
      '')
        if [[ -n $wt && $wt != $main ]]; then
          if [[ ! -e $wt ]]; then
            print -r -- "STALE (folder gone): $(tilde "$wt")  -> git -C $(tilde "$repo") worktree prune"
          else
            bytes "$wt"; size=$REPLY
            # A git status that fails tells nothing: treat the worktree as dirty.
            if st=$(git -C "$wt" status --porcelain 2>/dev/null); then dirty=${#${(f)st}}; else dirty='?'; fi

            ct=$(git -C "$wt" log -1 --format=%ct 2>/dev/null); ct=${ct:-0}
            on=0 merged=0 how=
            rb=$(print -r -- "$refs" | awk -v r="refs/heads/$br" '$2 == r { print $1 }')
            if (( online )); then
              [[ -n $rb && ( $rb == $sha || ( -n $(git -C "$wt" cat-file -t "$rb" 2>/dev/null) && $(git -C "$wt" merge-base --is-ancestor "$sha" "$rb" 2>/dev/null; print $?) == 0 ) ) ]] && on=1
            else
              # Origin unreachable or gone: local remote refs may be stale, so nothing is proven.
              last=$(stat -f %m "$repo/.git/FETCH_HEAD" 2>/dev/null || stat -c %Y "$repo/.git/FETCH_HEAD" 2>/dev/null)
              how=", origin unreachable, last fetch ${last:+$(( (now - last) / 86400 )) d ago}${last:-never}"
            fi
            (( online )) && for ref in $rdef; do
              git -C "$wt" cat-file -e "$ref^{commit}" 2>/dev/null && git -C "$wt" merge-base --is-ancestor "$sha" "$ref" 2>/dev/null && { merged=1; break; }
            done
            # Ignored files no install or build recreates (.env and the like) live only here;
            # the ones identical to the main checkout's copy don't count.
            lo=0
            ign=$(git -C "$wt" status --ignored --porcelain 2>/dev/null) || lo='?'
            [[ $lo == 0 ]] && for f in ${(f)"$(print -r -- "$ign" | sed -n 's/^!! //p' | grep -vE "$LOCAL_ONLY_SKIP")"}; do
              f=${f%/}
              [[ -f $wt/$f ]] && cmp -s "$wt/$f" "$main/$f" && continue
              [[ -d $wt/$f ]] && diff -rq "$wt/$f" "$main/$f" >/dev/null 2>&1 && continue
              (( lo++ ))
            done
            flag=
            if [[ -n $lock ]]; then flag=" LOCKED${lockwhy:+ ($lockwhy)}"
            elif used "$wt" "$wt"; then flag=' IN USE'
            elif (( now - ct < 7200 )); then flag=' ACTIVE (commit under 2 h ago)'
            fi
            # A squash merge leaves no ancestor to find; ask GitHub, only when it decides the row.
            if [[ -z $flag && -n $br && $dirty == 0 && $lo == 0 ]] && (( online && ! on && ! merged )) && command -v gh >/dev/null; then
              for o in ${(f)"$(cd "$repo" && perl -e 'alarm shift; exec @ARGV' 10 gh pr list --head "$br" --state merged --json headRefOid --jq '.[].headRefOid' </dev/null 2>/dev/null)"}; do
                # Same branch name isn't enough: the merged PR's head must be this commit or come after it.
                [[ $o == $sha ]] || { git -C "$wt" cat-file -e "$o^{commit}" 2>/dev/null && git -C "$wt" merge-base --is-ancestor "$sha" "$o" 2>/dev/null; } && { merged=2; break; }
              done
            fi
            unpushed=0
            (( on || merged )) || unpushed=$(git -C "$wt" rev-list --count "$sha" --not --remotes 2>/dev/null || print '?')
            (( merged == 2 )) && mtext='yes (squash)' || { (( merged )) && mtext=yes || mtext=no; }
            wt_rows+=("$size"$'\t'"$(gb $size) GB  $(tilde "$wt")  [${br:-detached}, $dirty dirty, $unpushed unpushed, on origin: $( (( ! online )) && print unknown || { (( on )) && print yes || print no; }), merged: $( (( online )) && print $mtext || print unknown), local-only files: $lo$how]$flag")
            if [[ -n $lock ]]; then
              print -r -- "locked worktree"$'\t'"$size"$'\t'"$(tilde "$wt")" >> "$held"
            elif [[ -z $flag && $dirty == 0 && $lo == 0 ]] && (( on || merged )); then
              sift "$wt" "$wt"
              if (( $#reply )); then
                GITROW[$wt]=1
                idle "$wt"; rec=$(( $? == 0 ))
                what="worktree $(tilde "$wt") ($( (( merged )) && print merged || print on origin), clean)"
                cand git Q $rec "$what" "git -C ${(q)repo} worktree remove ${(q)wt}" "$size" "$wt"
              fi
            fi
          fi
        fi
        wt= sha= br= lock= lockwhy= ;;
    esac
  done
done
rm -rf "$rdir"
if (( $#wt_rows )); then print -l -- $wt_rows | sort -t$'\t' -k1,1nr | cut -f2-
else print -r -- "(no linked worktrees under the project roots)"; fi
print -r -- "(a worktree goes in the table when it is clean, not in use or locked, on origin or merged,"
print -r -- " and its local-only files match the main checkout)"

# ---------------------------------------------------------------------------
h "PROJECTS (idle = no commit, edit or agent session in $IDLE d, and nothing running in it)"
typeset -A DISP
node='node_modules .next .nuxt .output .svelte-kit dist .turbo .vite .parcel-cache .expo coverage storybook-static android/build android/app/build android/.cxx android/app/.cxx android/.gradle ios/build'
py='.venv venv __pycache__ .pytest_cache .mypy_cache .ruff_cache .tox build dist'
gradle='build .gradle app/build .cxx app/.cxx'
DISP=(package.json "$node" Cargo.toml target pyproject.toml "$py" requirements.txt "$py" setup.py "$py" Pipfile "$py"
      build.gradle "$gradle" build.gradle.kts "$gradle" settings.gradle "$gradle" Podfile 'Pods build'
      pubspec.yaml '.dart_tool build' composer.json vendor Package.swift .build)
DEPS=(node_modules .venv venv Pods vendor .dart_tool)   # installs; the rest is build output
# Without git nothing says a folder is ignored output, and nothing else holds a copy:
# there, generic names like build/ or dist/ may be the user's work.
AMBIG=(build dist out vendor .build .output coverage storybook-static)
typeset -A PROJ TOPOF
if (( ${#ROOTS} )); then
  for m in ${(f)"$(find $ROOTS -maxdepth 6 \( $PRUNE -o -name Pods -o -name .dart_tool -o -name .build \) -prune -o -type f \( -name package.json -o -name Cargo.toml -o -name pyproject.toml -o -name requirements.txt -o -name setup.py -o -name Pipfile -o -name build.gradle -o -name build.gradle.kts -o -name settings.gradle -o -name Podfile -o -name pubspec.yaml -o -name composer.json -o -name Package.swift \) -print 2>/dev/null)"}; do
    d=${m:h}
    if [[ -z ${TOPOF[$d]} ]]; then
      TOPOF[$d]=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null || print -r -- "$d")
      # Inside another repo's ignored folder with nothing tracked: no git covers it.
      [[ ${TOPOF[$d]} != $d && -z $(git -C "$d" ls-files 2>/dev/null | head -1) ]] && TOPOF[$d]=$d
    fi
    top=${TOPOF[$d]}
    [[ -n ${GITROW[$top]} ]] && continue   # the whole worktree is already a row
    for rel in ${=DISP[${m:t}]}; do
      p=$d/$rel
      [[ -d $p ]] || continue
      # Only what git ignores: a tracked dist/ or build/ is content.
      if [[ -d $top/.git || -f $top/.git ]]; then
        git -C "$d" check-ignore -q -- "$rel" 2>/dev/null || continue
      else
        [[ $rel == */* ]] || (( ${AMBIG[(Ie)$rel]} )) && continue
      fi
      [[ $'\n'${PROJ[$top]}$'\n' == *$'\n'$p$'\n'* ]] || PROJ[$top]+=$p$'\n'
    done
  done
fi
proj_rows=()
for top in ${(k)PROJ}; do
  paths=(${(f)PROJ[$top]})
  sift "$top" $paths
  kept=($reply)
  (( $#kept )) || continue
  if idle "$top"; then
    names=(${(u)${kept[@]#$top/}})
    # A repo nested in another repo (an SDK's toolchain checkout) reads idle while in daily use: no rec.
    outer=$(git -C "${top:h}" rev-parse --show-toplevel 2>/dev/null)
    if [[ -d $top/.git && -n $outer ]]; then
      cand rebuild Q 0 "$(tilde "$top"): ${(j:, :)names[1,4]}${names[5]:+, …} ($(age_note), nested in $(tilde "$outer"))" rm - $kept
    else
      cand rebuild Q 1 "$(tilde "$top"): ${(j:, :)names[1,4]}${names[5]:+, …} ($(age_note))" rm - $kept
    fi
    sum_bytes $kept; proj_rows+=("$REPLY"$'\t'"$(tilde "$top")  $(age_note)")
  else
    # Active: only build output that regrows, never the installs.
    out=()
    for p in $kept; do (( ${DEPS[(Ie)${p:t}]} )) || out+=("$p"); done
    for nm in ${(M)kept:#*/node_modules}; do
      out+=(${(f)"$(find "$nm" -maxdepth 4 -type d \( -path '*/android/build' -o -path '*/android/.cxx' \) -prune -print 2>/dev/null)"})
    done
    if (( $#out )); then
      names=(${(u)${${out[@]#$top/}//node_modules\/*\/android\/*/android build in node_modules}})
      cand rebuild Q 0 "$(tilde "$top"): ${(j:, :)names[1,4]}${names[5]:+, …}" rm - $out
    fi
    sum_bytes $kept; proj_rows+=("$REPLY"$'\t'"$(tilde "$top")  active ($IDLE_NOTE)")
  fi
done
if (( $#proj_rows )); then
  print -l -- $proj_rows | sort -t$'\t' -k1,1nr | head -15 | awk -F'\t' '{ printf "%6.1f GB  %s\n", $1 / 1e9, $2 }'
else
  print -r -- "(no projects with build output or installs under the project roots)"
fi

# ---------------------------------------------------------------------------
# Rows outside projects. Printed in DETAILS only where a row needs more context.

# Superseded versions: junk once nothing runs them.
vdir=$HOME/.local/share/claude/versions
vs=("$vdir"/*(N))
if (( $#vs > 1 )); then
  # Keep the newest and whatever a claude on PATH or in ~/.local/bin points at (a pinned version).
  keep=($(print -l -- ${vs:t} | sort -V | tail -1))
  for b in "$HOME/.local/bin/claude" "$(command -v claude 2>/dev/null)"; do [[ -e $b && ${b:A} == $vdir/* ]] && keep+=("${${b:A}#$vdir/}"); done
  keep=(${keep%%/*})
  old=(); for v in $vs; do (( ${keep[(Ie)${v:t}]} )) || old+=("$v"); done
  sift "" $old; (( $#reply )) && cand none Q 1 "$(n_of $#reply 'old claude CLI version')" rm - $reply
fi
# Codex keeps releases per package; profiles may share one packages folder through symlinks.
# Keep the newest and whatever any profile's `current` link resolves to.
typeset -aU crel ckeep; old=()
for r in "$HOME"/.codex*/packages/*/releases(N-/); do crel+=("${r:A}"); done
for l in "$HOME"/.codex*/packages/*/current(N@); do [[ -e $l ]] && ckeep+=("${l:A}"); done
for r in $crel; do
  vs=("$r"/*(N/)); (( $#vs > 1 )) || continue
  newest=$(print -l -- ${vs:t} | sort -V | tail -1)
  for v in $vs; do [[ ${v:t} == $newest ]] || (( ${ckeep[(Ie)$v]} )) || old+=("$v"); done
done
sift "" $old; (( $#reply )) && cand none Q 1 "$(n_of $#reply 'old codex release')" rm - $reply
for base in "$HOME"/.vscode/extensions "$HOME"/.cursor/extensions "$HOME"/.windsurf/extensions; do
  [[ -d $base ]] || continue
  old=()
  # The editor's extensions.json names the active version, which may be older after a downgrade.
  active=(${(f)"$(python3 -I -c 'import json, sys
try: print("\n".join(e.get("relativeLocation", "") for e in json.load(open(sys.argv[1]))))
except Exception: pass' "$base/extensions.json" 2>/dev/null)"})
  for id in ${(f)"$(ls "$base" | sed -nE 's/-[0-9]+\.[0-9]+\.[0-9]+.*//p' | sort | uniq -d)"}; do
    vers=("$base/$id"-[0-9]*(N/))
    keep=(${vers:t}); keep=(${keep:*active})
    (( $#keep )) || keep=($(print -l -- ${vers:t} | sort -V | tail -1))
    for v in $vers; do (( ${keep[(Ie)${v:t}]} )) || old+=("$v"); done
  done
  sift "" $old; (( $#reply )) && cand none Q 1 "$(n_of $#reply "old ${${base:h:t}#.} extension version")" rm - $reply
done
upd=("$HOME"/Library/Caches/*([Ss]hip[Ii]t|updater)*(N/))
sift "" $upd; (( $#reply )) && cand none Q 1 "updater leftovers (${(j:, :)${reply:t}[1,3]})" rm - $reply

# Caches refill on their own. Browser profiles (Cookies, Local State, *-profile, User Data)
# hold logins and are not caches, wherever they sit.
profiles=() LOOKD=()
profile_roots() {  # profile_roots DIR: the profile folders inside DIR, as paths relative to DIR ('.' = DIR itself)
  local f r
  for f in ${(f)"$(find "$1" -maxdepth 5 \( -name Cookies -o -name 'Local State' -o -name '*-profile' -o -name 'User Data' \) -print 2>/dev/null)"}; do
    case ${f:t} in
      Cookies) r=${f:h}; [[ ${r:t} == (Default|Profile*) ]] && r=${r:h} ;;
      'Local State') r=${f:h} ;;
      *) r=$f ;;
    esac
    [[ $r == $1 ]] && print . || print -r -- "${r#$1/}"
  done | sort -u
}
is_profile() { [[ ${1:t} == (ms-playwright-mcp*|*-profile|User Data) || -n $(profile_roots "$1") ]]; }
hold_as() {  # hold_as REASON PATH: not a cache; listed under HELD BACK and counted on the held: line
  bytes "$2"; print -r -- "$1"$'\t'"$REPLY"$'\t'"$(tilde "$2")" >> "$held"; profiles+=("$2")
}
# A cargo target dir (CACHEDIR.TAG or .rustc_info.json next to debug/ or release/): a build, not a cache.
is_cargo_target() { [[ ( -f $1/CACHEDIR.TAG || -f $1/.rustc_info.json ) && ( -d $1/debug || -d $1/release ) ]]; }
for c in "$HOME"/Library/Caches/*(N/); do
  [[ ${c:t} == *([Ss]hip[Ii]t|updater)* ]] && continue
  if [[ ${c:t} == (ms-playwright|puppeteer|Cypress) ]]; then
    # Downloaded browsers: only the browser builds go; a profile kept next to them stays.
    bins=() 
    for b in "$c"/*(N/); do is_profile "$b" && hold_as 'browser profile' "$b" || bins+=("$b"); done
    sift "" $bins; (( $#reply )) && cand download Q 1 "$(tilde "$c"): $(n_of $#reply 'browser build')" rm - $reply
    continue
  fi
  if is_cargo_target "$c"; then
    sift "" "$c"; (( $#reply )) && cand rebuild Q 0 "$(tilde "$c") (cargo build cache)" rm - "$c"
    continue
  fi
  roots=(${(f)"$(profile_roots "$c")"})
  deep=0; shallow=0
  for r in $roots; do [[ $r == . || $r != */* ]] && shallow=1 || deep=1; done
  [[ ${c:t} == (ms-playwright-mcp*|*-profile|User Data) ]] && shallow=1
  cargo=0; for ch in "$c"/*(N/); do is_cargo_target "$ch" && cargo=1; done
  if (( ! shallow && ( deep || cargo ) )); then
    # Not one app's cache: a tool keeps builds, sandboxes or profiles here. Judge each child;
    # anything that is neither a build nor a profile may be state, so it only gets a look.
    for ch in "$c"/*(N/); do
      if is_cargo_target "$ch"; then
        sift "" "$ch"; (( $#reply )) && cand rebuild Q 0 "$(tilde "$ch") (cargo build cache)" rm - "$ch"
      elif is_profile "$ch"; then
        never "$ch" || hold_as 'holds a browser profile' "$ch"
      else
        never "$ch" && continue
        bytes "$ch"; (( REPLY >= MIN )) && LOOKD+=("$REPLY"$'\t'"$(tilde "$ch")"$'\t'"in $(tilde "$c"), which isn't one app's cache")
      fi
    done
    continue
  fi
  (( shallow )) && { hold_as 'browser profile' "$c"; continue; }
  # JetBrains keeps Local History (your edit history) under Caches.
  [[ -n $(find "$c" -maxdepth 3 -name LocalHistory -print -quit 2>/dev/null) ]] && { hold_as 'editor history' "$c"; continue; }
  sift "" "$c"; (( $#reply )) || continue
  # An update an app downloaded (Sparkle, Mozilla's updater) is junk once installed or skipped.
  u=; [[ -d $c/org.sparkle-project.Sparkle ]] && u=$c/org.sparkle-project.Sparkle
  [[ ${c:t} == Mozilla && -d $c/updates ]] && u=$c/updates
  if [[ -n $u ]]; then bytes "$c"; cb=$REPLY; bytes "$u"; fi
  if [[ -n $u ]] && (( REPLY * 2 >= cb )); then
    cand none Q 1 "$(tilde "$c") (mostly a downloaded app update)" rm - "$c"
  else
    cand regrows Q 1 "$(tilde "$c")" rm - "$c"
  fi
done
# npm, uv and pip refill as you install. Gradle and cargo re-download, then rebuild, on the next build.
for c in "$HOME"/.npm/_cacache "$HOME"/.cache/uv "$HOME"/.cache/pip "$HOME"/.gradle/caches "$HOME"/.cargo/registry/cache; do
  [[ -d $c ]] || continue
  [[ $c == */(.gradle/caches|.cargo/registry/cache) ]] && back=download || back=regrows
  sift "" "$c"; (( $#reply )) && cand $back Q 1 "$(tilde "$c")" rm - "$c"
done
npx=("$HOME"/.npm/_npx/*(N/))
sift "" $npx; (( $#reply )) && cand regrows Q 1 "$(n_of $#reply 'npx package folder') nothing runs from" rm - $reply
for s in "$HOME"/Library/pnpm/store "$HOME"/.local/share/pnpm/store; do
  [[ -d $s ]] && command -v pnpm >/dev/null || continue
  sift "" "$s"; (( $#reply )) && cand regrows Q 1 "pnpm store, unreferenced packages (du overstates: hardlinks)" "pnpm store prune" - "$s"
done
dd_idle=() dd_recent=()
for d in "$HOME"/Library/Developer/Xcode/DerivedData/*(N/); do
  [[ -z $(find "$d" -type f -mtime -$IDLE -print -quit 2>/dev/null) ]] && dd_idle+=("$d") || dd_recent+=("$d")
done
sift "" $dd_idle;   (( $#reply )) && cand rebuild Q 1 "Xcode DerivedData, $(n_of $#reply project) untouched $IDLE+ d" rm - $reply
sift "" $dd_recent; (( $#reply )) && cand rebuild Q 0 "Xcode DerivedData, $(n_of $#reply 'recent project')" rm - $reply

# Downloads nothing uses: simulator runtimes without a device, emulator images without an AVD.
h "SYSTEM SIDE"
if command -v xcrun >/dev/null; then
  for line in ${(f)"$(simrt "$(xcrun simctl runtime list -j 2>/dev/null)" "$(xcrun simctl list devices -j 2>/dev/null)")"}; do
    IFS=$'\t' read -r uid sz name build mnt n del dropped <<< "$line"
    print -r -- "runtime $name ($build): $(gb $sz) GB, $n simulator(s)$( (( dropped )) && print ', dropped from the asset catalogue: deleting leaves an SIP-protected .asset, only Recovery mode frees it')"
    (( n == 0 && del && ! dropped )) || continue
    sift "" "$mnt"; (( $#reply )) && cand download Q 1 "$name simulator runtime (no simulator uses it)" "xcrun simctl runtime delete $uid" "$sz" "$mnt"
  done
  # Runtimes an Xcode update dropped from the catalogue (System/Library/AssetsV2/*/…xml).
  for a in /System/Library/AssetsV2/com_apple_MobileAsset_*SimulatorRuntime/*.asset(N); do
    b=$(plutil -extract MobileAssetProperties.Build raw "$a/Info.plist" 2>/dev/null)
    grep -q "<string>$b</string>" "${a:h}"/*.xml 2>/dev/null && continue
    bytes "$a"; print -r -- "$(gb $REPLY) GB  $a  build $b not in the catalogue: a simctl or Xcode delete leaves this behind, only Recovery mode frees it"
  done
fi
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}
imgs=("$sdk"/system-images/*/*/*(N/))
if (( $#imgs )); then
  usedimg=(${(f)"$(cat "${ANDROID_AVD_HOME:-$HOME/.android/avd}"/*.avd/config.ini 2>/dev/null | sed -n 's/^image\.sysdir\.1 *= *//p')"})
  spare=(); for i in $imgs; do (( ${usedimg[(I)${i#$sdk/}*]} )) || spare+=("$i"); done
  sift "" $spare; (( $#reply )) && cand download Q 1 "$(n_of $#reply 'Android system image') no emulator uses" rm - $reply
fi
if [[ $(uname) == Darwin ]]; then
  diskutil info / 2>/dev/null | grep -E "Container Free Space" | sed 's/^ *//'
  print -r -- "local snapshots: $(tmutil listlocalsnapshots / 2>/dev/null | grep -vc '^Snapshots for')"
  du -xsk /System/Library/AssetsV2/* "/Library/Application Support"/* 2>/dev/null | sort -rn | head -6 \
    | awk -F'\t' '{ printf "%.1f GB  %s\n", $1 * 1024 / 1e9, $2 }'
fi
for v in "$HOME/Library/Application Support/Claude/vm_bundles" "$HOME/Library/Containers/com.docker.docker" "$sdk" \
         "$HOME/.gradle" "$HOME/Library/Developer/CoreSimulator/Devices"; do
  [[ -e $v ]] || continue
  bytes "$v"; b=$REPLY; (( b >= 50000000 )) && print -r -- "$(gb $b) GB  $(tilde "$v")"
done
(( $#profiles )) && { pl=(); for x in $profiles; do bytes "$x"; pl+=("$(tilde "$x") $(gb $REPLY) GB"); done
  print -r -- "not caches, though they sit in Caches (browser logins, editor local history; also under HELD BACK): ${(j:, :)pl}"; }

# ---------------------------------------------------------------------------
h "DRAINS"
print -r -- "swap: $(sysctl -n vm.swapusage 2>/dev/null) (on the same disk; returns when apps close)"
print -r -- "claude sessions: $(pgrep -x claude | grep -c .), codex processes: $(pgrep -f codex | grep -c .), MCP helpers: $(pgrep -f mcp | grep -c .)"
print -r -- "big files written in the last 3 days outside home:"
find /Applications /Library /System/Library/AssetsV2 /private/var/folders -xdev -type f -size +200M -mtime -3 2>/dev/null \
  | while read -r f; do printf "  %s\t%s\t%s\n" "$(du -h "$f" | cut -f1)" "$(stat -f %Sm -t '%m-%d %H:%M' "$f" 2>/dev/null)" "$f"; done | sort -rh | head -6

# ---------------------------------------------------------------------------
h "NEEDS A LOOK (may be the only copy)"
look=(${(f)"$(find "$HOME"/Downloads "$HOME"/Desktop "$HOME"/Documents $ROOTS -maxdepth 4 -type f \( -name '*.zip' -o -name '*.dmg' -o -name '*.pkg' -o -name '*.iso' -o -name '*.tar.gz' -o -name '*.7z' \) -size +100M 2>/dev/null | sort -u)"})
look_b=0
for f in $look; do bytes "$f"; b=$REPLY; (( look_b += b )); print -r -- "$(gb $b) GB  $(tilde "$f")"; done
# Big folders under the project roots that no install or build recreates: gitignored content
# (renders, run logs, scratch output) and folders outside any repo. The shallowest such folder only.
skipname='(node_modules|.git|.next|.nuxt|.turbo|.venv|venv|target|Pods|.gradle|build|dist|DerivedData|.expo|.dart_tool|vendor)'
done_l=()
if (( $#SZ )); then
  for rel in ${(o)${(k)SZ}}; do
    (( SZ[$rel] >= LOOKMIN )) || continue
    p=$HOME/$rel; inr=0
    for r in $ROOTS; do [[ $p == $r/* ]] && inr=1; done
    (( inr )) || continue
    [[ /$rel/ == */${~skipname}/* ]] && continue
    under=0; for d in $done_l; do [[ $p == $d/* ]] && under=1; done; (( under )) && continue
    never "$p" && continue; covers "$p" $KEEP && continue
    if top=$(git -C "$p" rev-parse --show-toplevel 2>/dev/null); then
      [[ ${top:A} == ${p:A} ]] && continue
      git -C "$top" check-ignore -q -- "${p#$top/}" 2>/dev/null || continue
      LOOKD+=("${SZ[$rel]}"$'\t'"$(tilde "$p")"$'\t'"gitignored in $(tilde "$top")"); done_l+=("$p")
    elif [[ -z $(find "$p" -maxdepth 3 -name .git -print -quit 2>/dev/null) ]]; then
      LOOKD+=("${SZ[$rel]}"$'\t'"$(tilde "$p")"$'\t'"not in git"); done_l+=("$p")
    fi
  done
fi
if (( $#LOOKD )); then
  print -l -- $LOOKD | sort -t$'\t' -k1,1nr | awk -F'\t' '{ printf "%.1f GB  %s  (%s)\n", $1 / 1e9, $2, $3 }'
  for x in $LOOKD; do (( look_b += ${x%%$'\t'*} )); done
fi
print -r -- "$(( $#look + $#LOOKD ))"$'\t'"$look_b" > "$acts.look"
print -r -- "(archive: is it really extracted? dmg/pkg: is the app installed? a repo-shaped copy: git status and unpushed commits;"
print -r -- " a content folder: the user's call, whatever its size)"

# ---------------------------------------------------------------------------
h "HELD BACK"
sort -t$'\t' -k2,2nr "$held" | awk -F'\t' -v min=$MIN '$2 >= min { printf "%6.1f GB  %s  [%s]\n", $2 / 1e9, $3, $1 }' | head -30
for t in $LOCKED_TREES; do print -r -- "lock held: $(tilde "$t")/$LOCK_DIR"; done
print -r -- "dev processes:"
ps -axo pid,command 2>/dev/null \
  | grep -E "(^|[ /])(jest|vitest|next-server|webpack|vite|rollup|esbuild|tsc|tsx|gradle|gradlew|xcodebuild|metro|docker|simctl|mongod|postgres|redis-server)( |$)|next dev|node --watch|(npm|pnpm|yarn) (run )?(dev|build|test|start)( |$)|expo start" \
  | grep -v grep | cut -c1-140 | sed 's/^/  /' | head -12

if [[ -f $snap ]]; then
  unk=$(python3 -I "$report" unreadable "$snap" 2>/dev/null)
  h "UNKNOWN (what the scan couldn't see)"
  if [[ -n $unk ]]; then
    print -r -- "$unk" | head -6 | while IFS=$'\t' read -r n u; do print -r -- "~/$u: $n unreadable (this folder or one inside it)"; done
    [[ $(uname) == Darwin ]] && print -r -- "(Full Disk Access for the terminal makes these readable)"
  fi
  # How much of the used space the scan saw: the home map plus the big folders outside it.
  if [[ $(uname) == Darwin ]]; then
    homeb=$(awk '!/^#/ { s += $NF } END { printf "%.0f", s }' "$snap")
    outk=$(du -xsk /Applications /Library /opt/homebrew /usr/local /private/var/folders /private/var/db /private/var/vm 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')
    usedb=$(( $(df -k "$vol" | awk 'NR == 2 { print $3 }') * 1024 ))
    seen=$(( homeb + outk * 1024 ))
    print -r -- "measured: home $(gb $homeb) GB + apps and system folders $(gb $(( outk * 1024 ))) GB = $(gb $seen) GB of $(gb $usedb) GB used; $(gb $(( usedb > seen ? usedb - seen : 0 ))) GB not seen (unreadable folders, other system files, purgeable space)"
  fi
fi
}

details > "$body"

# ---------------------------------------------------------------------------
# QUICK WINS first: the biggest rows, then the rec set and what it would leave free.
vol=$HOME; [[ -d /System/Volumes/Data ]] && vol=/System/Volumes/Data
free=$(( $(df -k "$vol" | awk 'NR == 2 { print $4 }') * 1024 ))
print -r -- "QUICK WINS · $(gb $free) GB free"
sort -t$'\t' -k1,1nr "$cands" | awk -F'\t' -v min=$MIN -v free=$free -v acts="$acts" -v rows=$ROWS '
  $1 >= min && n < rows {
    n++; id = ($3 == "R") ? "R" (++r) : "Q" (++q)
    if (n == 1) printf "%-4s %5s  %-8s  %s\n", "ID", "GB", "back", "what"
    printf "%-4s %5.1f  %-8s  %s\n", id, $1 / 1e9, $2, $5
    print id "\t" $6 > acts
    if ($4 == 1 && $3 != "R") { rec = rec " " id; rb += $1 }
    if ($3 == "R") anyr = 1
  }
  END {
    if (!n) { print "nothing over " min / 1e6 " MB to take right now"; exit }
    print "back: none = junk · regrows = on its own · rebuild = install/build · download = on next use · git = from origin"
    if (anyr) print "R = deleting needs your password"
    if (rec) printf "rec =%s · %.1f → ~%.1f GB free\n", rec, free / 1e9, (free + rb) / 1e9
    else print "rec = nothing safe to take without asking"
  }'
held_line=$(awk -F'\t' -v min=$MIN '$2 >= min { c[$1]++; b[$1] += $2 } END { for (k in c) printf "%s%d %s %.1f GB", (s++ ? " · " : ""), c[k], k, b[k] / 1e9 }' "$held")
read -r look_n look_b < "$acts.look" 2>/dev/null; rm -f "$acts.look"
line=${held_line:+held: $held_line}
(( ${look_n:-0} )) && line+="${line:+ · }needs a look: $look_n, $(gb $look_b) GB"
[[ -n $line ]] && print -r -- "$line"

cat "$body"
h "ACTIONS (the command behind each ID; recheck.sh re-checks for use right before it deletes)"
cat "$acts"
printf '\nSurvey only, nothing deleted. %d s.\n' $(( SECONDS - t0 ))
