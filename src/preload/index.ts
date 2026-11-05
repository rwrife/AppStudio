import { contextBridge, ipcRenderer } from 'electron'
import type { Snapshot, StudioApi } from '../shared/types'
import type { DesktopCommand } from '../shared/automation'

const api: StudioApi = {
  mcpStatus: () => ipcRenderer.invoke('studio:mcp-status'),
  copyMcpConfig: () => ipcRenderer.invoke('studio:mcp-copy-config'),
  setOutputDir: (id, directory) => ipcRenderer.invoke('build:set-output', id, directory),
  onCommand: callback => {
    const listener = async (_: Electron.IpcRendererEvent, request: { id: string; command: DesktopCommand }) => {
      try {
        const value = await callback(request.command)
        await ipcRenderer.invoke('desktop:result', { id: request.id, value })
      } catch (error) {
        await ipcRenderer.invoke('desktop:result', { id: request.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    ipcRenderer.on('desktop:command', listener)
    void ipcRenderer.invoke('desktop:ready')
    return () => ipcRenderer.removeListener('desktop:command', listener)
  },
  snapshot: () => ipcRenderer.invoke('studio:snapshot'),
  providers: () => ipcRenderer.invoke('studio:providers'),
  saveSettings: settings => ipcRenderer.invoke('studio:settings', settings),
  testProvider: () => ipcRenderer.invoke('studio:test-provider'),
  createBlueprint: idea => ipcRenderer.invoke('blueprint:create', idea),
  saveBlueprint: blueprint => ipcRenderer.invoke('blueprint:save', blueprint),
  deleteBlueprint: id => ipcRenderer.invoke('blueprint:delete', id),
  interview: (blueprint, nodeId) => ipcRenderer.invoke('ai:interview', blueprint, nodeId),
  analyzeNode: (blueprint, nodeId) => ipcRenderer.invoke('ai:analyze-node', blueprint, nodeId),
  answerQuestion: (blueprint, nodeId, questionId) => ipcRenderer.invoke('ai:answer-question', blueprint, nodeId, questionId),
  suggestBranches: (blueprint, nodeId) => ipcRenderer.invoke('ai:branches', blueprint, nodeId),
  draftAcceptance: (blueprint, nodeId) => ipcRenderer.invoke('ai:acceptance', blueprint, nodeId),
  chooseOutputDir: id => ipcRenderer.invoke('build:output-dir', id),
  startBuild: id => ipcRenderer.invoke('build:start', id),
  cancelBuild: () => ipcRenderer.invoke('build:cancel'),
  revealOutput: id => ipcRenderer.invoke('build:reveal', id),
  onUpdate: callback => {
    const listener = (_: Electron.IpcRendererEvent, snapshot: Snapshot) => callback(snapshot)
    ipcRenderer.on('studio:update', listener)
    return () => ipcRenderer.removeListener('studio:update', listener)
  }
}

contextBridge.exposeInMainWorld('studio', api)
