import { app, BrowserWindow, dialog } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { handle } from './registry'
import { rememberSaveDir, savePath } from '../save-dir'
import { cancelTransfer, clearFinished, downloadTo, enqueueUploads, listTransfers, openWithApp, resumeTransfers, retryTransfer } from '../transfer'

export function registerTransferIpc(): void {
  handle('transfer:upload', z.object({ paths: z.array(z.string().min(3)).min(1).max(5000), folderId: z.string(), fileId: z.string().optional(), note: z.string().max(300).optional() }), (r) =>
    enqueueUploads(r.paths, r.folderId, { fileId: r.fileId, note: r.note })
  )
  handle('transfer:list', null, () => listTransfers())
  handle('transfer:cancel', z.object({ id: z.string() }), ({ id }) => cancelTransfer(id))
  handle('transfer:clearDone', null, () => clearFinished())
  handle('transfer:resume', null, () => resumeTransfers())
  handle('transfer:retry', z.object({ id: z.string() }), ({ id }) => retryTransfer(id))
  handle('transfer:pick', z.object({ folders: z.boolean().default(false) }), async ({ folders }, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title: folders ? '올릴 폴더 선택' : '올릴 파일 선택', properties: folders ? (['openDirectory', 'multiSelections'] as const) : (['openFile', 'multiSelections'] as const) }
    const r = win ? await dialog.showOpenDialog(win, { ...opts, properties: [...opts.properties] }) : await dialog.showOpenDialog({ ...opts, properties: [...opts.properties] })
    return r.canceled ? [] : r.filePaths
  })
  handle('transfer:download', z.object({ fileId: z.string(), name: z.string().min(1).max(200), versionId: z.string().optional() }), async ({ fileId, name, versionId }, e) => {
    let dest: string
    if (process.env.TEAMHUB_E2E) {
      // E2E cannot answer a save dialog: the file goes into a folder of the test's data
      const dir = join(app.getPath('userData'), 'downloads')
      mkdirSync(dir, { recursive: true })
      dest = join(dir, name)
    } else {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts = { title: '저장할 위치', defaultPath: savePath(name) }
      const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (r.canceled || !r.filePath) return { ok: false }
      dest = r.filePath
      rememberSaveDir(dest)
    }
    try {
      return { ok: true, path: await downloadTo(fileId, name, dest, versionId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
  handle('transfer:open', z.object({ fileId: z.string(), name: z.string().min(1).max(200), folderId: z.string() }), async ({ fileId, name, folderId }) => {
    try {
      return { ok: true, path: await openWithApp(fileId, name, folderId) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}
