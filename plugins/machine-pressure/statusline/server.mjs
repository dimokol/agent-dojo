#!/usr/bin/env node
// Shared status line: one process renders the status line for every Claude Code tab on the machine.
//
// Each tab's statusLine runs client.sh, which POSTs the tab's status JSON here with curl and prints
// the reply. Per-tab parts (model, tokens, branch) come from that JSON; machine-wide parts (the
// pressure row) are computed once for every tab. See README.md for the numbers.
//
// Transport: a unix socket at <dir>/sock on macOS and Linux. On Windows node can't listen on a unix
// socket file, so the server listens on a random loopback port and writes "<port> <token>" to
// <dir>/endpoint; client.sh sends the token in X-Token.
// Lifecycle: client.sh starts the server when nothing answers. It exits after 30 minutes without a
// request, or within a minute of this file changing (an update), and the next render starts it again.
//
// Config: $SHARED_STATUSLINE_CONFIG, else ~/.config/shared-statusline/config.json. Reread on change.
// Without one, a short default layout is used. examples/ has full ones.
//
// Per tab: the server serves tabs of several Claude config dirs (~/.claude-dimo, ~/.claude-2), so
// what differs per tab comes with each request, not from the server's own env: X-Config-Dir, and
// X-Env with the tab's AGENT_CHAT_ROOT, AGENT_CHAT_STATE_ROOT and pressure thresholds
// (CLAUDE_PLUGIN_OPTION_* / MACHINE_PRESSURE_*). NO_COLOR, the config file and the load log are
// machine-wide: they come from the env of whichever tab started the server.
import fs from 'node:fs'
import net from 'node:net'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

const HOME = os.homedir()
const WIN = process.platform === 'win32'
const DIR = process.env.SHARED_STATUSLINE_DIR || path.join(HOME, '.cache', 'shared-statusline')
const SOCK = path.join(DIR, 'sock')
const ENDPOINT = path.join(DIR, 'endpoint')
const SELF = fileURLToPath(import.meta.url)
const HERE = path.dirname(SELF)
const CONFIG = process.env.SHARED_STATUSLINE_CONFIG || path.join(HOME, '.config', 'shared-statusline', 'config.json')
const IDLE_MS = Number(process.env.SHARED_STATUSLINE_IDLE_MS) || 30 * 60 * 1000
const SELF_MTIME = fs.statSync(SELF).mtimeMs

// ---------- config ----------
const DEFAULT_CONFIG = {
  separator: ' | ',
  lines: [['model', 'context', 'five-hour', 'five-hour-reset', 'branch'], ['pressure']],
}
// 256-colour codes, overridable per segment with "color" (a number or one of NAMES).
const DEFAULT_COLORS = {
  model: 'cyan', 'agent-chat': 'white', effort: 'magenta', context: 'gray', 'session-tokens': 'yellow',
  'five-hour': 'blue', 'five-hour-reset': 'blue', week: 'blue', 'week-reset': 'blue', branch: 'magenta',
  dir: 'white', cost: 'green', separator: 'gray',
}
const NAMES = { black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7, gray: 8, grey: 8 }
let config = { at: -1, value: DEFAULT_CONFIG }
function loadConfig() {
  let mtime = 0
  try { mtime = fs.statSync(CONFIG).mtimeMs } catch {}
  if (mtime === config.at) return config.value
  let value = DEFAULT_CONFIG
  if (mtime) {
    try {
      const raw = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
      if (Array.isArray(raw.lines)) value = { ...DEFAULT_CONFIG, ...raw }
      else value = { ...DEFAULT_CONFIG, error: 'config has no "lines" array' }
    } catch (e) { value = { ...DEFAULT_CONFIG, error: `config: ${e.message}` } }
  }
  config = { at: mtime, value }
  return value
}
const colorCode = c => typeof c === 'number' ? c : NAMES[String(c).toLowerCase()] ?? null
const paint = (color, text) => {
  const code = colorCode(color)
  return code === null || process.env.NO_COLOR ? text : `\x1b[38;5;${code}m${text}\x1b[39m`
}

