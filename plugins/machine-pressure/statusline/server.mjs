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
const transcripts = new Map() // path -> { offset, rest, byId, anon, seen }
function transcriptTotal(file) {
  if (!file) return null
  let st
  try { st = fs.statSync(file) } catch { return null }
  let t = transcripts.get(file)
  if (!t || st.size < t.offset) { t = { offset: 0, rest: '', byId: new Map(), anon: 0 }; transcripts.set(file, t) }
  t.seen = Date.now()
  if (st.size > t.offset) {
    const fd = fs.openSync(file, 'r')
    const buf = Buffer.alloc(st.size - t.offset)
    fs.readSync(fd, buf, 0, buf.length, t.offset)
    fs.closeSync(fd)
    t.offset = st.size
    const lines = (t.rest + buf.toString('utf8')).split('\n')
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
  let total = t.anon
  for (const v of t.byId.values()) total += v.inp + v.out
  return total
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
// made under $AGENT_CHAT_ROOT, else the newest copy in the Claude plugin cache.
let agentChat = { file: null, fn: null, defaultStateRoot: null, checked: 0 }
function findAgentChatModule(cfg) {
  if (cfg.agentChatModule) return cfg.agentChatModule.replace(/^~(?=$|[\\/])/, HOME)
  const root = process.env.AGENT_CHAT_ROOT || path.join(HOME, '.local', 'state', 'agent-chat')
  try {
    const cur = JSON.parse(fs.readFileSync(path.join(root, 'release-root', 'current.json'), 'utf8')).current.id
    const f = path.join(root, 'release-root', 'releases', cur, 'statusline-name.mjs')
    if (fs.existsSync(f)) return f
  } catch {}
  for (const base of [path.join(HOME, '.claude'), process.env.CLAUDE_CONFIG_DIR].filter(Boolean)) {
    const cache = path.join(base, 'plugins', 'cache', 'dimokol', 'agent-chat')
    try {
      const newest = fs.readdirSync(cache).map(v => path.join(cache, v, 'server', 'statusline-name.mjs'))
        .filter(f => fs.existsSync(f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
      if (newest) return newest
    } catch {}
  }
  return null
}
async function agentChatName(cfg, input, configDir) {
  try {
    if (Date.now() - agentChat.checked > 60000) {
      agentChat.checked = Date.now()
      const file = findAgentChatModule(cfg)
      if (file !== agentChat.file) {
        agentChat = { file, fn: null, defaultStateRoot: null, checked: Date.now() }
        if (file) {
          const mod = await import(pathToFileURL(file).href)
          agentChat.fn = mod.statuslineName
          try { agentChat.defaultStateRoot = (await import(pathToFileURL(path.join(path.dirname(file), 'notice-files.mjs')).href)).defaultStateRoot } catch {}
        }
      }
    }
    if (!agentChat.fn) return ''
    const env = { ...process.env }
    if (configDir) env.CLAUDE_CONFIG_DIR = configDir
    else delete env.CLAUDE_CONFIG_DIR
    const stateRoot = process.env.AGENT_CHAT_STATE_ROOT || process.env.AGENT_CHAT_ROOT
      || (agentChat.defaultStateRoot ? agentChat.defaultStateRoot(env) : path.join(HOME, '.local', 'state', 'agent-chat'))
    return agentChat.fn(input, { stateRoot, env }) || ''
  } catch { return '' }
}

// ---------- machine pressure ----------
// macOS and Linux: machine-pressure's pressure.sh stays the one source of thresholds; it runs once
// per 4 s for every tab. Windows: pressure.sh can't read anything there, so the values are taken
// in-process (no load average on Windows) with the same thresholds and colors.
function findPressureScript() {
  const candidates = [process.env.SHARED_STATUSLINE_PRESSURE, path.join(HERE, 'pressure.sh'), path.join(HERE, '..', 'scripts', 'pressure.sh')]
  return candidates.find(f => f && fs.existsSync(f)) || null
}
const PRESSURE = WIN ? null : findPressureScript()
let pressure = { at: 0, parts: [], pending: null }
// A stale reading is served at once while a fresh one is taken, so no render waits for the probe
// (except the very first).
function pressureParts() {
  if (Date.now() - pressure.at < 4000) return Promise.resolve(pressure.parts)
  const fresh = pressure.pending || refreshPressure()
  return pressure.at ? Promise.resolve(pressure.parts) : fresh
}
function refreshPressure() {
  pressure.pending = new Promise(resolve => {
    const done = parts => { pressure = { at: Date.now(), parts, pending: null }; resolve(parts) }
    if (WIN) return done(windowsPressure())
    if (!PRESSURE) return done([])
    execFile('/bin/sh', [PRESSURE, '--segments'], { timeout: 3000 }, (err, stdout) => {
      done(err ? [] : stdout.split('\x1e').map(s => s.trim()).filter(Boolean))
    })
  })
  return pressure.pending
}

function threshold(key, dflt) {
  const v = process.env[`CLAUDE_PLUGIN_OPTION_${key}`] || process.env[`MACHINE_PRESSURE_${key}`]
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
export function windowsReadings() {
  const cpu = cpuPercent()
  const ram = Math.round((1 - os.freemem() / os.totalmem()) * 100)
  let disk = null
  try { const s = fs.statfsSync(HOME); disk = (s.bavail * s.bsize) / 2 ** 30 } catch {}
  return { cpu, ram, disk }
}
const LEVEL_COLOR = { 2: '\x1b[31m', 1: '\x1b[33m', 0: '\x1b[32m', '-1': '\x1b[2m' }
const seg = (level, text) => process.env.NO_COLOR ? text : `${LEVEL_COLOR[level]}${text}\x1b[0m`
const lvl = (v, a, r) => v === null ? -1 : v >= r ? 2 : v >= a ? 1 : 0
const lvlLow = (v, a, r) => v === null ? -1 : v <= r ? 2 : v <= a ? 1 : 0
function windowsPressure() {
  const { cpu, ram, disk } = windowsReadings()
  const sCpu = lvl(cpu, threshold('CPU_AMBER', 85), threshold('CPU_RED', 97))
  const sRam = lvl(ram, threshold('RAM_AMBER', 85), threshold('RAM_RED', 93))
  const sDisk = lvlLow(disk, threshold('DISK_AMBER_GB', 20), threshold('DISK_RED_GB', 10))
  const worst = Math.max(sCpu, sRam, sDisk)
  const level = { 2: 'RED', 1: 'AMBER', 0: 'OK', '-1': 'UNKNOWN' }[worst]
  return [
    seg(sCpu, cpu === null ? 'CPU n/a' : `CPU ${cpu}%`),
    seg(sRam, `RAM ${ram}%`),
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
const SAMPLE_CMD = {
  darwin: 'sysctl -n vm.loadavg; sysctl -n vm.swapusage | sed -n "s/.*used = \\([^ ]*\\).*/\\1/p"; memory_pressure | tail -1 | sed "s/.*: //"; ps -axo %cpu=,rss=,command= -r | head -5',
  linux: 'cut -d" " -f1-3 /proc/loadavg; awk \'/SwapTotal/{t=$2}/SwapFree/{f=$2}END{printf "%dM\\n",(t-f)/1024}\' /proc/meminfo; awk \'/MemTotal/{t=$2}/MemAvailable/{a=$2}END{printf "%d%%\\n",a*100/t}\' /proc/meminfo; ps -eo pcpu=,rss=,args= --sort=-pcpu | head -5',
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
  execFile('/bin/sh', ['-c', cmd], { timeout: 3000 }, (err, out) => {
    if (err) return
    const [load, swap, mem, ...top] = out.trim().split('\n')
    // For node/python/sh, name the script it runs; otherwise the program.
    const procs = top.map(l => {
      const [cpu, rss, cmd, ...args] = l.trim().split(/\s+/)
      let name = path.basename(cmd || '?')
      if (/^(node|python3?|sh|bash|zsh)$/.test(name)) { const a = args.find(x => !x.startsWith('-')); if (a) name += ':' + path.basename(a) }
      return `${name}=${cpu}%/${Math.round(rss / 1024)}M`
    }).join(' ')
    write(`load=${load.replace(/[{}]/g, '').trim()} swap=${swap} free=${mem} top=${procs}`)
  })
}

// ---------- render ----------
async function segment(type, input, ctx) {
  const rl = input.rate_limits || {}
  const five = rl.five_hour, week = rl.seven_day
  const now = Date.now()
  switch (type) {
    case 'model': return input.model?.display_name || null
    case 'agent-chat': return (await agentChatName(ctx.cfg, input, ctx.configDir)) || null
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
export async function render(input, configDir = '') {
  const cfg = loadConfig()
  sample(cfg)
  const sep = paint(cfg.colors?.separator ?? DEFAULT_COLORS.separator, cfg.separator ?? ' | ')
  const ctx = { cfg, configDir }
  const out = []
  for (const line of cfg.lines) {
    if (!Array.isArray(line)) continue
    const parts = []
    for (const item of line) {
      const spec = typeof item === 'string' ? { type: item } : item || {}
      if (spec.type === 'pressure') { parts.push(...await pressureParts()); continue }
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
  const writePid = () => { try { fs.writeFileSync(path.join(DIR, 'server.pid'), `${process.pid}\n`) } catch {} }
  function shutdown() {
    if (listening) {
      if (WIN) { try { if (fs.readFileSync(ENDPOINT, 'utf8').includes(token)) fs.unlinkSync(ENDPOINT) } catch {} }
      else { try { fs.unlinkSync(SOCK) } catch {} }
    }
    process.exit(0)
  }

  const server = http.createServer((req, res) => {
    if (WIN && req.headers['x-token'] !== token) { res.writeHead(403); res.end(); return }
    bumpIdle()
    let body = ''
    req.setEncoding('utf8')
    req.on('data', d => { body += d; if (body.length > 1 << 20) req.destroy() })
    req.on('end', async () => {
      let out = ''
      try { out = await render(JSON.parse(body), String(req.headers['x-config-dir'] || '')) } catch (e) { out = `statusline: ${e.message}` }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(out)
    })
    req.on('error', () => {})
  })
  server.setTimeout(3000)

  const listen = () => {
    if (WIN) {
      server.listen(0, '127.0.0.1', () => {
        const tmp = `${ENDPOINT}.${process.pid}`
        fs.writeFileSync(tmp, `${server.address().port} ${token}\n`, { mode: 0o600 })
        fs.renameSync(tmp, ENDPOINT)
        listening = true; bumpIdle(); writePid()
      })
    } else {
      try { fs.unlinkSync(SOCK) } catch {}
      server.listen(SOCK, () => { fs.chmodSync(SOCK, 0o600); listening = true; bumpIdle(); writePid() })
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
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const isMain = () => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF) } catch { return false } }
if (process.argv[1] && isMain()) main()
