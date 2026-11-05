import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LocalMcpServer, type DesktopController } from '../src/main/mcp'
import { desktopCommandSchema } from '../src/shared/automation'
import { parseSettings } from '../src/main/studio'

const controller: DesktopController = {
  dispatch: async command => {
    if (command.action === 'node_delete') throw new Error('Stop the build before editing.')
    return { action: command.action }
  },
  window: command => ({ operation: command.operation }),
  screenshot: async () => Buffer.from('test image').toString('base64')
}

test('partial tool edits preserve omitted values and legacy settings default MCP off', () => {
  assert.deepEqual(desktopCommandSchema.parse({ action: 'node_update', nodeId: 'n', patch: { title: 'Renamed' } }),
    { action: 'node_update', nodeId: 'n', patch: { title: 'Renamed' } })
  assert.deepEqual(desktopCommandSchema.parse({ action: 'settings_update', patch: { selectedModel: { local: 'model' } } }),
    { action: 'settings_update', patch: { selectedModel: { local: 'model' } } })
  assert.equal(parseSettings({}).mcpEnabled, false)
  assert.equal(parseSettings({ mcpEnabled: true }).mcpEnabled, true)
  assert.equal(parseSettings({ mcpEnabled: 'yes' }).mcpEnabled, false)
})

test('real MCP initialization, discovery, dispatch, validation and tool errors', async () => {
  const server = new LocalMcpServer(controller, 0)
  const client = new Client({ name: 'test', version: '1' })
  try {
    assert.equal(server.status().state, 'disabled')
    await server.setEnabled(true)
    const { endpoint, token } = server.status()
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(),
      [...desktopCommandSchema.options.map(option => option.shape.action.value), 'desktop_window', 'desktop_screenshot'].sort())
    assert.ok(tools.tools.every(tool => tool.description && tool.inputSchema.type === 'object'))
    const result = await client.callTool({ name: 'node_add', arguments: { parentId: 'root' } })
    assert.ok(!result.isError)
    const failed = await client.callTool({ name: 'node_delete', arguments: { nodeId: 'n', confirm: true } })
    assert.equal(failed.isError, true)
    assert.match(JSON.stringify(failed), /Stop the build/)
    assert.equal((await client.callTool({ name: 'node_delete', arguments: { nodeId: 'n' } })).isError, true)
    assert.equal((await client.callTool({ name: 'node_update', arguments: { nodeId: 'n', patch: { status: 'built' } } })).isError, true)
    assert.equal((await client.callTool({ name: 'desktop_window', arguments: { operation: 'resize', width: -1 } })).isError, true)
    assert.equal((await client.callTool({ name: 'desktop_window', arguments: { operation: 'state' } })).isError, undefined)
    const image = await client.callTool({ name: 'desktop_screenshot' })
    assert.match(JSON.stringify(image), /image\/png/)
  } finally { await client.close(); await server.close() }
})

test('loopback endpoint rejects unauthenticated requests, browser origins, hostile hosts and malformed bodies', async () => {
  const server = new LocalMcpServer(controller, 0)
  try {
    await server.setEnabled(true)
    const { endpoint, token } = server.status()
    const request = (headers: Record<string, string> = {}, body = '{}', path = endpoint!) => fetch(path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...headers }, body
    })
    assert.equal((await request({ Authorization: '' })).status, 401)
    assert.equal((await request({ Authorization: 'Bearer invalid' })).status, 401)
    assert.equal((await request({ Origin: 'http://127.0.0.1' })).status, 403)
    assert.equal((await request({ Origin: 'null' })).status, 403)
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(endpoint!, { method: 'POST', headers: { Host: 'evil.example', Authorization: `Bearer ${token}` } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(hostileHostStatus, 403)
    assert.equal((await request({}, '{')).status, 400)
    assert.equal((await request({ 'Content-Type': 'text/plain' })).status, 415)
    assert.equal((await request({}, '{}', endpoint!.replace('/mcp', '/other'))).status, 404)
    const oversizedStatus = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest(endpoint!, { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': 8 * 1024 * 1024 + 1
      } }, response => { response.resume(); resolve(response.statusCode) })
      req.on('error', reject); req.end()
    })
    assert.equal(oversizedStatus, 413)
    assert.equal((await fetch(endpoint!, { headers: { Authorization: `Bearer ${token}` } })).status, 405)
    await server.setEnabled(false)
    assert.deepEqual(server.status(), { state: 'disabled' })
    await assert.rejects(fetch(endpoint!))
    await server.setEnabled(true)
    assert.notEqual(server.status().token, token)
    assert.equal((await request({ Authorization: `Bearer ${token}` }, '{}', server.status().endpoint)).status, 401)
  } finally { await server.close() }
})

test('disable from a tool returns its response before revoking the connection', async () => {
  const server = new LocalMcpServer({
    ...controller, dispatch: async () => { await server.setEnabled(false); return { disabled: true } }
  }, 0)
  const client = new Client({ name: 'test-disable', version: '1' })
  try {
    await server.setEnabled(true)
    const { endpoint, token } = server.status()
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint!), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }))
    const reply = await client.callTool({ name: 'settings_update', arguments: { patch: { mcpEnabled: false } } })
    assert.ok(!reply.isError)
    assert.match(JSON.stringify(reply), /disabled/)
    assert.equal(server.status().state, 'disabled')
    await assert.rejects(fetch(endpoint!))
  } finally { await client.close(); await server.close() }
})

test('port conflicts are visible and can recover after the other listener closes', async () => {
  const first = new LocalMcpServer(controller, 0)
  await first.setEnabled(true)
  const port = Number(new URL(first.status().endpoint!).port)
  const second = new LocalMcpServer(controller, port)
  try {
    await second.setEnabled(true)
    assert.equal(second.status().state, 'error')
    assert.match(second.status().error!, /EADDRINUSE/)
    await first.close()
    await second.setEnabled(true)
    assert.equal(second.status().state, 'running')
  } finally { await first.close(); await second.close() }
})
