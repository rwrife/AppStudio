import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { desktopCommandSchema, windowCommandSchema, type DesktopCommand, type WindowCommand } from '../shared/automation'
import type { McpStatus } from '../shared/types'

export interface DesktopController {
  dispatch(command: DesktopCommand): Promise<unknown>
  window(command: WindowCommand): unknown
  screenshot(): Promise<string>
}

const textResult = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value ?? null) }] })
const errorResult = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] })
const maxBody = 8 * 1024 * 1024

export function createMcpServer(controller: DesktopController) {
  const server = new McpServer({ name: 'app-studio', version: '0.1.0' }, {
    instructions: 'Control the running App Studio desktop. Read studio_get_state first. Node and build tools operate on the active blueprint; open it first. Respect the user’s intent before deleting data, changing settings, revealing private data, or starting a build. Build agents can execute commands. Do not retry a timed-out mutation blindly: inspect state first. This server does not provide arbitrary shell, JavaScript evaluation or OS-wide input.'
  })
  for (const option of desktopCommandSchema.options) {
    const { action, ...shape } = option.shape
    server.registerTool(action.value, {
      description: option.description,
      inputSchema: z.object(shape).strict(),
      annotations: {
        readOnlyHint: action.value === 'studio_get_state',
        destructiveHint: action.value !== 'studio_get_state',
        openWorldHint: true
      }
    }, async input => {
      try { return textResult(await controller.dispatch(desktopCommandSchema.parse({ ...input, action: action.value }))) }
      catch (error) { return errorResult(error) }
    })
  }
  server.registerTool('desktop_window', {
    description: 'Inspect, focus, minimize, maximize, restore or resize only the App Studio window. No OS-wide input or app quit.',
    inputSchema: windowCommandSchema,
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async input => {
    try { return textResult(await controller.window(windowCommandSchema.parse(input))) }
    catch (error) { return errorResult(error) }
  })
  server.registerTool('desktop_screenshot', {
    description: 'Capture the current App Studio window as a PNG. It may contain private blueprint text, paths and logs.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
  }, async () => {
    try { return { content: [{ type: 'image' as const, mimeType: 'image/png', data: await controller.screenshot() }] } }
    catch (error) { return errorResult(error) }
  })
  return server
}

/** Loopback only, with a fresh in-memory bearer token on each enable. Browser origins are never accepted. */
export class LocalMcpServer {
  private server?: Server
  private current: McpStatus = { state: 'disabled' }
  private lifecycle: Promise<void> = Promise.resolve()
  private active = new Set<Server>()

  constructor(private readonly controller: DesktopController, private readonly port = 47831) {}

  status(): McpStatus { return { ...this.current } }

  setEnabled(enabled: boolean) {
    const next = this.lifecycle.then(() => this.configure(enabled))
    this.lifecycle = next.catch(error => { console.error('MCP lifecycle failed:', error) })
    return next
  }

  private async configure(enabled: boolean) {
    if (!enabled) {
      this.current = { state: 'disabled' }
      const server = this.server
      this.server = undefined
      // Stop accepting work immediately, but let the disabling tools/call response finish.
      if (server) { server.close(); server.closeIdleConnections() }
      return
    }
    if (this.current.state === 'running') return
    const token = randomBytes(32).toString('hex')
    const server = createServer((request, response) => {
      void this.handle(request, response, token).catch(error => {
        console.error('MCP request failed:', error)
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain' })
        response.end('MCP request failed.')
      })
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 10_000
    server.maxConnections = 32
    server.on('close', () => this.active.delete(server))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(this.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
      })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('MCP did not bind a local TCP port.')
      this.server = server
      this.active.add(server)
      this.current = { state: 'running', endpoint: `http://127.0.0.1:${address.port}/mcp`, token }
      server.on('error', error => {
        console.error('MCP listener failed:', error)
        if (this.server === server) { this.current = { state: 'error', error: error.message }; this.server = undefined }
        server.close()
      })
    } catch (error) {
      server.close()
      this.current = { state: 'error', error: error instanceof Error ? error.message : String(error) }
      console.error('Unable to start local MCP server:', error)
    }
  }

  private async handle(request: IncomingMessage, response: ServerResponse, token: string) {
    const deny = (code: number, message: string) => { response.writeHead(code, { 'Content-Type': 'text/plain', 'Connection': 'close' }); response.end(message) }
    const endpoint = this.current.endpoint
    if (this.current.state !== 'running' || this.current.token !== token || !endpoint) return deny(503, 'MCP is disabled.')
    if (request.headers.host !== new URL(endpoint).host || request.headers.origin !== undefined ||
        request.socket.remoteAddress !== '127.0.0.1') return deny(403, 'Only non-browser loopback clients are allowed.')
    const supplied = Buffer.from(request.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${token}`)
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return deny(401, 'A valid MCP bearer token is required.')
    if (request.url !== '/mcp') return deny(404, 'Unknown endpoint.')
    if (request.method !== 'POST') return deny(405, 'Use MCP Streamable HTTP POST requests; this server is stateless.')
    if (!request.headers['content-type']?.startsWith('application/json')) return deny(415, 'Use application/json.')
    if (Number(request.headers['content-length']) > maxBody) return deny(413, 'MCP requests are limited to 8 MiB.')
    let size = 0
    const chunks: Buffer[] = []
    for await (const chunk of request) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += data.length
      if (size > maxBody) return deny(413, 'MCP requests are limited to 8 MiB.')
      chunks.push(data)
    }
    let body: unknown
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { return deny(400, 'Invalid JSON.') }
    // Recheck after reading a slow body: disable must revoke requests already accepted by TCP.
    if (this.current.token !== token || this.current.state !== 'running') return deny(503, 'MCP is disabled.')
    const mcp = createMcpServer(this.controller)
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    response.once('close', () => { void mcp.close().catch(error => console.error('MCP transport cleanup failed:', error)) })
    await mcp.connect(transport)
    await transport.handleRequest(request, response, body)
  }

  async close() {
    await this.setEnabled(false)
    for (const server of this.active) { server.closeAllConnections(); server.close() }
  }
}
