#!/bin/sh
# Shared status line: client.sh starts server.mjs, renders through it, replaces a dead server
# (its socket or endpoint file left behind) and picks up config changes. Needs node and curl.
HERE=$(cd "$(dirname "$0")" && pwd)
SRC=$HERE/../statusline
command -v node >/dev/null && command -v curl >/dev/null || { echo "  skip  (needs node and curl)"; exit 0; }
WORK=$(mktemp -d)
: "${WORK:?mktemp failed}"
# Git Bash: node is native and only understands C:/... paths, so use that form throughout.
command -v cygpath >/dev/null 2>&1 && WORK=$(cygpath -m "$WORK")
pass=0; fail=0
ok() { pass=$((pass+1)); echo "  ok    $1"; }
bad() { fail=$((fail+1)); echo "  FAIL  $1 (got: $2)"; }
has() { case $3 in *"$2"*) ok "$1" ;; *) bad "$1 want *$2*" "$3" ;; esac; }

# Unix socket paths are limited to ~104 bytes, so the state dir sits in a short temp path.
# LOCALAPPDATA: on Windows the server looks for the real agent-chat install there, ahead of the test's stubs.
export SHARED_STATUSLINE_DIR="$WORK/s" SHARED_STATUSLINE_CONFIG="$WORK/config.json" NO_COLOR=1 LOCALAPPDATA="$WORK/no-localappdata"
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
out=$(render)
case $out in *starting*|*"Test Model"*) ok "first render: placeholder (or the reply, if a server was already up)" ;; *) bad "first render" "$out" ;; esac
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
i=0; out=""; while [ $i -lt 30 ]; do out=$(render); case $out in *Test*) break ;; esac; sleep 0.1; i=$((i+1)); done
has "renders again" "Test Model" "$out"

echo "== per tab: config dir and env come with the request"
mkdir -p "$WORK/acroot"
for p in a b; do
  m=$WORK/cfg-$p/plugins/cache/dimokol/agent-chat/1.0.0/server
  mkdir -p "$m"
  printf 'export function statuslineName() { return "name-%s" }\n' "$p" >"$m/statusline-name.mjs"
done
printf '{"lines":[["agent-chat"],["pressure"]]}' >"$WORK/config.json"
out=$(printf '%s' "$INPUT" | AGENT_CHAT_ROOT=$WORK/acroot CLAUDE_CONFIG_DIR=$WORK/cfg-a sh "$WORK/bin/client.sh")
has "profile a gets its agent-chat copy" "name-a" "$out"
out=$(printf '%s' "$INPUT" | AGENT_CHAT_ROOT=$WORK/acroot CLAUDE_CONFIG_DIR=$WORK/cfg-b sh "$WORK/bin/client.sh")
has "profile b gets its own" "name-b" "$out"
# RAM, not disk: on Windows only memory reaches RED.
out=$(printf '%s' "$INPUT" | MACHINE_PRESSURE_RAM_AMBER=0 MACHINE_PRESSURE_RAM_RED=1 sh "$WORK/bin/client.sh")
i=0; while [ $i -lt 30 ]; do case $out in *"pressure RED"*) break ;; esac; sleep 0.2; out=$(printf '%s' "$INPUT" | MACHINE_PRESSURE_RAM_AMBER=0 MACHINE_PRESSURE_RAM_RED=1 sh "$WORK/bin/client.sh"); i=$((i+1)); done
has "a tab's own thresholds apply" "pressure RED" "$out"
rm -f "$WORK/config.json"

echo "== timing"
start=$(node -e 'console.log(Date.now())')
n=0; while [ $n -lt 20 ]; do render >/dev/null; n=$((n+1)); done
end=$(node -e 'console.log(Date.now())')
echo "  info  $(( (end - start) / 20 )) ms per render (20 renders)"

echo "== session tokens: read in the background"
printf '{"message":{"id":"m1","usage":{"input_tokens":1000,"output_tokens":200}}}\n{"message":{"id":"m1","usage":{"input_tokens":1000,"output_tokens":500}}}\n{"message":{"id":"m2","usage":{"input_tokens":300,"cache_read_input_tokens":200,"output_tokens":0}}}\n' >"$WORK/t.jsonl"
printf '{"lines":[[{"type":"text","text":"T"},"session-tokens"]]}' >"$WORK/config.json"
TIN=$(printf '{"session_id":"x","transcript_path":"%s"}' "$WORK/t.jsonl")
i=0; out=""; while [ $i -lt 20 ]; do out=$(printf '%s' "$TIN" | sh "$WORK/bin/client.sh"); case $out in *2.0k*) break ;; esac; sleep 0.1; i=$((i+1)); done
has "total counts each message id once" "T | 2.0k" "$out"
rm -f "$WORK/config.json"

