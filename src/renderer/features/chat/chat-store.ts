import { create } from 'zustand'

/** Which conversation is open (to suppress alerts for it and mark it read). */
export const useChatUi = create<{ openId: string | null; setOpen: (id: string | null) => void }>((set) => ({
  openId: null,
  setOpen: (openId) => set({ openId })
}))
