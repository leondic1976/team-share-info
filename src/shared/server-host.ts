/** Messages between the main process and the server utility process (13.3). */
/** Where the server finds what it needs to pass members' feedback posts on to the board (PCs without internet). */
export interface FeedbackRelayConfig {
  /** sealed key file of the app (resources/feedback.bin) */
  file?: string
  /** stand-in for api.github.com (E2E) */
  api?: string
  /** download site with the list of shut-out PCs; null: do not look */
  site?: string | null
}

export type HostToServer =
  | {
      type: 'start'
      dataDir: string
      version: string
      feedback?: FeedbackRelayConfig
      /** resources/forms of the program: official forms put into the file library (서식자료실) */
      formsDir?: string
    }
  | { type: 'stop' }

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
