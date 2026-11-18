// A tiny stdio MCP server for the tests. Appends "start" to $FAKE_LOG when it starts.
import fs from 'node:fs'
import readline from 'node:readline'
fs.appendFileSync(process.env.FAKE_LOG, 'start\n')
const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n')
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.id === undefined) return
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: 'echo:' + m.params.arguments.text }] } })
  else send({ id: m.id, error: { code: -32601, message: 'Method not found' } })
})