// ---------- per-tab env ----------
const FORWARDED = /^(AGENT_CHAT_ROOT|AGENT_CHAT_STATE_ROOT|(CLAUDE_PLUGIN_OPTION|MACHINE_PRESSURE)_[A-Z0-9_]+)$/
const BASE_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !FORWARDED.test(k)))
// X-Env is "K=V&K=V" (URL-encoded); only FORWARDED names are taken.
export function requestEnv(header, configDir = '') {
  const env = { ...BASE_ENV }
  for (const [k, v] of new URLSearchParams(String(header || ''))) if (FORWARDED.test(k)) env[k] = v
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR
  return env
}

// ---------- formatting ----------
export function formatTokens(n) {
  if (n >= 1e6 - 50) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
export function formatDuration(ms) {
  ms = Math.max(0, ms)
  const totalH = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4)
  const d = Math.floor(totalH / 24), h = totalH % 24
  const parts = [d > 0 && `${d}d`, h > 0 && `${h}hr`, m > 0 && `${m}m`].filter(Boolean)
  return parts.length ? parts.join(' ') : '0m'
}

// ---------- session token total: each transcript is read incrementally, never twice ----------
// Reads happen in the background, 4 MB at a time, and a render shows the total read so far: a long
// transcript seen for the first time must not hold a render past the client's 2 s limit.
const transcripts = new Map() // path -> { offset, rest, byId, anon, seen, reading, total }
const CHUNK = 4 * 2 ** 20
function transcriptTotal(file) {
  if (!file) return null
  let t = transcripts.get(file)
  if (!t) { t = { offset: 0, rest: '', byId: new Map(), anon: 0, total: null, reading: false }; transcripts.set(file, t) }
  t.seen = Date.now()
  if (!t.reading) { t.reading = true; readTranscript(file, t).finally(() => { t.reading = false }) }
  return t.total
}
async function readTranscript(file, t) {
  let fh
  try {
    fh = await fs.promises.open(file, 'r')
    let size = (await fh.stat()).size
    if (size < t.offset) Object.assign(t, { offset: 0, rest: '', byId: new Map(), anon: 0 }) // rewritten
    while (size > t.offset) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - t.offset))
      const { bytesRead } = await fh.read(buf, 0, buf.length, t.offset)
      if (!bytesRead) break
      t.offset += bytesRead
      addLines(t, buf.subarray(0, bytesRead).toString('utf8'))
    }
  } catch { return } finally { await fh?.close() }
  let total = t.anon
  for (const v of t.byId.values()) total += v.inp + v.out
  t.total = total
}
function addLines(t, text) {
  const lines = (t.rest + text).split('\n')
  t.rest = lines.pop()
  for (const line of lines) {
    if (!line.includes('"usage"')) continue
    let msg
    try { msg = JSON.parse(line)?.message } catch { continue }
    const u = msg?.usage
    if (!u) continue
    const v = { inp: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0 }
    // Streaming writes one message several times; count each id once, with its largest output.
    if (typeof msg.id === 'string' && msg.id) {
      const prev = t.byId.get(msg.id)
      t.byId.set(msg.id, prev ? { inp: prev.inp, out: Math.max(prev.out, v.out) } : v)
    } else t.anon += v.inp + v.out
  }
}
// Forget transcripts no tab has asked about for an hour, so a long-lived server stays small.
setInterval(() => {
  for (const [k, t] of transcripts) if (Date.now() - t.seen > 3.6e6) transcripts.delete(k)
}, 6e5).unref()

