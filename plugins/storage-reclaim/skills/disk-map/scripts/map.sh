#!/usr/bin/env bash
# disk-map: read-only scan of one folder or mount. Deletes nothing, ever.
# Usage: bash map.sh <path> [out-dir, default ~/.local/state/disk-map] [depth, default 6]
# Writes <out-dir>/<name>-<date>.stacks (the snapshot), .txt (summary), .html (treemap)
# and prints the summary. Needs dua (dua-cli) 2.43+ and python3. Works on macOS,
# Linux, and Windows under Git Bash or WSL.
set -euo pipefail

target=${1:?usage: map.sh <path> [out-dir] [depth]}
out=${2:-$HOME/.local/state/disk-map}
out=${out%/}
depth=${3:-6}
here=$(cd "$(dirname "$0")" && pwd)
install="brew install dua-cli, cargo install dua-cli, or a release binary from github.com/Byron/dua-cli/releases"
command -v dua >/dev/null || { echo "dua is missing: $install" >&2; exit 1; }
py=$(command -v python3 || command -v python) || { echo "python3 is missing" >&2; exit 1; }

# 2.43 added `aggregate --depth`, which this relies on; 2.45 added --deduplicate-apfs-clones.
ver=$(dua --version | awk '{print $2}')
IFS=. read -r vmaj vmin _ <<< "$ver"
vnum=$(( ${vmaj:-0} * 1000 + ${vmin:-0} ))
(( vnum >= 2043 )) || { echo "dua $ver is too old; disk-map needs 2.43 or newer: $install" >&2; exit 1; }

mkdir -p "$out"
name=$(basename "$(cd "$target" && pwd)" | tr ' /' '__')
[ "$name" = "_" ] || [ -z "$name" ] && name=root
stamp=$(date +%Y-%m-%d-%H%M%S)
base="$out/$name-$stamp"
i=2
while [ -e "$base.stacks" ]; do base="$out/$name-$stamp-$i"; i=$((i + 1)); done
snap="$base.stacks"

flags=(-x)
# APFS clones share blocks; without this flag a cloned tree counts twice.
if [ "$(uname)" = Darwin ]; then
  if (( vnum >= 2045 )); then flags+=(--deduplicate-apfs-clones)
  else echo "NOTE: dua $ver can't deduplicate APFS clones (2.45+ can); cloned folders may count twice."; fi
fi

echo "== free space on the volume holding $target"
df -h "$target" | tail -1
echo
root=$(cd "$target" && pwd)
# `dua stacks` skips unreadable folders without a word, so read the tree from
# `aggregate`, which marks them, and convert it to the same snapshot format.
# The first line records how the scan was made; report.py reads it, other tools skip it.
dua "${flags[@]}" -f bytes aggregate --no-total -d "$depth" "$target" 2>/dev/null \
  | "$py" -I "$here/report.py" convert \
      --header "root=$root depth=$depth flags=$(IFS=,; echo "${flags[*]}") when=$stamp" > "$snap" || true
n=$(sed -n '1s/.*unreadable=\([0-9]*\).*/\1/p' "$snap")
if [ "${n:-0}" -gt 0 ] && [ "$(uname)" = Darwin ]; then
  echo "NOTE: on macOS, Full Disk Access for the terminal lets the scan read ~/Library and the media folders."
  echo
fi

"$py" -I "$here/report.py" summary "$snap" | tee "$base.txt"
echo
"$py" -I "$here/report.py" html "$snap" "$base.html" --title "$target, $stamp" >/dev/null
echo "summary:  $base.txt"
echo "treemap:  $base.html"
echo "snapshot: $snap"
