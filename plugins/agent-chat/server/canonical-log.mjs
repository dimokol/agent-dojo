// Incremental reader for each room's canonical chat.jsonl. Appends are read
// from the last offset; a replaced or shrunk file is read again from the start.
import fs from 'node:fs'
import { safeFile } from './store-files.mjs'

export function createLogReader(logPath) {
  const cache = new Map()
  const records = (room) => {
    const file = logPath(room)
    safeFile(file)
    let stat
    try { stat = fs.statSync(file) } catch (error) { if (error.code === 'ENOENT') return []; throw error }
    let entry = cache.get(room)
    if (!entry || entry.ino !== stat.ino || entry.size > stat.size) entry = { ino: stat.ino, size: 0, records: [], byId: new Map() }
    if (entry.size !== stat.size) {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
      try {
        const chunk = Buffer.alloc(stat.size - entry.size)
        fs.readSync(fd, chunk, 0, chunk.length, entry.size)
        const text = chunk.toString('utf8')
        if (text && !text.endsWith('\n')) throw new Error(`incomplete canonical log: ${room}`)
        const added = []
        for (const line of text.split('\n')) {
          if (!line.trim()) continue
          let record
          try { record = JSON.parse(line) } catch { throw new Error(`malformed canonical log: ${room}`) }
          if (!record.id || typeof record.from !== 'string' || typeof record.to !== 'string') throw new Error('invalid canonical record')
          added.push({ ...record, cursor: entry.records.length + added.length + 1, message_id: record.id })
        }
        entry.records.push(...added)
        for (const record of added) entry.byId.set(record.id, record)
        entry.size = stat.size
        cache.set(room, entry)
      } finally { fs.closeSync(fd) }
    }
    return entry.records
  }
  const indexed = room => (records(room), cache.get(room)?.byId ?? new Map())
  return { records, indexed }
}
