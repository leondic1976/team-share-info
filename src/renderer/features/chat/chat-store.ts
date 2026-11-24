import { create } from 'zustand'

/**
 * Which conversations are being looked at (to suppress alerts for them and mark them read):
 * the one on the messenger page plus every expanded small messenger window. A conversation can
 * be on screen twice, so each view is counted.
 */
export const useChatUi = create<{ viewing: Record<string, number>; view: (id: string) => void; unview: (id: string) => void }>((set) => ({
  viewing: {},
  view: (id) => set((s) => ({ viewing: { ...s.viewing, [id]: (s.viewing[id] ?? 0) + 1 } })),
  unview: (id) =>
    set((s) => {
      const next = { ...s.viewing }
      if ((next[id] ?? 0) > 1) next[id]--
      else delete next[id]
      return { viewing: next }
    })
}))

export const isViewingConversation = (id: string): boolean => (useChatUi.getState().viewing[id] ?? 0) > 0
