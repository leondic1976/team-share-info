import { app, dialog, BrowserWindow } from 'electron'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { backup } from 'node:sqlite'
import { z } from 'zod'
import { handle } from './registry'
import { closeLocalDb, localDb, openLocalDb } from '../localdb'

const keySchema = z.string().min(1).max(200)

export function registerLocalIpc(): void {
  handle('local:kv.get', z.object({ key: keySchema }), ({ key }) => localDb().kv.get(key) ?? null)
  handle('local:kv.set', z.object({ key: keySchema, value: z.unknown() }), ({ key, value }) => {
    localDb().kv.set(key, value)
  })
  handle('local:kv.delete', z.object({ key: keySchema }), ({ key }) => {
    localDb().kv.delete(key)
  })
  handle('local:kv.all', null, () => localDb().kv.all())

  handle('local:export', null, async (_req, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const stamp = new Date().toISOString().slice(0, 10)
    const opts = {
      title: '개인 데이터 내보내기',
      defaultPath: `TeamHub-개인데이터-${stamp}.db`,
      filters: [{ name: 'TeamHub 개인 데이터', extensions: ['db'] }]
    }
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
    if (r.canceled || !r.filePath) return { ok: false }
    try {
      if (existsSync(r.filePath)) rmSync(r.filePath)
      await backup(localDb().db.raw, r.filePath)
      return { ok: true, path: r.filePath }
    } catch (err) {
      return { ok: false, error: String(err) }
    }
  })

  handle('local:import', null, async (_req, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = {
      title: '개인 데이터 가져오기',
      properties: ['openFile' as const],
      filters: [{ name: 'TeamHub 개인 데이터', extensions: ['db'] }]
    }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    const src = r.filePaths[0]
    if (r.canceled || !src) return { ok: false }
    const target = localDb().db.path
    const safety = `${target}.before-import`
    try {
      await backup(localDb().db.raw, safety)
      closeLocalDb()
      for (const ext of ['', '-wal', '-shm']) rmSync(target + ext, { force: true })
      copyFileSync(src, target)
      openLocalDb(target)
      app.relaunch()
      app.exit(0)
      return { ok: true, path: src }
    } catch (err) {
      // restore the previous data if the import failed midway
      try {
        closeLocalDb()
        copyFileSync(safety, target)
      } catch {
        // ignore
      }
      openLocalDb(target)
      return { ok: false, error: String(err) }
    }
  })
}
