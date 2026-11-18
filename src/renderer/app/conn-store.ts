import { create } from 'zustand'
import type { ConnInfo } from '@shared/ipc'
import type { MeDto } from '@shared/schemas/auth'

export type ConnState = 'loading' | 'unconfigured' | 'pending' | 'connecting' | 'online' | 'offline' | 'rejected' | 'update-required'

interface ConnStore {
  mode: ConnInfo['mode']
  serverUrl: string | null
  deviceId: string | null
  deviceKey: string | null
  memberId: string | null
  winUser: string
  pcName: string
  appVersion: string
  pcUid: string | null
  lockedRole: ConnInfo['lockedRole']
  state: ConnState
  message: string
  me: MeDto | null
  load: (info: ConnInfo) => void
  setState: (s: ConnState, message?: string) => void
  setMe: (me: MeDto | null) => void
}

export const useConn = create<ConnStore>((set) => ({
  mode: null,
  serverUrl: null,
  deviceId: null,
  deviceKey: null,
  memberId: null,
  winUser: '',
  pcName: '',
  appVersion: '',
  pcUid: null,
  lockedRole: null,
  state: 'loading',
  message: '',
  me: null,
  load: (info) =>
    set({
      mode: info.mode,
      serverUrl: info.serverUrl,
      deviceId: info.deviceId,
      deviceKey: info.deviceKey,
      memberId: info.memberId,
      winUser: info.winUser,
      pcName: info.pcName,
      appVersion: info.appVersion,
      pcUid: info.pcUid,
      lockedRole: info.lockedRole,
      state: !info.mode ? 'unconfigured' : info.deviceId ? 'connecting' : info.pending ? 'pending' : 'unconfigured'
    }),
  setState: (state, message = '') => set({ state, message }),
  setMe: (me) => set({ me })
}))

export const isOnline = (): boolean => useConn.getState().state === 'online'