echo "== shutdown removes server.pid"
if command -v taskkill >/dev/null 2>&1; then
  # Git Bash can't send SIGTERM to a native process, and taskkill /F runs no handler.
  echo "  skip  pid file and endpoint removal (no SIGTERM to native node on Windows)"
else
  pid=$(cat "$WORK/s/server.pid")
  kill -TERM "$pid"; i=0; while kill -0 "$pid" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done
  [ -f "$WORK/s/server.pid" ] && bad "pid file removed" "still there" || ok "pid file removed"
  up && bad "socket or endpoint removed" "still there" || ok "socket or endpoint removed"
fi

echo "== a server that can't start says so"
printf '#!/bin/sh\nexit 1\n' >"$WORK/badnode"; chmod +x "$WORK/badnode"
B="$WORK/bad"
o1=$(printf '%s' "$INPUT" | SHARED_STATUSLINE_DIR=$B SHARED_STATUSLINE_NODE=$WORK/badnode sh "$WORK/bin/client.sh")
has "first failed start: placeholder" "starting" "$o1"
o2=$(printf '%s' "$INPUT" | SHARED_STATUSLINE_DIR=$B SHARED_STATUSLINE_NODE=$WORK/badnode sh "$WORK/bin/client.sh")
has "second failed start: names the log" "server failed, see $B/server.log" "$o2"

echo "== load log: top and groups"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { summarize } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  const r = summarize([
    ' 50.0 204800 /Users/x/.local/share/claude/versions/2.1.0 --resume',
    ' 10.0 102400 node /p/node_modules/vitest/vitest.mjs run',
    '  5.0 102400 node /p/node_modules/.bin/vitest',
    '  1.0  10240 /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
  ])
  console.log(r.top + ' || ' + r.groups)")
has "top names the claude binary" "claude=50%/200M" "$out"
has "top names the node package" "node:vitest=10%/100M" "$out"
has "vitest workers summed" "vitest=2/15%/200M" "$out"
has "an app named by its bundle" "Visual_Studio_Code=1%/10M" "$out"

echo "== Windows pressure level: memory short is RED, a CPU spike or low disk AMBER"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { windowsPressure } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  const at = r => windowsPressure({}, r).at(-1)
  console.log([at({ cpu: 99, ram: 50, disk: 100 }), at({ cpu: 10, ram: 50, disk: 5 }), at({ cpu: 10, ram: 95, disk: 100 })].join(' / '))")
has "windows levels" "pressure AMBER / pressure AMBER / pressure RED" "$out"

echo "== Windows commit charge: shown after RAM, RED like the gate"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { windowsPressure } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  console.log(windowsPressure({}, { cpu: 10, ram: 50, commit: 95, disk: 100 }).join(' | '))
  process.exit(0)")
has "commit segment and RED" "RAM 50% | commit 95% | disk 100G | pressure RED" "$out"

echo "== Windows pressure keeps refreshing after the first reading"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { pressureParts } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  const reads = [{ cpu: 30, ram: 40, commit: null, disk: 100 }, { cpu: 12, ram: 41, commit: 43, disk: 100 }, { cpu: 50, ram: 42, commit: 44, disk: 100 }]
  let t = Date.now(), i = 0
  Date.now = () => t
  const seen = []
  for (const r of reads) { seen.push((await pressureParts({}, { windows: true, readings: () => reads[i] })).slice(0, 3).join(' | ')); i++; t += 5000 }
  console.log(seen.join(' / '))
  process.exit(0)")
has "windows readings refresh" "CPU 30% | RAM 40% | commit … / CPU 12% | RAM 41% | commit 43% / CPU 50% | RAM 42% | commit 44%" "$out"

