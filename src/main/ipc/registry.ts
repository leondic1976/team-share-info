import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { z } from 'zod'
import log from 'electron-log/main'
import type { IpcChannel, IpcReq, IpcRes } from '../../shared/ipc'

type Handler<C extends IpcChannel> = (req: IpcReq<C>, event: IpcMainInvokeEvent) => Promise<IpcRes<C>> | IpcRes<C>

/**
 * Register an IPC handler whose input is validated with Zod before it reaches
 * the handler. Pass `null` as schema for channels without input.
 */
export function handle<C extends IpcChannel>(
  channel: C,
  schema: z.ZodType<IpcReq<C>> | null,
  handler: Handler<C>
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    let req = raw as IpcReq<C>
    if (schema) {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) {
        log.warn(`[ipc] invalid input on ${channel}`, parsed.error.issues)
        throw new Error(`invalid input for ${channel}`)
      }
      req = parsed.data
    }
    return handler(req, event)
  })
}
