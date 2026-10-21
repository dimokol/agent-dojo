#!/usr/bin/env bash
# Tests for the disk-map skill: report.py on fixtures, map.sh against a stub dua,
# and one real dua run when dua is installed. Runs on macOS and Linux; needs python3.
set -u
here=$(cd "$(dirname "$0")" && pwd)
dm="$here/../skills/disk-map/scripts"
fail=0
check() { if [ "$2" = ok ]; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
has() { case "$1" in *"$2"*) echo ok;; *) echo bad;; esac; }
py() { python3 -I "$dm/report.py" "$@"; }

command -v python3 >/dev/null 2>&1 || { echo "python3 not installed, skipping"; exit 0; }
tmp=$(mktemp -d) || exit 1
: "${tmp:?mktemp failed}"
trap 'chmod -R u+rwx "${tmp:?}" 2>/dev/null; rm -rf "${tmp:?}"' EXIT

# What `dua -f bytes aggregate --no-total -d 3` prints: pre-order, two spaces of
# indent per level, IO errors counted up the tree. " lead" starts with a space.
cat > "$tmp/agg.txt" <<'EOF'
         0 b locked  <1 IO Error>
      4096 b  lead
      4096 b   h
      8192 b a  <1 IO Error>
      4096 b   deep
      4096 b     x
         0 b   shut  <1 IO Error>
      4096 b   y.txt
      4096 b file.txt
      8192 b sp ace
      8192 b   in
      8192 b     g
EOF
py convert --header "root=/r depth=3 flags=-x when=t" < "$tmp/agg.txt" > "$tmp/a.stacks"
head -1 "$tmp/a.stacks" | grep -q '^#disk-map root=/r depth=3 flags=-x when=t unreadable=2$' && s=ok || s=bad
check "convert: header records 2 unreadable" $s
got=$(grep -v '^#' "$tmp/a.stacks" | LC_ALL=C sort)
want=$(printf '%s\n' ' lead;h 4096' 'a;deep;x 4096' 'a;y.txt 4096' 'file.txt 4096' 'sp ace;in;g 8192' | LC_ALL=C sort)
[ "$got" = "$want" ] && s=ok || s=bad; check "convert: leaves match dua stacks, spaces kept" $s
u=$(py unreadable "$tmp/a.stacks" | LC_ALL=C sort)
[ "$u" = "$(printf '1\ta/shut\n1\tlocked')" ] && s=ok || s=bad; check "unreadable: each folder once, not its parent" $s

out=$(py summary "$tmp/a.stacks")
check "summary: states decimal units" "$(has "$out" '1 GB = 10^9 bytes')"
check "summary: reports unknown size" "$(has "$out" 'unknown: 2 unreadable paths')"
p=$(py prefixes "$tmp/a.stacks" | LC_ALL=C sort)
case "$p" in *$'8192\ta'*) s=ok;; *) s=bad;; esac; check "prefixes: folder totals" $s

py html "$tmp/a.stacks" "$tmp/a.html" >/dev/null
html=$(cat "$tmp/a.html")
check "html: unknown in the subtitle" "$(has "$html" 'Unknown: 2 unreadable paths')"
check "html: table rows open folders" "$(has "$html" 'tr.onclick')"

# Rebuildable names: a browser profile inside Caches is not a cache; a cache
# inside a profile is; a build folder inside node_modules stays node_modules.
cat > "$tmp/c.stacks" <<'EOF'
#disk-map root=/h depth=8 flags=-x when=t
Library;Caches;ms-playwright-mcp;p1;Default;Cookies 100000
Library;Caches;ms-playwright-mcp;p1;Default;Cache;x 50000
Library;Caches;Homebrew;y 30000
app;node_modules;pkg;build;z 10000
EOF
out=$(py summary "$tmp/c.stacks")
check "classify: profile gets its own line" "$(has "$out" 'browser profiles (hold logins, not a cache), 1 place(s); biggest: Library/Caches/ms-playwright-mcp 100 KB')"
check "classify: cache inside a profile is a cache" "$(has "$out" 'Cache (app cache)')"
check "classify: Caches keeps the rest" "$(has "$out" '30 KB  Caches (app caches)')"
check "classify: node_modules wins over a nested build" "$(has "$out" 'node_modules (JS dependencies)')"
case "$out" in *'build (build output)'*) s=bad;; *) s=ok;; esac; check "classify: no build line from inside node_modules" $s