// ---------- git branch from .git/HEAD, no git process ----------
const gitCache = new Map() // cwd -> { at, value }
function gitBranch(cwd) {
  if (!cwd) return null
  const hit = gitCache.get(cwd)
  if (hit && Date.now() - hit.at < 5000) return hit.value
  let value = null
  for (let dir = cwd; ; dir = path.dirname(dir)) {
    const dotgit = path.join(dir, '.git')
    try {
      let gitdir = dotgit
      if (fs.statSync(dotgit).isFile()) {
        const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotgit, 'utf8'))
        if (m) gitdir = path.resolve(dir, m[1].trim())
      }
      const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim()
      value = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 7)
      break
    } catch {}
    if (dir === path.dirname(dir)) break
  }
  if (gitCache.size > 500) gitCache.clear()
  gitCache.set(cwd, { at: Date.now(), value })
  return value
}

// ---------- agent-chat name, through agent-chat's own statuslineName ----------
// Found once a minute: "agentChatModule" in the config, else the release agent-chat's installer
// made under $AGENT_CHAT_ROOT (on Windows also under %LOCALAPPDATA%), else the newest copy in the Claude plugin cache.
// Looked up per tab (its config dir and AGENT_CHAT_ROOT), so two profiles can use different copies.
const agentChats = new Map() // "<configDir>\0<AGENT_CHAT_ROOT>" -> { file, fn, defaultStateRoot, checked }
export function findAgentChatModule(cfg, env = process.env, { windows = WIN } = {}) {
  if (cfg.agentChatModule) return cfg.agentChatModule.replace(/^~(?=$|[\\/])/, HOME)
  const roots = [env.AGENT_CHAT_ROOT || path.join(HOME, '.local', 'state', 'agent-chat')]
  // The Windows installer keeps releases on the system drive, apart from the chats (its installPaths).
  if (windows) roots.push(path.join(env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'agent-chat'))
  for (const root of roots) {
    try {
      const cur = JSON.parse(fs.readFileSync(path.join(root, 'release-root', 'current.json'), 'utf8')).current.id
      const f = path.join(root, 'release-root', 'releases', cur, 'statusline-name.mjs')
      if (fs.existsSync(f)) return f
    } catch {}
  }
  for (const base of [env.CLAUDE_CONFIG_DIR, path.join(HOME, '.claude')].filter(Boolean)) {
    const cache = path.join(base, 'plugins', 'cache', 'dimokol', 'agent-chat')
    try {
      const newest = fs.readdirSync(cache).map(v => path.join(cache, v, 'server', 'statusline-name.mjs'))
        .filter(f => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      if (newest) return newest
    } catch {}
  }
  return null
}
async function agentChatName(cfg, input, env) {
  try {
    const key = `${env.CLAUDE_CONFIG_DIR || ''}\0${env.AGENT_CHAT_ROOT || ''}`
    let agentChat = agentChats.get(key) || { file: null, fn: null, defaultStateRoot: null, checked: 0 }
    if (Date.now() - agentChat.checked > 60000) {
      agentChat.checked = Date.now()
      const file = findAgentChatModule(cfg, env)
      if (file !== agentChat.file) {
        agentChat = { file, fn: null, defaultStateRoot: null, checked: Date.now() }
        if (file) {
          const mod = await import(pathToFileURL(file).href)
          agentChat.fn = mod.statuslineName
          try { agentChat.defaultStateRoot = (await import(pathToFileURL(path.join(path.dirname(file), 'notice-files.mjs')).href)).defaultStateRoot } catch {}
        }
      }
    }
    if (agentChats.size > 20) agentChats.clear()
    agentChats.set(key, agentChat)
    if (!agentChat.fn) return ''
    const stateRoot = env.AGENT_CHAT_STATE_ROOT || env.AGENT_CHAT_ROOT
      || (agentChat.defaultStateRoot ? agentChat.defaultStateRoot(env) : path.join(HOME, '.local', 'state', 'agent-chat'))
    return agentChat.fn(input, { stateRoot, env }) || ''
  } catch { return '' }
}

// ---------- machine pressure ----------
// macOS and Linux: machine-pressure's pressure.sh stays the one source of thresholds; it runs once
// per 4 s for every tab. Windows: pressure.sh can't read anything there, so the values are taken
// in-process (no load average on Windows; commit charge through powershell every 30 s) with the same
// thresholds and colors.
function findPressureScript() {
  const candidates = [process.env.SHARED_STATUSLINE_PRESSURE, path.join(HERE, 'pressure.sh'), path.join(HERE, '..', 'scripts', 'pressure.sh')]
  return candidates.find(f => f && fs.existsSync(f)) || null
}
const PRESSURE = WIN ? null : findPressureScript()
// One reading per set of thresholds: tabs with the same settings (the usual case) share it.
const pressures = new Map() // thresholds key -> { at, parts, pending }
const thresholdKey = env => Object.keys(env).filter(k => /^(CLAUDE_PLUGIN_OPTION|MACHINE_PRESSURE)_/.test(k)).sort().map(k => `${k}=${env[k]}`).join('&')
// A stale reading is served at once while a fresh one is taken, so no render waits for the probe
// (except the very first).
// windows and readings are for tests: they take the Windows path with given readings on any OS.
export function pressureParts(env, { windows = WIN, readings } = {}) {
  const key = thresholdKey(env)
  let p = pressures.get(key)
  if (!p) { if (pressures.size > 20) pressures.clear(); p = { at: 0, parts: [], pending: null }; pressures.set(key, p) }
  if (Date.now() - p.at < 4000) return Promise.resolve(p.parts)
  const fresh = p.pending || refreshPressure(p, env, windows, readings)
  return p.at ? Promise.resolve(p.parts) : fresh
}
function refreshPressure(p, env, windows, readings) {
  // A reading taken in-process is ready at once: store it without a pending promise. Set inside a
  // promise executor, done() would run before p.pending is assigned, so p.pending would never clear
  // and the segment would freeze at its first reading.
  if (windows || !PRESSURE) {
    Object.assign(p, { at: Date.now(), parts: windows ? windowsPressure(env, readings?.()) : [], pending: null })
    return Promise.resolve(p.parts)
  }
  p.pending = new Promise(resolve => {
    const done = parts => { Object.assign(p, { at: Date.now(), parts, pending: null }); resolve(parts) }
    execFile('/bin/sh', [PRESSURE, '--segments'], { timeout: 3000, env }, (err, stdout) => {
      done(err ? [] : stdout.split('\x1e').map(s => s.trim()).filter(Boolean))
    })
  })
  return p.pending
}

function threshold(key, dflt, env = process.env) {
  const v = env[`CLAUDE_PLUGIN_OPTION_${key}`] || env[`MACHINE_PRESSURE_${key}`]
  return v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : dflt
}
let cpuPrev = null
function cpuPercent() {
  const now = os.cpus().reduce((a, c) => {
    const t = c.times
    a.idle += t.idle; a.total += t.user + t.nice + t.sys + t.idle + t.irq
    return a
  }, { idle: 0, total: 0 })
  const prev = cpuPrev
  cpuPrev = now
  if (!prev || now.total <= prev.total) return null
  return Math.max(0, Math.min(100, Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 100)))
}
// Commit charge (committed memory against the commit limit), the gate's "commit" signal. Node can't
// read it, so one powershell call refreshes it in the background at most every 30 s.
const commitCharge = { pct: null, at: 0, pending: false }
function refreshCommit() {
  if (commitCharge.pending || Date.now() - commitCharge.at < 30000) return
  commitCharge.pending = true
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$o = Get-CimInstance Win32_OperatingSystem; "$($o.TotalVirtualMemorySize) $($o.FreeVirtualMemory)"'],
  { timeout: 10000, windowsHide: true }, (err, out) => {
    const [total, free] = String(out || '').trim().split(/\s+/).map(Number)
    if (!err && total > 0) commitCharge.pct = Math.round((1 - free / total) * 100)
    Object.assign(commitCharge, { at: Date.now(), pending: false })
  })
}
if (WIN) { cpuPercent(); refreshCommit() } // first readings, so the first render already has them
export function windowsReadings() {
  const cpu = cpuPercent()
  const ram = Math.round((1 - os.freemem() / os.totalmem()) * 100)
  let disk = null
  try { const s = fs.statfsSync(HOME); disk = (s.bavail * s.bsize) / 2 ** 30 } catch {}
  refreshCommit()
  return { cpu, ram, commit: commitCharge.pct, disk }
}
const LEVEL_COLOR = { 2: '\x1b[31m', 1: '\x1b[33m', 0: '\x1b[32m', '-1': '\x1b[2m' }
const seg = (level, text) => process.env.NO_COLOR ? text : `${LEVEL_COLOR[level]}${text}\x1b[0m`
const lvl = (v, a, r) => v === null ? -1 : v >= r ? 2 : v >= a ? 1 : 0
const lvlLow = (v, a, r) => v === null ? -1 : v <= r ? 2 : v <= a ? 1 : 0
export function windowsPressure(env = process.env, { cpu, ram, commit = null, disk } = windowsReadings()) {
  const sCpu = lvl(cpu, threshold('CPU_AMBER', 85, env), threshold('CPU_RED', 97, env))
  const sRam = lvl(ram, threshold('RAM_AMBER', 85, env), threshold('RAM_RED', 93, env))
  const sCommit = lvl(commit, threshold('SWAP_AMBER', 70, env), threshold('SWAP_RED', 90, env))
  const sDisk = lvlLow(disk, threshold('DISK_AMBER_GB', 20, env), threshold('DISK_RED_GB', 10, env))
  // RED means memory is short, as on the Mac (and pressure.sh): a CPU spike or low disk stops at AMBER.
  const worst = Math.max(Math.min(sCpu, 1), sRam, sCommit, Math.min(sDisk, 1))
  const level = { 2: 'RED', 1: 'AMBER', 0: 'OK', '-1': 'UNKNOWN' }[worst]
  return [
    seg(sCpu, cpu === null ? 'CPU …' : `CPU ${cpu}%`),
    seg(sRam, `RAM ${ram}%`),
    seg(sCommit, commit === null ? 'commit …' : `commit ${commit}%`),
    seg(sDisk, disk === null ? 'disk n/a' : `disk ${disk < 10 ? disk.toFixed(1) : Math.round(disk)}G`),
    seg(worst, `pressure ${level}`),
  ]
}

