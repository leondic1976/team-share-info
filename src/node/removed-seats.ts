import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SEAT_NAME_MAX, SEAT_REMOVED_KEEP_DAYS } from '../shared/constants'
import { copyEntries, isInside, removeEntries, treeSize, verifyCopy } from './datamove'
import { cleanSeatName, SEAT_ID_RE, type SeatRecord } from './seats'

/**
 * People removed from a shared PC are not erased at once: their folder is moved to a holding
 * area in the base app data folder and kept for 30 days, so a removal by mistake can be undone
 * by the PC 책임자.
 *
 *   <base>/removed-users/<id>/meta.json   who it was, when, and the registry record (salted PIN hash)
 *   <base>/removed-users/<id>/seat/       the person's folder as it was (<base>/users/<id>)
 *   <base>/removed-users/<id>/data/       personal data that was kept elsewhere (내 자료 저장 위치)
 *
 * The holding area is in the same folder and under the same Windows account as the seat
 * folders, so nothing is more exposed than before. Knows nothing about Electron.
 */
export const REMOVED_DIR = 'removed-users'
const DAY = 86400_000
export const REMOVED_KEEP_MS = SEAT_REMOVED_KEEP_DAYS * DAY

export interface RemovedMeta {
  version: 1
  id: string
  name: string
  removedAt: number
  by: 'self' | 'owner'
  /** What puts the person back in the registry, with the PIN they had (or without one, if they had none). */
  record: SeatRecord
  /** Where the personal data was when it was kept outside the seat folder; null otherwise. */
  dataFrom: string | null
}

export interface RemovedInfo {
  id: string
  name: string
  removedAt: number
  /** Whole days until the backup is erased (0: at the next cleanup). */
  daysLeft: number
  bytes: number
}

export interface HoldResult {
  ok: boolean
  error?: string
  /** The backup is complete, but something of the original could not be removed. */
  warning?: string
  /** Personal data kept elsewhere was copied in: the originals may be removed now. */
  copiedData?: boolean
}

const HEX = /^[a-f0-9]{16,128}$/
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0

/**
 * The record of a kept backup, or null when it cannot be trusted. Nothing but a plain member
 * of the PC is ever put back: an "owner" record or an id that is not this folder's is refused.
 */
export function parseRemovedMeta(raw: unknown, id: string): RemovedMeta | null {
  if (!SEAT_ID_RE.test(id) || !raw || typeof raw !== 'object') return null
  const m = raw as Partial<RemovedMeta>
  const r = m.record as Partial<SeatRecord> | undefined
  if (m.version !== 1 || m.id !== id || !isTime(m.removedAt) || !r || typeof r !== 'object') return null
  if (r.id !== id || r.owner !== false) return null
  // the PIN state comes back as it was: a salted hash, or explicitly none (both null) - nothing in between
  const noPin = r.salt === null && r.hash === null
  if (!noPin && (typeof r.salt !== 'string' || typeof r.hash !== 'string' || !HEX.test(r.salt) || !HEX.test(r.hash))) return null
  const pin = noPin ? { salt: null, hash: null } : { salt: r.salt as string, hash: r.hash as string }
  if (typeof r.name !== 'string') return null
  const name = cleanSeatName(r.name)
  if (!name || name.length > SEAT_NAME_MAX) return null
  return {
    version: 1,
    id,
    name,
    removedAt: m.removedAt,
    by: m.by === 'self' ? 'self' : 'owner',
    record: { id, name, owner: false, ...pin, createdAt: isTime(r.createdAt) ? r.createdAt : 0, lastUsedAt: isTime(r.lastUsedAt) ? r.lastUsedAt : 0, fails: 0, lockUntil: 0 },
    dataFrom: typeof m.dataFrom === 'string' && m.dataFrom ? m.dataFrom : null
  }
}

/** Whole days left before a backup removed at `removedAt` is erased. */
export function removedDaysLeft(removedAt: number, now: number): number {
  return Math.max(0, Math.ceil((removedAt + REMOVED_KEEP_MS - now) / DAY))
}
export const removedExpired = (removedAt: number, now: number): boolean => now >= removedAt + REMOVED_KEEP_MS

/**
 * Move a folder. A plain rename when possible; otherwise (another drive, a file held open by
 * a scanner) copy, compare and then remove the original. Throws with the original untouched
 * when the copy fails; returns a warning when only the removal of the original failed.
 */
export function moveDir(from: string, to: string, rename: (a: string, b: string) => void = renameSync): string | null {
  if (existsSync(to)) throw new Error(`already exists: ${to}`)
  mkdirSync(dirname(to), { recursive: true })
  try {
    rename(from, to)
    return null
  } catch {
    // copy instead
  }
  try {
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false })
    const a = treeSize(from)
    const b = treeSize(to)
    if (a.files !== b.files || a.bytes !== b.bytes) throw new Error('copy is not complete')
  } catch (e) {
    rmSync(to, { recursive: true, force: true })
    throw e
  }
  try {
    rmSync(from, { recursive: true, force: true, maxRetries: 3 })
  } catch (e) {
    return (e as Error).message
  }
  return existsSync(from) ? 'the original folder could not be removed' : null
}

