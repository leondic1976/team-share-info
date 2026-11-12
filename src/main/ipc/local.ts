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

  // ---------- read cache of server data (13.11, M8-3): shown while the server is unreachable ----------
  handle('local:cache.save', z.object({ entries: z.array(z.object({ key: z.string().max(500), value: z.string().max(2_000_000) })).max(200) }), ({ entries }) => {
    const db = localDb().db
    const t = Date.now()
    db.tx(() => {
      for (const e of entries) db.run('INSERT INTO query_cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [e.key, e.value, t])
      db.run('DELETE FROM query_cache WHERE key NOT IN (SELECT key FROM query_cache ORDER BY updated_at DESC LIMIT 400)')
    })
  })
  handle('local:cache.load', z.object({ prefix: z.string().max(200) }), ({ prefix }) =>
    localDb().db.all<{ key: string; value: string; updated_at: number }>('SELECT key, value, updated_at FROM query_cache WHERE key LIKE ? ORDER BY updated_at DESC', [`${prefix.replace(/[%_]/g, '')}%`]).map((r) => ({ key: r.key, value: r.value, updatedAt: r.updated_at }))
  )
  handle('local:cache.clear', null, () => {
    localDb().db.run('DELETE FROM query_cache')
  })
}
