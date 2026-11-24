/** Messages between the main process and the server utility process (13.3). */
/** What the server needs to hand the weekly bundle of feedback posts to the developer's GitHub repository. */
export interface FeedbackRelayConfig {
  /** sealed key file of the app (resources/feedback.bin) */
  file?: string
  /** stand-in for api.github.com (E2E) */
  api?: string
  /** the unique value of the server PC (XXXX-XXXX-XXXX): written into every bundle */
  serverId?: string
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
