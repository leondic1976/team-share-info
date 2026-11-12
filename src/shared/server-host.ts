/** Messages between the main process and the server utility process (13.3). */
export type HostToServer = { type: 'start'; dataDir: string; version: string } | { type: 'stop' }

export type ServerToHost =
  | { type: 'ready'; port: number; bindIp: string }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'restart-requested'; reason: string }
  | { type: 'stopped' }

export interface ServerStatus {
  state: 'stopped' | 'starting' | 'running' | 'error'
  port?: number
  message?: string
  restarts: number
}
