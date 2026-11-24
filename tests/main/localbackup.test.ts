import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyPendingRestore,
  autoDue,
  BACKUP_DIR,
  clampKeep,
  dbSignature,
  listSnapshots,
  makeSnapshot,
  parseSnapshotId,
  pruneSnapshots,
  readState,
  restorePending,
  SAFETY_KEEP,
  sameSig,
  snapshotName,
  snapshotPath,
  snapshotsToPrune,
  SNAPSHOT_ID_RE,
  spaceNeeded,
  stageRestore,
  verifySnapshot,
  writeState,
  type Snapshot,
  type SnapshotKind
} from '../../src/node/localbackup'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { LOCAL_BACKUP_KEEP_DEFAULT, LOCAL_BACKUP_KEEP_MAX, LOCAL_BACKUP_KEEP_MIN } from '../../src/shared/constants'

const DAY = 86400_000
const MAX = Math.max(...LOCAL_MIGRATIONS.map((m) => m.id))
const dirs: string[] = []
const open: Db[] = []
function fresh(): { root: string; file: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), 'teamhub-backup-'))
  dirs.push(root)
  return { root, file: join(root, 'local.db'), dir: join(root, BACKUP_DIR) }
}
/** A real local DB (all migrations), like the one the program opens. */
function localDb(file: string): Db {
  const db = new Db(file)
  db.migrate(LOCAL_MIGRATIONS)
  open.push(db)
  return db
}
const close = (db: Db): void => {
  db.close()
  open.splice(open.indexOf(db), 1)
}
afterEach(() => {
  for (const db of open.splice(0)) db.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const setKv = (db: Db, k: string, v: string): void => void db.run('INSERT INTO kv (key, value, updated_at) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v])
const getKv = (db: Db, k: string): string | undefined => db.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', [k])?.value
const at = (y: number, mo: number, d: number, h = 9, mi = 0, s = 0): number => new Date(y, mo - 1, d, h, mi, s).getTime()

describe('내 자료 백업: names and ids of snapshots', () => {
  it('a snapshot is named by local date, time and kind, and the name parses back', () => {
    const t = at(2026, 11, 24, 9, 5, 7)
    expect(snapshotName(t, 'auto')).toBe('local-20261124-090507-auto.db')
    expect(snapshotName(t, 'safety')).toBe('local-20261124-090507-safety.db')
    expect(parseSnapshotId('local-20261124-090507-manual.db')).toEqual({ at: t, kind: 'manual' })
    expect(SNAPSHOT_ID_RE.test(snapshotName(Date.now(), 'manual'))).toBe(true)
  })

  it('anything that is not exactly a snapshot name is refused, so an id can never be a path', () => {
    const dir = join('C:', 'data', 'backups')
    for (const bad of [
      '',
      'local.db',
      '../local.db',
      '..\\local-20261124-090507-auto.db',
      'sub/local-20261124-090507-auto.db',
      'local-20261124-090507-auto.db/..',
      'C:\\Windows\\local-20261124-090507-auto.db',
      'local-20261124-090507-auto.db.tmp',
      'local-20261124-090507-other.db',
      'local-20261124-090507-auto.DB',
      'local-20261340-090507-auto.db', // no such date
      'local-20261124-250000-auto.db', // no such time
      'restore-pending.db',
      ' local-20261124-090507-auto.db',
      'local-20261124-090507-auto.db\n',
      null,
      42,
      { id: 'local-20261124-090507-auto.db' }
    ]) {
      expect(parseSnapshotId(bad)).toBeNull()
      expect(snapshotPath(dir, bad)).toBeNull()
    }
    expect(snapshotPath(dir, 'local-20261124-090507-auto.db')).toBe(join(dir, 'local-20261124-090507-auto.db'))
  })

  it('only snapshots are listed, newest first', () => {
    const { dir } = fresh()
    mkdirSync(dir, { recursive: true })
    for (const n of ['local-20261120-090000-auto.db', 'local-20261124-090000-manual.db', 'local-20261122-090000-safety.db', 'state.json', 'restore-pending.db', 'local-20261125-090000-auto.db.tmp', 'notes.txt']) writeFileSync(join(dir, n), 'x'.repeat(10))
    mkdirSync(join(dir, 'local-20261126-090000-auto.db')) // a folder with a snapshot's name is not one
    expect(listSnapshots(dir).map((s) => s.id)).toEqual(['local-20261124-090000-manual.db', 'local-20261122-090000-safety.db', 'local-20261120-090000-auto.db'])
    expect(listSnapshots(dir)[0]).toEqual({ id: 'local-20261124-090000-manual.db', kind: 'manual', at: at(2026, 11, 24), bytes: 10 })
    expect(listSnapshots(join(dir, 'missing'))).toEqual([])
  })
})

describe('내 자료 백업: what is kept', () => {
  const snap = (day: number, kind: SnapshotKind): Snapshot => ({ id: snapshotName(at(2026, 11, day), kind), kind, at: at(2026, 11, day), bytes: 1 })

  it('the newest N daily snapshots stay; manual ones always; the newest few made before a restore', () => {
    const snaps = [...Array.from({ length: 10 }, (_, i) => snap(i + 1, 'auto')), snap(1, 'manual'), snap(2, 'manual'), ...Array.from({ length: 5 }, (_, i) => snap(i + 11, 'safety'))]
    const gone = snapshotsToPrune(snaps, 7)
    // daily: days 1-3 go, 4-10 stay
    expect(gone.filter((id) => id.endsWith('-auto.db')).sort()).toEqual([1, 2, 3].map((d) => snap(d, 'auto').id))
    expect(gone.some((id) => id.endsWith('-manual.db'))).toBe(false)
    // made before a restore: the newest stay, and the very newest always
    expect(SAFETY_KEEP).toBeGreaterThanOrEqual(1)
    expect(gone.filter((id) => id.endsWith('-safety.db')).sort()).toEqual([11, 12].map((d) => snap(d, 'safety').id))
    expect(gone).not.toContain(snap(15, 'safety').id)
    expect(snapshotsToPrune(snaps.slice(0, 7), 7)).toEqual([])
  })

  it('the count is kept within 3-30', () => {
    expect(clampKeep(1)).toBe(LOCAL_BACKUP_KEEP_MIN)
    expect(clampKeep(1000)).toBe(LOCAL_BACKUP_KEEP_MAX)
    expect(clampKeep(12.4)).toBe(12)
    expect(clampKeep('abc')).toBe(LOCAL_BACKUP_KEEP_DEFAULT)
    expect(clampKeep(undefined)).toBe(LOCAL_BACKUP_KEEP_DEFAULT)
    const snaps = Array.from({ length: 40 }, (_, i) => ({ id: `a${i}`, kind: 'auto' as const, at: i, bytes: 1 }))
    expect(snapshotsToPrune(snaps, 0)).toHaveLength(40 - LOCAL_BACKUP_KEEP_MIN)
    expect(snapshotsToPrune(snaps, 99)).toHaveLength(40 - LOCAL_BACKUP_KEEP_MAX)
  })

  it('pruning removes the files, except one that is being restored', () => {
    const { dir } = fresh()
    mkdirSync(dir, { recursive: true })
    const ids = Array.from({ length: 6 }, (_, i) => snapshotName(at(2026, 11, i + 1), 'auto'))
    for (const id of ids) writeFileSync(join(dir, id), 'x')
    expect(pruneSnapshots(dir, 3, ids[0]).sort()).toEqual([ids[1], ids[2]])
    expect(listSnapshots(dir).map((s) => s.id).sort()).toEqual([ids[0], ids[3], ids[4], ids[5]])
  })

  it('state is kept next to the snapshots and survives a damaged file', () => {
    const { dir } = fresh()
    expect(readState(dir)).toEqual({ keep: LOCAL_BACKUP_KEEP_DEFAULT, lastAutoAt: 0, lastSig: null, note: null, restore: null })
    const sig = { size: 1, mtimeMs: 2, walSize: 3, walMtimeMs: 4 }
    writeState(dir, { keep: 12, lastAutoAt: 5, lastSig: sig, note: '빈 공간이 모자랍니다', restore: { ok: true, message: '복구했습니다', at: 6 } })
    expect(readState(dir)).toEqual({ keep: 12, lastAutoAt: 5, lastSig: sig, note: '빈 공간이 모자랍니다', restore: { ok: true, message: '복구했습니다', at: 6 } })
    writeFileSync(join(dir, 'state.json'), '{"keep": 500, "lastSig": {"size": "x"}, "restore": 3')
    expect(readState(dir).keep).toBe(LOCAL_BACKUP_KEEP_DEFAULT)
    writeFileSync(join(dir, 'state.json'), '{"keep": 500, "lastSig": {"size": "x"}, "lastAutoAt": "soon"}')
    expect(readState(dir)).toMatchObject({ keep: LOCAL_BACKUP_KEEP_MAX, lastSig: null, lastAutoAt: 0 })
  })

  it('the daily run is due when none was made in the last 24 hours', () => {
    const base = { keep: 7, lastSig: null, note: null, restore: null }
    const now = at(2026, 11, 24)
    expect(autoDue({ ...base, lastAutoAt: 0 }, now)).toBe(true)
    expect(autoDue({ ...base, lastAutoAt: now - DAY + 1000 }, now)).toBe(false)
    expect(autoDue({ ...base, lastAutoAt: now - DAY }, now)).toBe(true)
    expect(autoDue({ ...base, lastAutoAt: now + 5 * DAY }, now)).toBe(true) // the clock was set back
  })
})

describe('내 자료 백업: snapshot, change detection, restore (real SQLite)', () => {
  it('the signature of the DB changes with a write and not without one', async () => {
    const { file } = fresh()
    const db = localDb(file)
    setKv(db, 'a', '"1"')
    const s1 = dbSignature(file)
    expect(sameSig(s1, dbSignature(file))).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    db.get('SELECT COUNT(*) FROM kv') // reading changes nothing
    expect(sameSig(s1, dbSignature(file))).toBe(true)
    setKv(db, 'b', `"${'x'.repeat(5000)}"`)
    expect(sameSig(s1, dbSignature(file))).toBe(false)
    expect(sameSig(null, s1)).toBe(false)
    expect(dbSignature(join(file, 'missing'))).toEqual({ size: 0, mtimeMs: 0, walSize: 0, walMtimeMs: 0 })
  })

  it('round trip: rows, snapshot, changed rows, restore, the rows are the old ones again', async () => {
    const { file, dir } = fresh()
    let db = localDb(file)
    setKv(db, 'memo', '"처음 쓴 메모"')
    setKv(db, 'gone-later', '"지워질 것"')

    const t = at(2026, 11, 24, 10, 0, 0)
    const made = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: t, maxMigration: MAX })
    expect(made).toMatchObject({ ok: true, id: 'local-20261124-100000-manual.db' })
    if (!made.ok) throw new Error('unreachable')
    expect(made.bytes).toBe(statSync(join(dir, made.id)).size)
    expect(verifySnapshot(join(dir, made.id), MAX)).toBeNull()
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    // a second one in the same second gets its own name
    const again = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: t })
    expect(again).toMatchObject({ ok: true, id: 'local-20261124-100001-manual.db' })

    // the data moves on
    setKv(db, 'memo', '"고쳐 쓴 메모"')
    db.run('DELETE FROM kv WHERE key = ?', ['gone-later'])
    setKv(db, 'new', '"백업 뒤에 쓴 것"')

    // restore: today's data is saved first, then the snapshot is staged
    const safety = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'safety', now: t + 60_000, maxMigration: MAX })
    expect(safety.ok).toBe(true)
    await stageRestore(dir, snapshotPath(dir, made.id)!, made.id, t + 61_000, MAX)
    expect(restorePending(dir)).toBe(true)
    // nothing changed yet: the running program still has today's data
    expect(getKv(db, 'memo')).toBe('"고쳐 쓴 메모"')
    close(db)

    // next start, before the DB opens
    const r = applyPendingRestore(dir, file, { maxMigration: MAX, now: t + 70_000 })
    expect(r).toMatchObject({ ok: true, at: t + 70_000 })
    expect(r!.message).toContain('2026-11-24 10:00')
    expect(restorePending(dir)).toBe(false)
    expect(readdirSync(dir).some((n) => n.startsWith('restore-pending'))).toBe(false)
    expect(readdirSync(join(dir, '..')).filter((n) => n.includes('.replaced'))).toEqual([])
    expect(applyPendingRestore(dir, file)).toBeNull() // once

    db = localDb(file)
    expect(getKv(db, 'memo')).toBe('"처음 쓴 메모"')
    expect(getKv(db, 'gone-later')).toBe('"지워질 것"')
    expect(getKv(db, 'new')).toBeUndefined()
    // the snapshot that was restored is still there, and so is the state right before the restore
    expect(existsSync(join(dir, made.id))).toBe(true)
    close(db)
    if (!safety.ok) throw new Error('unreachable')
    const before = new Db(join(dir, safety.id))
    open.push(before)
    expect(getKv(before, 'memo')).toBe('"고쳐 쓴 메모"')
    expect(getKv(before, 'new')).toBe('"백업 뒤에 쓴 것"')
  })

  it('a corrupt snapshot is refused, and so is a file that is not a TeamHub personal DB', async () => {
    const { root, file, dir } = fresh()
    const db = localDb(file)
    for (let i = 0; i < 300; i++) setKv(db, `k${i}`, `"${'값'.repeat(200)}"`)
    const made = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: at(2026, 11, 24), maxMigration: MAX })
    if (!made.ok) throw new Error(made.error)
    const good = join(dir, made.id)
    expect(verifySnapshot(good, MAX)).toBeNull()

    // damaged in the middle (a bad disk sector, a cut-short copy)
    const bytes = readFileSync(good)
    const broken = join(dir, 'local-20261124-110000-manual.db')
    const damaged = Buffer.from(bytes)
    damaged.fill(0x5a, 4096 * 2, 4096 * 6)
    writeFileSync(broken, damaged)
    expect(verifySnapshot(broken, MAX)).toMatch(/손상/)
    const cut = join(dir, 'local-20261124-120000-manual.db')
    writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)))
    expect(verifySnapshot(cut, MAX)).not.toBeNull()

    const text = join(root, 'not-a-db.db')
    writeFileSync(text, 'hello '.repeat(200))
    expect(verifySnapshot(text, MAX)).not.toBeNull()
    writeFileSync(join(root, 'empty.db'), '')
    expect(verifySnapshot(join(root, 'empty.db'), MAX)).toMatch(/비어 있거나/)
    expect(verifySnapshot(join(root, 'missing.db'), MAX)).not.toBeNull()
    // some other program's SQLite file
    const other = new Db(join(root, 'other.db'))
    other.exec('CREATE TABLE t (a)')
    other.close()
    expect(verifySnapshot(join(root, 'other.db'), MAX)).toMatch(/개인 자료 파일이 아닙니다/)
    // made by a newer program than this one
    expect(verifySnapshot(good, MAX - 1)).toMatch(/새 버전/)

    // staging a damaged file fails and leaves nothing staged
    await expect(stageRestore(dir, broken, 'local-20261124-110000-manual.db', 1, MAX)).rejects.toThrow()
    expect(restorePending(dir)).toBe(false)
    expect(existsSync(join(dir, 'restore-pending.db'))).toBe(false)
  })

  it('a staged file that went bad before the restart is not swapped in: the current data stays', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    setKv(db, 'memo', '"지금 자료"')
    const made = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: at(2026, 11, 24), maxMigration: MAX })
    if (!made.ok) throw new Error(made.error)
    await stageRestore(dir, join(dir, made.id), made.id, 1, MAX)
    close(db)
    writeFileSync(join(dir, 'restore-pending.db'), 'ruined')
    const r = applyPendingRestore(dir, file, { maxMigration: MAX })
    expect(r).toMatchObject({ ok: false })
    expect(r!.message).toContain('지금 자료를 그대로')
    expect(restorePending(dir)).toBe(false)
    const again = localDb(file)
    expect(getKv(again, 'memo')).toBe('"지금 자료"')
  })

  it('a swap that fails half way puts the current DB back', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    setKv(db, 'memo', '"지금 자료"')
    const made = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: at(2026, 11, 24), maxMigration: MAX })
    if (!made.ok) throw new Error(made.error)
    setKv(db, 'memo', '"그 뒤의 자료"')
    await stageRestore(dir, join(dir, made.id), made.id, 1, MAX)
    close(db)
    const { renameSync } = await import('node:fs')
    // setting the current DB aside works, putting the staged one in place does not
    const rename = (a: string, b: string): void => {
      if (a.endsWith('restore-pending.db')) throw new Error('EPERM: operation not permitted')
      renameSync(a, b)
    }
    const r = applyPendingRestore(dir, file, { maxMigration: MAX, rename })
    expect(r).toMatchObject({ ok: false })
    expect(readdirSync(join(dir, '..')).filter((n) => n.includes('.replaced'))).toEqual([])
    const again = localDb(file)
    expect(getKv(again, 'memo')).toBe('"그 뒤의 자료"')
  })

  it('a stale write-ahead log of the replaced DB is never left next to the restored one', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    setKv(db, 'memo', '"백업한 자료"')
    const made = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'manual', now: at(2026, 11, 24), maxMigration: MAX })
    if (!made.ok) throw new Error(made.error)
    await stageRestore(dir, join(dir, made.id), made.id, 1, MAX)
    close(db)
    // the program was killed: side files of the old DB are still there
    writeFileSync(`${file}-wal`, 'stale wal of the old database')
    writeFileSync(`${file}-shm`, 'stale shm')
    expect(applyPendingRestore(dir, file, { maxMigration: MAX })).toMatchObject({ ok: true })
    expect(existsSync(`${file}-wal`)).toBe(false)
    expect(existsSync(`${file}-shm`)).toBe(false)
    const again = localDb(file)
    expect(getKv(again, 'memo')).toBe('"백업한 자료"')
  })

  it('the program stopped right after the swap: the next start only tidies up', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    setKv(db, 'memo', '"복구된 자료"')
    close(db)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'restore-pending.json'), JSON.stringify({ from: 'local-20261124-090000-auto.db', at: 1 }))
    writeFileSync(`${file}.replaced`, 'the DB that was replaced')
    expect(applyPendingRestore(dir, file, { maxMigration: MAX })).toMatchObject({ ok: true })
    expect(existsSync(`${file}.replaced`)).toBe(false)
    expect(restorePending(dir)).toBe(false)
    expect(getKv(localDb(file), 'memo')).toBe('"복구된 자료"')
  })

  it('no snapshot is made when the drive is short of room, and nothing half-made is left', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    setKv(db, 'memo', '"자료"')
    const size = dbSignature(file)
    const need = spaceNeeded(size.size + size.walSize)
    expect(need).toBeGreaterThan(50 * 1024 * 1024)
    const r = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'auto', now: at(2026, 11, 24), free: () => need - 1 })
    expect(r).toMatchObject({ ok: false, reason: 'space' })
    if (!r.ok) expect(r.error).toContain('빈 공간이 모자라')
    expect(listSnapshots(dir)).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    // exactly enough, or a drive that does not tell: made
    expect((await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'auto', now: at(2026, 11, 24), free: () => need })).ok).toBe(true)
    expect((await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'auto', now: at(2026, 11, 25), free: () => null })).ok).toBe(true)
  })

  it('a snapshot does not hold up the thread: other work runs while a large DB is copied', async () => {
    const { file, dir } = fresh()
    const db = localDb(file)
    db.tx(() => {
      for (let i = 0; i < 4000; i++) setKv(db, `k${i}`, `"${'가나다라'.repeat(500)}"`)
    })
    let ticks = 0
    const timer = setInterval(() => ticks++, 1)
    const r = await makeSnapshot({ db: db.raw, dbFile: file, dir, kind: 'auto', now: at(2026, 11, 24), maxMigration: MAX })
    clearInterval(timer)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.bytes).toBeGreaterThan(20 * 1024 * 1024)
    expect(ticks).toBeGreaterThan(0)
  })
})