echo "== drive label: the disk segment names its drive when there are 2+ local drives"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const m = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  const w = m.parseWindowsDrives('C:\r\nd:\r\n\r\nE:\r\n')
  const one = d => d ? d.label + '@' + d.mount : 'none'
  console.log('win=' + w.join(','))
  console.log('wpick=' + one(m.pickDrive('D:\\\\work\\\\x', w, true)) + ' unc=' + one(m.pickDrive('\\\\\\\\srv\\\\share\\\\x', w, true)))
  const mounts = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
    '/dev/disk5s1 on /Volumes/T7 Shield (apfs, local, nodev, nosuid, journaled, noowners)',
    '//me@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)',
    '/dev/disk6 on /Volumes/AUDIO_CD (cd9660, local, nodev, nosuid, read-only)',
    '/dev/disk7s1 on /Volumes/A Very Long Volume Name (exfat, local, nodev, nosuid)',
  ].join('\n')
  const vols = m.parseMacMounts(mounts)
  console.log('mac=' + vols.map(v => v.mount).join(','))
  const drives = [{ mount: '/', name: 'Macintosh HD' }, ...vols]
  console.log('mpick=' + [m.pickDrive('/Volumes/T7 Shield/proj', drives, false), m.pickDrive('/Users/me/x', drives, false), m.pickDrive('/Volumes/A Very Long Volume Name', drives, false)].map(one).join(' / '))
  let calls = 0
  const list = n => async () => { calls++; return n === 1 ? ['C:'] : ['C:', 'D:'] }
  const a = m.sessionDrive({ session_id: 's1', cwd: 'D:\\\\x' }, { list: list(2), windows: true }); await a.ready
  m.sessionDrive({ session_id: 's1', cwd: 'D:\\\\x' }, { list: list(2), windows: true })
  const b = m.sessionDrive({ session_id: 's2', cwd: 'C:\\\\x' }, { list: list(1), windows: true }); await b.ready
  console.log('session=' + one(a.drive) + ' single=' + one(b.drive) + ' lists=' + calls)
  const r = () => ({ cpu: 10, ram: 50, commit: 40, disk: 100 })
  const lab = await m.pressureParts({ MACHINE_PRESSURE_T: 'a' }, { windows: true, readings: r, drive: { mount: 'D:\\\\', label: 'D:' } })
  const plain = await m.pressureParts({ MACHINE_PRESSURE_T: 'b' }, { windows: true, readings: r })
  console.log('seg=' + lab[3] + ' / ' + plain[3])
  process.exit(0)")
has "windows drives parsed" "win=C:,D:,E:" "$out"
has "windows folder drive, UNC unlabeled" "wpick=D:@D:\\ unc=none" "$out"
has "mac local volumes only" "mac=/Volumes/T7 Shield,/Volumes/A Very Long Volume Name" "$out"
has "mac folder volume, boot, 12 chars" "mpick=T7 Shield@/Volumes/T7 Shield / Macintosh HD@/ / A Very Long@/Volumes/A Very Long Volume Name" "$out"
has "read once per session, none for one drive" "session=D:@D:\\ single=none lists=2" "$out"
has "label in the disk segment" "seg=disk D: 100G / disk 100G" "$out"

echo "== Windows CPU: one sample shared by readings taken close together (one per drive)"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { windowsReadings } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  windowsReadings()
  await new Promise(r => setTimeout(r, 1200))
  const a = windowsReadings().cpu, b = windowsReadings('/').cpu
  console.log(a !== null && a === b ? 'shared' : 'apart ' + a + ' ' + b)
  process.exit(0)")
has "second drive gets the same CPU" "shared" "$out"

echo "== pressure icon: the level as one colored symbol"
printf '{"lines":[[{"type":"pressure","icon":"◆"}]]}' > "$WORK/icon.json"
out=$(env -u NO_COLOR SHARED_STATUSLINE_CONFIG="$WORK/icon.json" MACHINE_PRESSURE_RAM_AMBER=0 MACHINE_PRESSURE_RAM_RED=1 node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { render, requestEnv } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  console.log(JSON.stringify(await render({}, '', requestEnv('MACHINE_PRESSURE_RAM_AMBER=0&MACHINE_PRESSURE_RAM_RED=1'))))
  process.exit(0)")
has "icon in the RED color" '\u001b[31m◆\u001b[0m' "$out"
case $out in *"pressure RED"*) bad "the word is gone" "$out" ;; *) ok "the word is gone" ;; esac

echo "== agent-chat module: Windows installer's release root"
# The Windows installer keeps releases in %LOCALAPPDATA%\agent-chat\release-root, while
# AGENT_CHAT_ROOT points at the chats folder on another drive.
REL=$WORK/lad/agent-chat/release-root
mkdir -p "$REL/releases/r1" "$WORK/chats"
printf '{"current":{"id":"r1"}}' > "$REL/current.json"
: > "$REL/releases/r1/statusline-name.mjs"
out=$(node --input-type=module -e "
  const { pathToFileURL } = await import('node:url')
  const { findAgentChatModule } = await import(pathToFileURL('$WORK/bin/server.mjs').href)
  const env = { AGENT_CHAT_ROOT: '$WORK/chats', LOCALAPPDATA: '$WORK/lad', CLAUDE_CONFIG_DIR: '$WORK/nocfg' }
  console.log('win=' + String(findAgentChatModule({}, env, { windows: true })).replace(/\\\\/g, '/') + ' mac=' + (String(findAgentChatModule({}, env, { windows: false })).includes('/lad/') ? 'lad' : 'not-lad'))")
has "found under LOCALAPPDATA on Windows" "win=$REL/releases/r1/statusline-name.mjs" "$out"
has "not looked up there elsewhere" "mac=not-lad" "$out"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