// ---------- optional load log: one sample per 10 s while tabs are open ----------
function logDir() {
  if (WIN) return path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'shared-statusline')
  if (process.platform === 'darwin') return path.join(HOME, 'Library', 'Logs')
  return path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state'), 'shared-statusline')
}
function loadLogPath(cfg) {
  const v = process.env.SHARED_STATUSLINE_LOAD_LOG || cfg.loadLog
  if (!v || v === '0' || v === 'false') return null
  if (v === true || v === '1' || v === 'true') return path.join(logDir(), 'machine-load.log')
  return String(v).replace(/^~(?=$|[\\/])/, HOME)
}
// Every process is read, so groups= can sum them; top= is the 5 busiest.
const SAMPLE_CMD = {
  darwin: 'sysctl -n vm.loadavg; sysctl -n vm.swapusage | sed -n "s/.*used = \\([^ ]*\\).*/\\1/p"; memory_pressure | tail -1 | sed "s/.*: //"; ps -axo %cpu=,rss=,command=',
  linux: 'cut -d" " -f1-3 /proc/loadavg; awk \'/SwapTotal/{t=$2}/SwapFree/{f=$2}END{printf "%dM\\n",(t-f)/1024}\' /proc/meminfo; awk \'/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%d%%\\n",a*100/t}\' /proc/meminfo; ps -eo pcpu=,rss=,args=',
}
// groups=: `name=count/cpu%/rssM` summed over every process in the group, so "how many vitest
// workers, tabs or builds at once" is in the log. First match wins, tested on the full command line.
// The .app and Spotlight entries only ever match on macOS.
export const GROUPS = [
  ['claude', /\/claude\/versions\/|^(\S*\/)?claude(\s|$)/],
  ['codex', /^(\S*\/)?codex(\s|$)|\/codex\/codex(\s|$)/],
  ['vitest', /node_modules\/(\.bin\/)?vitest/],
  ['eslint', /node_modules\/(\.bin\/)?eslint/],
  ['tsc', /node_modules\/(\.bin\/)?(typescript|tsc|tsrs|@typescript\/native)/],
  ['next', /next-server|next-build|node_modules\/(\.bin\/)?next(\/|\s)/],
  ['expo', /node_modules\/(\.bin\/)?(expo|@expo|metro)/],
  ['gradle', /org\.gradle\./],
  ['clang', /\/(clang(\+\+)?|ld\.lld|ninja|cc1plus)(\s|$)/],
  ['vscode', /\/Visual Studio Code\.app\/|\/(code|code-insiders)(\s|$)/],
  ['brave', /\/Brave Browser\.app\//],
  ['brave-claude', /\/Brave Claude\.app\//],
  ['mongod', /\/mongod[^/\s]*(\s|$)/],
  ['spotlight', /\/(mds|mds_stores|mdworker|mdworker_shared)(\s|$)/],
]
// A readable name: the outermost .app for GUI apps, `claude` for a versioned claude binary, and for
// node/python/sh the script or node_modules package it runs.
export function procName(cmdline) {
  const app = /\/([^/]+)\.app\//.exec(cmdline)
  if (app) return app[1].replace(/\s+/g, '_')
  const [cmd, ...args] = cmdline.split(/\s+/)
  if (cmd.includes('/claude/versions/')) return 'claude'
  let name = path.basename(cmd || '?')
  if (/^(node|python3?|sh|bash|zsh)$/.test(name)) {
    const a = args.find(x => !x.startsWith('-'))
    if (a) {
      const pkg = /.*node_modules\/((@[^/]+\/)?[^/]+)\/?/.exec(a)
      name += ':' + (pkg && pkg[1] !== '.bin' ? pkg[1] : path.basename(a))
    }
  }
  return name
}
export function summarize(rows) { // ps lines "cpu rss command" -> { top, groups }
  const procs = rows.map(l => {
    const m = /^\s*([\d.]+)\s+(\d+)\s+(.*)$/.exec(l)
    return m && { cpu: +m[1], rss: +m[2], cmd: m[3] }
  }).filter(Boolean)
  const top = [...procs].sort((a, b) => b.cpu - a.cpu).slice(0, 5)
    .map(p => `${procName(p.cmd)}=${p.cpu}%/${Math.round(p.rss / 1024)}M`).join(' ')
  const sums = new Map()
  for (const p of procs) {
    const g = GROUPS.find(([, re]) => re.test(p.cmd))
    if (!g) continue
    const v = sums.get(g[0]) || { n: 0, cpu: 0, rss: 0 }
    v.n++; v.cpu += p.cpu; v.rss += p.rss
    sums.set(g[0], v)
  }
  const groups = GROUPS.filter(([k]) => sums.has(k))
    .map(([k]) => { const v = sums.get(k); return `${k}=${v.n}/${Math.round(v.cpu)}%/${Math.round(v.rss / 1024)}M` }).join(' ')
  return { top, groups }
}
let lastSample = 0
function sample(cfg) {
  const file = loadLogPath(cfg)
  if (!file || Date.now() - lastSample < 10000) return
  lastSample = Date.now()
  const write = line => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      // Keep it bounded: one 5 MB file plus one older copy.
      try { if (fs.statSync(file).size > 5 * 2 ** 20) fs.renameSync(file, file + '.1') } catch {}
      fs.appendFileSync(file, `${new Date().toLocaleString('sv-SE')} ${line}\n`)
    } catch {}
  }
  if (WIN) {
    const { cpu, ram } = windowsReadings()
    return write(`cpu=${cpu ?? 'n/a'}% ram=${ram}%`)
  }
  const cmd = SAMPLE_CMD[process.platform]
  if (!cmd) return
  execFile('/bin/sh', ['-c', cmd], { timeout: 3000, maxBuffer: 16 << 20 }, (err, out) => {
    if (err) return
    const [load, swap, mem, ...rows] = out.trim().split('\n')
    const { top, groups } = summarize(rows)
    write(`load=${load.replace(/[{}]/g, '').trim()} swap=${swap} free=${mem} top=${top} groups=${groups}`)
  })
}