export class RemovedSeats {
  constructor(
    private readonly baseDir: string,
    private readonly now: () => number = Date.now
  ) {}

  root(): string {
    return join(this.baseDir, REMOVED_DIR)
  }

  /** Folder of one kept backup. The id is checked, so the path cannot leave the holding area. */
  dirOf(id: string): string {
    if (!SEAT_ID_RE.test(id)) throw new Error('bad seat id')
    const dir = join(this.root(), id)
    if (!isInside(dir, this.root())) throw new Error('bad seat id')
    return dir
  }

  meta(id: string): RemovedMeta | null {
    try {
      return parseRemovedMeta(JSON.parse(readFileSync(join(this.dirOf(id), 'meta.json'), 'utf8')), id)
    } catch {
      return null
    }
  }

  private names(): string[] {
    try {
      return readdirSync(this.root())
    } catch {
      return []
    }
  }

  /** Kept backups, newest first. `registered` (ids in the registry now) are never listed. */
  list(registered: string[] = []): RemovedInfo[] {
    const t = this.now()
    const out: RemovedInfo[] = []
    for (const id of this.names()) {
      if (!SEAT_ID_RE.test(id) || registered.includes(id)) continue
      const m = this.meta(id)
      if (!m || removedExpired(m.removedAt, t)) continue
      out.push({ id, name: m.name, removedAt: m.removedAt, daysLeft: removedDaysLeft(m.removedAt, t), bytes: treeSize(this.dirOf(id)).bytes })
    }
    return out.sort((a, b) => b.removedAt - a.removedAt)
  }

  /**
   * Put a removed person's data aside. `seatDir` is their folder; `data` names personal data
   * kept elsewhere, which is copied in (and verified) first. Nothing of the original is
   * touched unless the whole backup could be made; on failure the half-made backup is removed.
   */
  async hold(opts: { record: SeatRecord; by: 'self' | 'owner'; seatDir: string; data?: { dir: string; entries: string[] } | null; rename?: (a: string, b: string) => void }): Promise<HoldResult> {
    const { record, seatDir, data } = opts
    let dest: string
    try {
      dest = this.dirOf(record.id)
    } catch {
      return { ok: false, error: 'bad seat id' }
    }
    try {
      // what an earlier, unfinished try left behind is never overwritten
      if (existsSync(dest)) renameSync(dest, `${dest}.old-${this.now()}`)
      mkdirSync(dest, { recursive: true })
      let copiedData = false
      if (data && existsSync(data.dir)) {
        const copied = await copyEntries(data.dir, join(dest, 'data'), data.entries)
        const bad = verifyCopy(data.dir, join(dest, 'data'), copied)
        if (bad) throw new Error(bad)
        copiedData = copied.length > 0
      }
      const meta: RemovedMeta = { version: 1, id: record.id, name: record.name, removedAt: this.now(), by: opts.by, record: { ...record, fails: 0, lockUntil: 0 }, dataFrom: copiedData && data ? data.dir : null }
      if (!parseRemovedMeta(meta, record.id)) throw new Error('the user record cannot be kept')
      writeFileSync(join(dest, 'meta.json'), JSON.stringify(meta, null, 2))
      const warning = existsSync(seatDir) ? moveDir(seatDir, join(dest, 'seat'), opts.rename) : null
      return { ok: true, warning: warning ?? undefined, copiedData }
    } catch (e) {
      try {
        // the seat folder was not moved (moveDir throws only with the original untouched)
        rmSync(dest, { recursive: true, force: true })
      } catch {
        // an entry without its seat folder is cleaned up later
      }
      return { ok: false, error: (e as Error).message }
    }
  }

  /** Undo `hold` when the registry entry could not be dropped after all. */
  unhold(id: string, seatDir: string): void {
    const dest = this.dirOf(id)
    if (existsSync(join(dest, 'seat')) && !existsSync(seatDir)) moveDir(join(dest, 'seat'), seatDir)
    rmSync(dest, { recursive: true, force: true })
  }

  /** Why the files of a kept backup cannot be put back into `seatDir`; null when they can. */
  restoreProblem(id: string, seatDir: string): string | null {
    if (!this.meta(id)) return '보관된 자료를 찾을 수 없습니다(보관 기간이 지났거나 이미 지워졌습니다).'
    if (removedExpired(this.meta(id)!.removedAt, this.now())) return '보관 기간(30일)이 지났습니다.'
    // an existing seat is never overwritten
    if (existsSync(seatDir) && readdirSync(seatDir).length) return '같은 사용자의 폴더가 이미 있어 복구할 수 없습니다.'
    return null
  }

