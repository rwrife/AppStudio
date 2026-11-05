import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { Studio } from './studio'
import { LocalMcpServer } from './mcp'
import { desktopCommandSchema, type DesktopCommand } from '../shared/automation'

let window: BrowserWindow
let studio: Studio
let mcp: LocalMcpServer
app.setName('App Studio')
if (process.env.APP_STUDIO_DATA_DIR) app.setPath('userData', process.env.APP_STUDIO_DATA_DIR)
const ownsWorkspace = app.requestSingleInstanceLock()
if (!ownsWorkspace) app.quit()
app.on('second-instance', () => {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore()
    window.focus()
  }
})

const blueprintId = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)

if (ownsWorkspace) app.whenReady().then(async () => {
  const dataDir = app.getPath('userData')
  // An overridden data dir (tests, smoke runs) also keeps default build output out of the real Documents folder.
  studio = new Studio(dataDir, process.env.APP_STUDIO_DATA_DIR ? join(dataDir, 'Documents') : app.getPath('documents'))
  await studio.load()
  window = new BrowserWindow({
    title: 'App Studio', width: 1440, height: 940, minWidth: 1100, minHeight: 740,
    backgroundColor: '#141111', autoHideMenuBar: true, show: !process.env.APP_STUDIO_HIDDEN,
    webPreferences: { preload: join(import.meta.dirname, '../preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault() })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const allowedRenderer = process.env.ELECTRON_RENDERER_URL
  function handle(channel: string, callback: (...args: never[]) => unknown) {
    ipcMain.handle(channel, (event, ...args) => {
      const url = event.senderFrame?.url
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame ||
          !(allowedRenderer ? url?.startsWith(allowedRenderer + '/') || url === allowedRenderer : url === pathToFileURL(join(import.meta.dirname, '../renderer/index.html')).toString()))
        throw new Error('Untrusted desktop IPC caller.')
      return callback(...args as never[])
    })
  }
  let rendererReady = false
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
  const rejectPending = () => {
    rendererReady = false
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('The desktop reloaded or closed. Inspect state before retrying.')) }
    pending.clear()
  }
  window.webContents.on('did-start-loading', rejectPending)
  window.webContents.on('render-process-gone', rejectPending)
  window.on('closed', rejectPending)
  function dispatch(input: DesktopCommand) {
    const command = desktopCommandSchema.parse(input)
    if (!rendererReady || window.isDestroyed()) throw new Error('The desktop is not ready. Try again after it loads.')
    if (pending.size && command.action !== 'studio_get_state') throw new Error('Another desktop command is running. Wait for it to finish.')
    return new Promise<unknown>((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Desktop command timed out; it may still be running. Inspect state before retrying.'))
      }, 10 * 60_000)
      pending.set(id, { resolve, reject, timer })
      window.webContents.send('desktop:command', { id, command })
    })
  }
  handle('desktop:ready', () => { rendererReady = true })
  handle('desktop:result', (input: unknown) => {
    const result = z.object({ id: z.string().uuid(), value: z.unknown().optional(), error: z.string().optional() }).parse(input)
    const item = pending.get(result.id)
    if (!item) return
    pending.delete(result.id); clearTimeout(item.timer)
    if (result.error) item.reject(new Error(result.error))
    else item.resolve(result.value)
  })
  mcp = new LocalMcpServer({
    dispatch,
    window: command => {
      if (window.isDestroyed()) throw new Error('The desktop window is closed.')
      switch (command.operation) {
        case 'focus': window.show(); window.restore(); window.focus(); break
        case 'minimize': window.minimize(); break
        case 'maximize': window.maximize(); break
        case 'restore': window.restore(); break
        case 'resize':
          if (!command.width || !command.height) throw new Error('Resize requires both width and height.')
          window.setSize(command.width, command.height)
          break
      }
      return { bounds: window.getBounds(), minimized: window.isMinimized(), maximized: window.isMaximized(), focused: window.isFocused(), visible: window.isVisible() }
    },
    screenshot: async () => {
      if (window.isDestroyed()) throw new Error('The desktop window is closed.')
      const image = await window.webContents.capturePage()
      if (image.isEmpty()) throw new Error('The desktop screenshot is empty.')
      return image.toPNG().toString('base64')
    }
  }, process.env.APP_STUDIO_DATA_DIR && process.env.APP_STUDIO_MCP_PORT !== undefined
    ? z.coerce.number().int().min(0).max(65535).parse(process.env.APP_STUDIO_MCP_PORT) : undefined)
  handle('studio:mcp-status', () => mcp.status())
  handle('studio:mcp-copy-config', () => {
    const status = mcp.status()
    if (status.state !== 'running') throw new Error('Enable the local MCP server first.')
    clipboard.writeText(JSON.stringify({ mcpServers: { 'app-studio': { type: 'http', url: status.endpoint, headers: { Authorization: `Bearer ${status.token}` } } } }, null, 2))
  })
  studio.onUpdate = snapshot => { if (!window.isDestroyed()) window.webContents.send('studio:update', snapshot) }
  handle('studio:snapshot', () => studio.snapshot())
  handle('studio:providers', () => studio.providers())
  handle('studio:settings', async (settings: unknown) => {
    const saved = await studio.saveSettings(settings)
    await mcp.setEnabled(saved.mcpEnabled)
    return saved
  })
  handle('studio:test-provider', () => studio.testProvider())
  handle('blueprint:create', (idea: unknown) => studio.createBlueprint(idea))
  handle('blueprint:save', (blueprint: unknown) => studio.saveBlueprint(blueprint))
  handle('blueprint:delete', (id: unknown) => studio.deleteBlueprint(id))
  handle('ai:interview', (blueprint: unknown, nodeId: unknown) => studio.interview(blueprint, nodeId))
  handle('ai:analyze-node', (blueprint: unknown, nodeId: unknown) => studio.analyzeNode(blueprint, nodeId))
  handle('ai:answer-question', (blueprint: unknown, nodeId: unknown, questionId: unknown) => studio.answerQuestion(blueprint, nodeId, questionId))
  handle('ai:branches', (blueprint: unknown, nodeId: unknown) => studio.suggestBranches(blueprint, nodeId))
  handle('ai:acceptance', (blueprint: unknown, nodeId: unknown) => studio.draftAcceptance(blueprint, nodeId))
  handle('build:output-dir', async (id: unknown) => {
    const key = blueprintId.parse(id)
    const result = await dialog.showOpenDialog(window, { title: 'Choose where agents build this app', defaultPath: studio.outputDirFor(key), properties: ['openDirectory', 'createDirectory'] })
    if (result.canceled || !result.filePaths[0]) return undefined
    await studio.setOutputDir(key, result.filePaths[0])
    return result.filePaths[0]
  })
  handle('build:start', (id: unknown) => studio.startBuild(blueprintId.parse(id)))
  handle('build:set-output', (id: unknown, directory: unknown) => studio.setOutputDir(blueprintId.parse(id), z.string().parse(directory)))
  handle('build:cancel', () => studio.cancelBuild())
  handle('build:reveal', async (id: unknown) => {
    const dir = studio.outputDirFor(blueprintId.parse(id))
    await mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  await mcp.setEnabled(studio.snapshot().settings.mcpEnabled)
})

app.on('window-all-closed', () => { studio?.cancelBuild(); app.quit() })
app.on('before-quit', () => { void mcp?.close().catch(error => console.error('MCP shutdown failed:', error)) })
