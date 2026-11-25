import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import type { CmdFile } from '../shared/types'
import type { CommandEvent } from '../shared/events'

/**
 * What the screens of the command module need from the program that shows them (TeamHub
 * today). The screens never import the host's code; they use this.
 */
export interface CommandClientHost {
  api: {
    get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T>
    post<T>(path: string, body?: unknown): Promise<T>
    put<T>(path: string, body?: unknown): Promise<T>
    patch<T>(path: string, body?: unknown): Promise<T>
    del<T>(path: string): Promise<T>
  }
  errorMessage(e: unknown): string
  /** connected to the server */
  useOnline(): boolean
  /** realtime events of the module; returns the unsubscribe */
  on(event: CommandEvent, cb: (payload: unknown) => void): () => void
  onReconnect(cb: () => void): () => void
  /** uploads a file kept by the host; link it to something by its id */
  upload(file: File): Promise<CmdFile>
  /** an uploaded file as a blob URL (for pictures); revoke when done */
  blobUrl(fileId: string): Promise<string>
  /** downloads a file (asks where) */
  download(fileId: string, name: string): void
  /** opens a small chat window with a member (optional) */
  openChat?(memberId: string, name: string): void
  /** saves rows as a CSV file */
  saveCsv(fileName: string, rows: string[][]): void
  /** the 훈련 창 of a drill (a window of its own, in the middle of the screen) */
  openDrillWindow(drillId: string): void
  /** the 훈련 통제실 of a drill (a big window for those in charge) */
  openControlRoom(drillId: string): void
  /** closes the window the screen is in (훈련 창) */
  closeWindow(): void
  /** shows the main window at a route of the module ('' = the module's start) */
  showMain(path: string): void
  /** an alert card with the program's alert sound */
  alert(o: { key: string; title: string; body: string; route: string }): void
  /** where the module lives in the host's routes, e.g. '/command' */
  basePath: string
}

const Ctx = createContext<CommandClientHost | null>(null)

export function CommandHostProvider({ host, children }: { host: CommandClientHost; children: ReactNode }): React.JSX.Element {
  return <Ctx.Provider value={host}>{children}</Ctx.Provider>
}

export function useHost(): CommandClientHost {
  const h = useContext(Ctx)
  if (!h) throw new Error('CommandHostProvider is missing')
  return h
}

/** A picture kept by the host, shown through a blob URL. */
export function useBlobUrl(fileId: string | null | undefined): string | null {
  const host = useHost()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!fileId) {
      setUrl(null)
      return
    }
    let live = true
    let made: string | null = null
    void host
      .blobUrl(fileId)
      .then((u) => {
        made = u
        if (live) setUrl(u)
        else URL.revokeObjectURL(u)
      })
      .catch(() => live && setUrl(null))
    return () => {
      live = false
      if (made) URL.revokeObjectURL(made)
    }
  }, [fileId, host])
  return url
}
