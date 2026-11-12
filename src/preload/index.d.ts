import type { TeamhubBridge } from '../shared/ipc'

declare global {
  interface Window {
    teamhub: TeamhubBridge
  }
}

export {}
