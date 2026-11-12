import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { IPC_CHANNELS, MAIN_EVENTS, type TeamhubBridge } from '../shared/ipc'

const allowedInvoke = new Set<string>(IPC_CHANNELS)
const allowedEvents = new Set<string>(MAIN_EVENTS)

const bridge: TeamhubBridge = {
  pathForFile(file) {
    return webUtils.getPathForFile(file)
  },
  invoke(channel, req) {
    if (!allowedInvoke.has(channel)) return Promise.reject(new Error(`blocked channel: ${channel}`))
    return ipcRenderer.invoke(channel, req)
  },
  on(event, cb) {
    if (!allowedEvents.has(event)) throw new Error(`blocked event: ${event}`)
    const listener = (_e: IpcRendererEvent, payload: unknown): void => cb(payload as never)
    ipcRenderer.on(event, listener)
    return () => ipcRenderer.removeListener(event, listener)
  }
}

contextBridge.exposeInMainWorld('teamhub', bridge)