// ---------- render ----------
async function segment(type, input, ctx) {
  const rl = input.rate_limits || {}
  const five = rl.five_hour, week = rl.seven_day
  const now = Date.now()
  switch (type) {
    case 'model': return input.model?.display_name || null
    case 'agent-chat': return (await agentChatName(ctx.cfg, input, ctx.env)) || null
    case 'effort': return input.effort?.level || null
    case 'context': {
      const cw = input.context_window?.current_usage
      return cw ? formatTokens((cw.input_tokens || 0) + (cw.cache_creation_input_tokens || 0) + (cw.cache_read_input_tokens || 0)) : null
    }
    case 'session-tokens': { const t = transcriptTotal(input.transcript_path); return t === null ? null : formatTokens(t) }
    case 'five-hour': return typeof five?.used_percentage === 'number' && five.resets_at * 1000 > now ? `${five.used_percentage.toFixed(1)}%` : null
    case 'five-hour-reset': return typeof five?.used_percentage === 'number' && five.resets_at * 1000 > now ? formatDuration(five.resets_at * 1000 - now) : null
    case 'week': return typeof week?.used_percentage === 'number' ? `${week.used_percentage.toFixed(1)}%` : null
    case 'week-reset': return week?.resets_at ? formatDuration(week.resets_at * 1000 - now) : null
    case 'branch': { const b = gitBranch(input.workspace?.current_dir || input.cwd); return b ? `⎇ ${b}` : null }
    case 'dir': { const d = input.workspace?.current_dir || input.cwd; return d ? path.basename(d) : null }
    case 'cost': { const c = input.cost?.total_cost_usd; return typeof c === 'number' ? `$${c.toFixed(2)}` : null }
    default: return null
  }
}
export async function render(input, configDir = '', env = requestEnv('', configDir)) {
  const cfg = loadConfig()
  sample(cfg)
  const sep = paint(cfg.colors?.separator ?? DEFAULT_COLORS.separator, cfg.separator ?? ' | ')
  const ctx = { cfg, env }
  const out = []
  for (const line of cfg.lines) {
    if (!Array.isArray(line)) continue
    const parts = []
    for (const item of line) {
      const spec = typeof item === 'string' ? { type: item } : item || {}
      if (spec.type === 'pressure') {
        const pp = await pressureParts(env)
        // "icon": the level as one symbol in the level's color, in place of "pressure RED" (kept under NO_COLOR).
        parts.push(...(spec.icon && !process.env.NO_COLOR ? pp.map(s => s.replace(/pressure (RED|AMBER|OK|UNKNOWN)/, spec.icon)) : pp))
        continue
      }
      if (spec.type === 'text') { if (spec.text) parts.push(paint(spec.color ?? null, spec.text)); continue }
      const text = (await segment(spec.type, input, ctx)) || spec.fallback
      if (text) parts.push(paint(spec.color ?? cfg.colors?.[spec.type] ?? DEFAULT_COLORS[spec.type] ?? null, text))
    }
    if (parts.length) out.push((process.env.NO_COLOR ? '' : '\x1b[0m') + parts.join(sep))
  }
  if (cfg.error) out.push(paint('yellow', `shared-statusline ${cfg.error}`))
  return out.join('\n')
}

