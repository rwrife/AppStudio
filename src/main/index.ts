import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod'
import { Studio } from './studio'

let window: BrowserWindow
let studio: Studio
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
  studio = new Studio(app.getPath('userData'), app.getPath('documents'))
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
  studio.onUpdate = snapshot => { if (!window.isDestroyed()) window.webContents.send('studio:update', snapshot) }
  handle('studio:snapshot', () => studio.snapshot())
  handle('studio:providers', () => studio.providers())
  handle('studio:settings', (settings: unknown) => studio.saveSettings(settings))
  handle('studio:test-provider', () => studio.testProvider())
  handle('blueprint:create', (idea: unknown) => studio.createBlueprint(idea))
  handle('blueprint:save', (blueprint: unknown) => studio.saveBlueprint(blueprint))
  handle('blueprint:delete', (id: unknown) => studio.deleteBlueprint(id))
  handle('ai:interview', (blueprint: unknown, nodeId: unknown) => studio.interview(blueprint, nodeId))
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
  handle('build:cancel', () => studio.cancelBuild())
  handle('build:reveal', async (id: unknown) => {
    const dir = studio.outputDirFor(blueprintId.parse(id))
    await mkdir(dir, { recursive: true })
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  })
  if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(process.env.ELECTRON_RENDERER_URL)
  else await window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
})

app.on('window-all-closed', () => { studio?.cancelBuild(); app.quit() })