# Diff: headered scans compare; a headerless one is refused unless told.
printf '#disk-map root=/r depth=3 flags=-x when=t2 unreadable=0\na;deep;x 9096\nfile.txt 4096\n' > "$tmp/b.stacks"
out=$(py diff "$tmp/a.stacks" "$tmp/b.stacks" 2>&1)
check "diff: shows growth" "$(has "$out" '+5 KB  a/deep/x')"
grep -v '^#' "$tmp/a.stacks" > "$tmp/bare.stacks"
out=$(py diff "$tmp/bare.stacks" "$tmp/b.stacks" 2>&1); st=$?
[ $st -ne 0 ] && [ "$(has "$out" 'no #disk-map header')" = ok ] && s=ok || s=bad
check "diff: refuses a headerless snapshot" $s
py diff "$tmp/bare.stacks" "$tmp/b.stacks" --same-root >/dev/null 2>&1 && s=ok || s=bad
check "diff: --same-root lets it through" $s

# map.sh against a stub dua and a fixed clock: version gate and name collisions.
mkdir -p "$tmp/bin" "$tmp/tree" "$tmp/out"
cat > "$tmp/bin/dua" <<EOF
#!/usr/bin/env bash
[ "\$1" = --version ] && { echo "dua \${STUB_DUA_VERSION:-2.46.0}"; exit 0; }
echo "\$@" > "$tmp/dua-args"
cat "$tmp/agg.txt"
EOF
printf '#!/usr/bin/env bash\necho 2026-01-01-000000\n' > "$tmp/bin/date"
chmod +x "$tmp/bin/dua" "$tmp/bin/date"
run() { PATH="$tmp/bin:$PATH" bash "$dm/map.sh" "$tmp/tree" "$tmp/out" 3 2>&1; }
o1=$(run); o2=$(run)
s1=$(printf '%s\n' "$o1" | sed -n 's/^snapshot: //p'); s2=$(printf '%s\n' "$o2" | sed -n 's/^snapshot: //p')
[ -n "$s1" ] && [ "$s1" != "$s2" ] && [ -f "$s1" ] && [ -f "$s2" ] && s=ok || s=bad
check "map.sh: same-second runs don't overwrite" $s
case "$s2" in *-000000-2.stacks) s=ok;; *) s=bad;; esac; check "map.sh: collision gets a -2 suffix" $s
check "map.sh: prints the treemap path" "$(has "$o1" 'treemap:  ')"
o=$(STUB_DUA_VERSION=2.42.1 run); st=$?
[ $st -ne 0 ] && [ "$(has "$o" 'needs 2.43 or newer')" = ok ] && s=ok || s=bad
check "map.sh: refuses dua older than 2.43" $s
if [ "$(uname)" = Darwin ]; then
  o=$(STUB_DUA_VERSION=2.44.0 run)
  [ "$(has "$o" "can't deduplicate APFS clones")" = ok ] && ! grep -q deduplicate "$tmp/dua-args" && s=ok || s=bad
  check "map.sh: dua 2.44 runs without clone dedupe and says so" $s
fi

# A real scan with an unreadable folder, when dua is installed and we're not root.
if command -v dua >/dev/null 2>&1 && [ "$(id -u)" -ne 0 ]; then
  mkdir -p "$tmp/real/open" "$tmp/real/shut" "$tmp/realout"
  echo hi > "$tmp/real/open/f"; echo no > "$tmp/real/shut/f"; chmod 000 "$tmp/real/shut"
  o=$(bash "$dm/map.sh" "$tmp/real" "$tmp/realout" 3 2>&1)
  snap=$(printf '%s\n' "$o" | sed -n 's/^snapshot: //p')
  head -1 "$snap" 2>/dev/null | grep -q 'unreadable=1$' && s=ok || s=bad
  check "real dua: chmod 000 folder counted as unreadable" $s
  check "real dua: summary says so" "$(has "$o" 'unknown: 1 unreadable paths')"
  chmod 755 "$tmp/real/shut"
else
  echo "skip real dua run (dua missing or running as root)"
fi

[ "$fail" -eq 0 ] && echo "all passed" || echo "failures"
exit "$fail"
