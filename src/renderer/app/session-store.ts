import { create } from 'zustand'
import type { AppInfo } from '@shared/ipc'

interface SessionState {
  app: AppInfo | null
  setApp: (a: AppInfo) => void
}

/** Local app facts (version, PC name...). Connection state lives in conn-store. */
export const useSession = create<SessionState>((set) => ({
  app: null,
  setApp: (app) => set({ app })
}))
