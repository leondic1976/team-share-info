import { app, dialog, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { z } from 'zod'
import log from 'electron-log/main'
import { handle } from './registry'
import { localDb } from '../localdb'
import { rememberSaveDir, savePath } from '../save-dir'
import { localLedgerDocSchema } from '../localdb/ledgers'
import { readDb, readXlsx, writeCsv, writeDb, writeXls, writeXlsx, type SheetData } from '../../node/ledger-files'
import { LEDGER_CHUNK, LEDGER_EXPORT_FORMATS, LEDGER_MAX_COLS, LEDGER_MAX_ROWS, ledgerChangeSchema, type LedgerExportFormat } from '../../shared/schemas/ledger'
import type { IpcRes } from '../../shared/ipc'
import { decodeText } from '../../shared/text-decode'

const id = z.string().min(1).max(60)
const FILTERS: Record<LedgerExportFormat, { name: string; extensions: string[] }> = {
  xlsx: { name: 'Excel 통합 문서', extensions: ['xlsx'] },
  xls: { name: 'Excel 97-2003 통합 문서', extensions: ['xls'] },
  csv: { name: 'CSV (쉼표로 분리)', extensions: ['csv'] },
  db: { name: 'SQLite 데이터베이스', extensions: ['db'] },
  json: { name: '관리대장 파일', extensions: ['json'] }
}
const FORMAT = 'teamhub-ledger@1'
const MAX_OPEN = 60 * 1024 * 1024

const cell = z.union([z.string(), z.number(), z.boolean(), z.null()])
const saveAsSchema = z.object({
  name: z.string().min(1).max(200),
  format: z.enum(LEDGER_EXPORT_FORMATS),
  columns: z.array(z.object({ name: z.string().max(60), kind: z.enum(['text', 'number', 'date', 'check']), format: z.string().max(40).optional(), width: z.number().optional() })).max(LEDGER_MAX_COLS),
  rows: z.array(z.array(cell).max(LEDGER_MAX_COLS)).max(LEDGER_MAX_ROWS),
  book: z.unknown()
})

function writeLedgerFile(path: string, format: LedgerExportFormat, sheet: SheetData, book: unknown): void {
  if (format === 'db') return writeDb(path, sheet, book)
  const data = format === 'xlsx' ? writeXlsx(sheet) : format === 'xls' ? writeXls(sheet) : format === 'csv' ? writeCsv(sheet) : Buffer.from(JSON.stringify({ format: FORMAT, book }, null, 1), 'utf8')
  writeFileSync(path, data)
}

export function readLedgerFile(path: string): IpcRes<'ledger:open'> {
  const ext = extname(path).slice(1).toLowerCase()
  const name = basename(path).replace(/\.[^.]+$/, '')
  if (statSync(path).size > MAX_OPEN) return { ok: false, error: '파일이 너무 큽니다(60MB).' }
  if (ext === 'db') {
    const book = readDb(path)
    return book ? { ok: true, name, kind: 'book', book } : { ok: false, error: '관리대장에서 저장한 데이터베이스(.db)가 아닙니다.' }
  }
  const buf = readFileSync(path)
  if (ext === 'xlsx') return { ok: true, name, kind: 'rows', rows: readXlsx(buf, LEDGER_MAX_ROWS + 1).rows }
  if (ext === 'xls') return { ok: false, error: 'Excel 97-2003 파일(.xls)은 엑셀에서 "Excel 통합 문서(.xlsx)"나 CSV로 저장한 뒤 여세요.' }
  const text = decodeText(buf)
  if (ext === 'json') {
    const data = JSON.parse(text) as { format?: string; book?: unknown }
    return data && data.format === FORMAT && data.book ? { ok: true, name, kind: 'book', book: data.book } : { ok: false, error: '관리대장 파일이 아닙니다.' }
  }
  return { ok: true, name, kind: 'text', text }
}

export function registerLedgerIpc(): void {
  const repo = (): ReturnType<typeof localDb>['ledgers'] => localDb().ledgers
  handle('local:ledger.list', null, () => repo().list())
  handle('local:ledger.trash', null, () => repo().trash())
  handle('local:ledger.get', z.object({ id, after: z.object({ p: z.number(), id }).nullish(), limit: z.number().int().min(1).max(LEDGER_CHUNK * 10).optional() }), (r) => repo().get(r.id, r.after ?? null, r.limit))
  handle('local:ledger.create', z.object({ doc: localLedgerDocSchema, icon: z.string().max(8).optional() }), (r) => repo().create(r.doc, r.icon))
  handle('local:ledger.save', z.object({ id, change: ledgerChangeSchema }), (r) => repo().save(r.id, r.change))
  handle('local:ledger.delete', z.object({ id }), (r) => repo().remove(r.id))
  handle('local:ledger.restore', z.object({ id }), (r) => repo().restore(r.id))
  handle('local:ledger.purge', z.object({ id }), (r) => repo().purge(r.id))
  handle('local:ledger.versions', z.object({ id }), (r) => repo().versions(r.id))
  handle('local:ledger.keep', z.object({ id }), (r) => repo().keep(r.id))
  handle('local:ledger.version', z.object({ id, versionId: id }), (r) => repo().versionDoc(r.id, r.versionId))
  handle('local:ledger.revert', z.object({ id, versionId: id }), (r) => repo().revert(r.id, r.versionId))

  handle('ledger:saveAs', saveAsSchema, async (r, e) => {
    const safe = r.name.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\.+$/, '').slice(0, 120) || '관리대장'
    let path: string
    if (process.env.TEAMHUB_E2E) {
      // E2E cannot answer a save dialog: the file goes into a folder of the test's data
      const dir = join(app.getPath('userData'), 'ledger-files')
      mkdirSync(dir, { recursive: true })
      path = join(dir, `${safe}.${r.format}`)
    } else {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts = { title: '다른 이름으로 저장', defaultPath: savePath(`${safe}.${r.format}`), filters: [FILTERS[r.format]] }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return { ok: false }
      rememberSaveDir(res.filePath)
      path = extname(res.filePath).slice(1).toLowerCase() === r.format ? res.filePath : `${res.filePath}.${r.format}`
    }
    try {
      writeLedgerFile(path, r.format, { name: safe, columns: r.columns, rows: r.rows }, r.book)
      log.info(`ledger saved as ${r.format}: ${path} (${r.rows.length} rows)`)
      return { ok: true, path }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  handle('ledger:open', null, async (_r, e) => {
    let path = (globalThis as { __teamhubOpenLedger?: string }).__teamhubOpenLedger
    if (!process.env.TEAMHUB_E2E || !path) {
      const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
      const opts = {
        title: '파일에서 가져오기',
        filters: [
          { name: '엑셀 · CSV · 관리대장 파일', extensions: ['xlsx', 'csv', 'tsv', 'txt', 'json', 'db'] },
          { name: 'Excel 통합 문서', extensions: ['xlsx'] },
          { name: 'CSV · 텍스트', extensions: ['csv', 'tsv', 'txt'] },
          { name: '관리대장 파일 · 데이터베이스', extensions: ['json', 'db'] }
        ],
        properties: ['openFile' as const]
      }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      path = res.canceled ? undefined : res.filePaths[0]
    }
    if (!path) return { ok: false }
    try {
      return readLedgerFile(path)
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
