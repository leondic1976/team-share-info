import type { IpcChannel, IpcReq, IpcRes, MainEvent, MainEventMap } from '@shared/ipc'

/** Typed access to main-process features through the preload bridge (13.8). */
export function invoke<C extends IpcChannel>(
  channel: C,
  ...args: IpcReq<C> extends void ? [] : [IpcReq<C>]
): Promise<IpcRes<C>> {
  return window.teamhub.invoke(channel, args[0] as IpcReq<C>)
}

export function onMain<E extends MainEvent>(event: E, cb: (payload: MainEventMap[E]) => void): () => void {
  return window.teamhub.on(event, cb)
}

export const localKv = {
  get: <T,>(key: string) => invoke('local:kv.get', { key }) as Promise<T | null>,
  set: (key: string, value: unknown) => invoke('local:kv.set', { key, value }),
  delete: (key: string) => invoke('local:kv.delete', { key }),
  all: () => invoke('local:kv.all')
}