// ---------- server ----------
function main() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 })
  const token = WIN ? crypto.randomBytes(16).toString('hex') : null
  let idleTimer
  const bumpIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(shutdown, IDLE_MS) }
  let listening = false
  const PIDFILE = path.join(DIR, 'server.pid')
  const writePid = () => { try { fs.writeFileSync(PIDFILE, `${process.pid}\n`) } catch {} }
  function shutdown(code = 0) {
    if (listening) {
      if (WIN) { try { if (fs.readFileSync(ENDPOINT, 'utf8').includes(token)) fs.unlinkSync(ENDPOINT) } catch {} }
      else { try { fs.unlinkSync(SOCK) } catch {} }
    }
    // Only our own pid: after a restart the file may already name the next server.
    try { if (fs.readFileSync(PIDFILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PIDFILE) } catch {}
    process.exit(code)
  }
  // Fails loudly into server.log; client.sh points at it after two failed starts.
  const fatal = (what, e) => { console.error(`${new Date().toISOString()} shared-statusline: ${what}: ${e?.stack || e}`); shutdown(1) }

  const server = http.createServer((req, res) => {
    if (WIN && req.headers['x-token'] !== token) { res.writeHead(403); res.end(); return }
    bumpIdle()
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d; if (body.length > 1 << 20) req.destroy() })
    req.on('end', async () => {
      let out = ''
      try {
        const configDir = String(req.headers['x-config-dir'] || '')
        out = await render(JSON.parse(body), configDir, requestEnv(req.headers['x-env'], configDir))
      } catch (e) { out = `statusline: ${e.message}` }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(out)
    })
    req.on('error', () => {})
  })
  server.setTimeout(3000)
  server.on('error', e => fatal('listen failed', e))

  const listen = () => {
    if (WIN) {
      server.listen(0, '127.0.0.1', () => {
        try {
          const tmp = `${ENDPOINT}.${process.pid}`
          fs.writeFileSync(tmp, `${server.address().port} ${token}\n`, { mode: 0o600 })
          fs.renameSync(tmp, ENDPOINT)
          listening = true; bumpIdle(); writePid()
        } catch (e) { fatal('writing the endpoint file', e) }
      })
    } else {
      try { fs.unlinkSync(SOCK) } catch {}
      server.listen(SOCK, () => {
        try { fs.chmodSync(SOCK, 0o600); listening = true; bumpIdle(); writePid() } catch (e) { fatal('setting up the socket', e) }
      })
    }
  }
  // Another server already answering means this one lost a start race: leave quietly.
  if (WIN) {
    let ep = null
    try { const [port, tok] = fs.readFileSync(ENDPOINT, 'utf8').trim().split(' '); ep = { port: Number(port), tok } } catch {}
    if (!ep) listen()
    else {
      const r = http.request({ host: '127.0.0.1', port: ep.port, method: 'POST', headers: { 'x-token': ep.tok }, timeout: 1000 }, res => {
        res.resume(); if (res.statusCode === 200) process.exit(0); else listen()
      })
      r.on('error', listen); r.on('timeout', () => { r.destroy() })
      r.end('{}')
    }
  } else {
    const probe = net.connect(SOCK)
    probe.on('connect', () => { probe.destroy(); process.exit(0) })
    probe.on('error', listen)
  }
  setInterval(() => { try { if (fs.statSync(SELF).mtimeMs !== SELF_MTIME) shutdown() } catch { shutdown() } }, 60000).unref()
  process.on('SIGTERM', () => shutdown())
  process.on('SIGINT', () => shutdown())
  process.on('uncaughtException', e => fatal('crashed', e))
}

const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF) } catch { return false } }
if (process.argv[1] && isMain()) main()
