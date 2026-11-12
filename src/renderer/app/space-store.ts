import { create } from 'zustand'
import { localKv } from '@renderer/lib/bridge'

/** Current space (6.2 ④): 'team' or a group id. Feature pages filter by it and use it as default scope. */
interface SpaceState {
  space: string
  loaded: boolean
  load: () => Promise<void>
  setSpace: (s: string) => void
}

export const useSpace = create<SpaceState>((set) => ({
  space: 'team',
  loaded: false,
  load: async () => {
    const s = (await localKv.get<string>('space')) ?? 'team'
    set({ space: s, loaded: true })
  },
  setSpace: (space) => {
    set({ space })
    void localKv.set('space', space)
  }
}))
