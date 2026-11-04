import { contextBridge, ipcRenderer } from 'electron'
import type { Snapshot, StudioApi } from '../shared/types'

const api: StudioApi = {
  snapshot: () => ipcRenderer.invoke('studio:snapshot'),
  providers: () => ipcRenderer.invoke('studio:providers'),
  saveSettings: settings => ipcRenderer.invoke('studio:settings', settings),
  testProvider: () => ipcRenderer.invoke('studio:test-provider'),
  createBlueprint: idea => ipcRenderer.invoke('blueprint:create', idea),
  saveBlueprint: blueprint => ipcRenderer.invoke('blueprint:save', blueprint),
  deleteBlueprint: id => ipcRenderer.invoke('blueprint:delete', id),
  interview: (blueprint, nodeId) => ipcRenderer.invoke('ai:interview', blueprint, nodeId),
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