  /**
   * Put the files back: the seat folder as it was, with personal data that had been kept
   * elsewhere now inside it (its 내 자료 저장 위치 goes back to the default: the old place may
   * be gone). The kept backup is removed afterwards. Throws with the backup intact on failure.
   */
  restoreFiles(id: string, seatDir: string, dataEntries: string[]): void {
    const bad = this.restoreProblem(id, seatDir)
    if (bad) throw new Error(bad)
    const dest = this.dirOf(id)
    if (existsSync(seatDir)) rmdirSync(seatDir) // empty (checked above)
    if (existsSync(join(dest, 'seat'))) moveDir(join(dest, 'seat'), seatDir)
    else mkdirSync(seatDir, { recursive: true })
    const data = join(dest, 'data')
    if (existsSync(data) && readdirSync(data).length) {
      // (older data still lying in the seat folder is set aside, not overwritten)
      const aside = join(seatDir, `replaced-${this.now()}`)
      for (const n of readdirSync(seatDir)) {
        if (!dataEntries.some((e) => n === e || (/\.db$/i.test(e) && n.startsWith(`${e}-`)))) continue
        mkdirSync(aside, { recursive: true })
        renameSync(join(seatDir, n), join(aside, n))
      }
      for (const n of readdirSync(data)) moveDir(join(data, n), join(seatDir, n))
      const sf = join(seatDir, 'storage.json')
      let s: Record<string, unknown> = {}
      try {
        s = JSON.parse(readFileSync(sf, 'utf8')) as Record<string, unknown>
      } catch {
        // no pointer: the data is read from the seat folder anyway
      }
      delete s.localDir
      delete s.pending
      writeFileSync(sf, JSON.stringify(s, null, 2))
    }
    try {
      rmSync(dest, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // what is left has no seat folder and is removed by the next cleanup
    }
    this.tidy()
  }

  /** The holding area itself goes when nothing is kept. */
  private tidy(): void {
    try {
      if (existsSync(this.root()) && !readdirSync(this.root()).length) rmdirSync(this.root())
    } catch {
      // the empty folder stays
    }
  }

  /** Erase one kept backup for good. */
  purge(id: string): { ok: boolean; error?: string } {
    let dest: string
    try {
      dest = this.dirOf(id)
    } catch {
      return { ok: false, error: '보관된 자료를 찾을 수 없습니다.' }
    }
    if (!existsSync(dest)) return { ok: false, error: '보관된 자료를 찾을 수 없습니다.' }
    try {
      rmSync(dest, { recursive: true, force: true, maxRetries: 3 })
    } catch (e) {
      return { ok: false, error: `지우지 못했습니다: ${(e as Error).message}` }
    }
    if (existsSync(dest)) return { ok: false, error: '지우지 못한 파일이 있습니다. TeamHub를 종료한 뒤 다시 해 보세요.' }
    this.tidy()
    return { ok: true }
  }

  /**
   * Housekeeping at program start and once a day:
   *  - backups older than 30 days are erased for good;
   *  - a removal that was cut short (the person is still registered) is undone or tidied;
   *  - folders that are no backup (no readable record) go once they are 30 days old.
   * `registered`: ids in the registry now, null when it cannot be read (then nothing that
   * depends on it is touched). `seatDirOf` gives a registered person's folder.
   * Returns the ids that were erased because their time was up.
   */
  cleanup(registered: string[] | null, seatDirOf: (id: string) => string): string[] {
    const t = this.now()
    const gone: string[] = []
    for (const name of this.names()) {
      const dir = join(this.root(), name)
      try {
        if (!SEAT_ID_RE.test(name) || !this.meta(name)) {
          if (t - statSync(dir).mtimeMs >= REMOVED_KEEP_MS) rmSync(dir, { recursive: true, force: true })
          continue
        }
        if (registered?.includes(name)) {
          const seatDir = seatDirOf(name)
          if (existsSync(join(dir, 'seat')) && !existsSync(seatDir)) moveDir(join(dir, 'seat'), seatDir)
          rmSync(dir, { recursive: true, force: true })
          continue
        }
        if (removedExpired(this.meta(name)!.removedAt, t)) {
          rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
          gone.push(name)
        }
      } catch {
        // tried again at the next cleanup
      }
    }
    this.tidy()
    return gone
  }
}

/** Remove personal data that was kept outside the seat folder, once it is safely in the backup. */
export function removeOutsideData(dir: string, entries: string[]): string[] {
  const left = removeEntries(dir, entries)
  try {
    if (existsSync(dir) && !readdirSync(dir).length) rmdirSync(dir)
  } catch {
    // the folder stays
  }
  return left
}
