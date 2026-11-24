import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { SeatRegistry, restoredSeatName, type SeatRecord } from '../../src/node/seats'
import { moveDir, parseRemovedMeta, REMOVED_DIR, REMOVED_KEEP_MS, removedDaysLeft, RemovedSeats, removeOutsideData } from '../../src/node/removed-seats'
import { SEAT_NAME_MAX } from '../../src/shared/constants'

const DAY = 86400_000
const OWNER = '2749'
const KIM = '8051'
const ENTRIES = ['local.db', 'plugins', 'backups']

const dirs: string[] = []
function fresh(): { base: string; reg: SeatRegistry; held: RemovedSeats; clock: { t: number } } {
  const base = mkdtempSync(join(tmpdir(), 'teamhub-removed-'))
  dirs.push(base)
  const clock = { t: 1_800_000_000_000 }
  return { base, reg: new SeatRegistry(base, () => clock.t), held: new RemovedSeats(base, () => clock.t), clock }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A registered second person with a folder that holds a device key and a note. */
function withKim(x: ReturnType<typeof fresh>): { id: string; dir: string } {
  expect(x.reg.enable('홍길동', OWNER).ok).toBe(true)
  const id = x.reg.add(OWNER, '김주무', KIM).id!
  const dir = x.reg.dirOf({ id, owner: false })
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(join(dir, 'device.dpapi'), 'device-key')
  writeFileSync(join(dir, 'logs', 'main.log'), 'log')
  return { id, dir }
}
function sqliteFile(file: string, body: string): void {
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE memos (body TEXT)')
  db.prepare('INSERT INTO memos (body) VALUES (?)').run(body)
  db.close()
}
const memoOf = (file: string): string => {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    return (db.prepare('SELECT body FROM memos').get() as { body: string }).body
  } finally {
    db.close()
  }
}

describe('shared PC: a removed person is kept for 30 days and can be put back', () => {
  it('removal is two steps: the PIN is checked without removing, the entry is dropped afterwards', () => {
    const x = fresh()
    const { id } = withKim(x)
    expect(x.reg.authRemove(id, '111222', 'owner').ok).toBe(false)
    expect(x.reg.get(id)).not.toBeNull()
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    expect(auth.ok).toBe(true)
    expect(auth.record).toMatchObject({ id, name: '김주무', owner: false })
    expect(auth.record!.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(x.reg.get(id)).not.toBeNull() // still registered
    // the PC 책임자 is never removed, with or without the two steps
    const owner = x.reg.list().find((s) => s.owner)!
    expect(x.reg.authRemove(owner.id, OWNER, 'owner').ok).toBe(false)
    expect(x.reg.drop(owner.id)).toBe(false)
    expect(x.reg.drop(id)).toBe(true)
    expect(x.reg.get(id)).toBeNull()
    expect(x.reg.drop(id)).toBe(false)
  })

  it('hold moves the folder into the holding area with the record; restore brings folder, name and PIN back', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    sqliteFile(join(dir, 'local.db'), '김주무의 메모')
    const auth = x.reg.authRemove(id, KIM, 'self')
    const held = await x.held.hold({ record: auth.record!, by: 'self', seatDir: dir })
    expect(held).toMatchObject({ ok: true, copiedData: false })
    expect(x.reg.drop(id)).toBe(true)

    expect(existsSync(dir)).toBe(false)
    const kept = join(x.base, REMOVED_DIR, id)
    expect(readFileSync(join(kept, 'seat', 'device.dpapi'), 'utf8')).toBe('device-key')
    expect(memoOf(join(kept, 'seat', 'local.db'))).toBe('김주무의 메모')
    // nothing readable of the PIN in the record, only the salted hash that was in the registry
    const raw = readFileSync(join(kept, 'meta.json'), 'utf8')
    expect(raw).not.toContain(KIM)
    expect(x.held.list()).toEqual([expect.objectContaining({ id, name: '김주무', removedAt: x.clock.t, daysLeft: 30 })])
    expect(x.held.list()[0].bytes).toBeGreaterThan(0)
    expect(x.reg.verify(id, KIM).ok).toBe(false) // gone from the sign-in list

    // restore needs the PC 책임자's PIN
    x.clock.t += 3 * DAY
    expect(x.held.list()[0].daysLeft).toBe(27)
    const meta = x.held.meta(id)!
    expect(x.reg.restore('999999', meta.record).ok).toBe(false)
    expect(x.reg.get(id)).toBeNull()
    expect(x.held.restoreProblem(id, dir)).toBeNull()
    const back = x.reg.restore(OWNER, meta.record)
    expect(back).toMatchObject({ ok: true, name: '김주무' })
    x.held.restoreFiles(id, dir, ENTRIES)
    expect(readFileSync(join(dir, 'device.dpapi'), 'utf8')).toBe('device-key')
    expect(memoOf(join(dir, 'local.db'))).toBe('김주무의 메모')
    expect(existsSync(kept)).toBe(false)
    expect(x.held.list()).toEqual([])
    // the old PIN works again, and wrong tries before the removal are forgotten
    expect(x.reg.verify(id, KIM).ok).toBe(true)
    expect(x.reg.get(id)).toMatchObject({ name: '김주무', owner: false, waitMs: 0 })
  })

  it('personal data kept in another folder is copied in first and comes back inside the seat folder', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const outside = join(x.base, 'elsewhere', 'kim data') // (ASCII: rmSync of Node 24.13 on Windows crashes on other letters; Electron's Node does not)
    mkdirSync(join(outside, 'plugins', 'p1'), { recursive: true })
    mkdirSync(join(outside, 'backups'), { recursive: true })
    sqliteFile(join(outside, 'local.db'), '다른 폴더의 메모')
    writeFileSync(join(outside, 'plugins', 'p1', 'main.js'), '// plugin')
    writeFileSync(join(outside, 'backups', 'state.json'), '{}')
    writeFileSync(join(outside, 'keep-me.txt'), 'not ours')
    writeFileSync(join(dir, 'storage.json'), JSON.stringify({ localDir: outside, last: { ok: true, message: 'moved', at: 1 } }))
    // an older DB still lying in the seat folder is not what the person uses
    sqliteFile(join(dir, 'local.db'), '예전 메모')

    const auth = x.reg.authRemove(id, OWNER, 'owner')
    const held = await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir, data: { dir: outside, entries: ENTRIES } })
    expect(held).toMatchObject({ ok: true, copiedData: true })
    // the originals are removed by the caller only now
    expect(existsSync(join(outside, 'local.db'))).toBe(true)
    expect(removeOutsideData(outside, ENTRIES)).toEqual([])
    expect(readdirSync(outside)).toEqual(['keep-me.txt'])
    x.reg.drop(id)
    const kept = join(x.base, REMOVED_DIR, id)
    expect(memoOf(join(kept, 'data', 'local.db'))).toBe('다른 폴더의 메모')
    expect(x.held.meta(id)!.dataFrom).toBe(outside)

    expect(x.reg.restore(OWNER, x.held.meta(id)!.record).ok).toBe(true)
    x.held.restoreFiles(id, dir, ENTRIES)
    expect(memoOf(join(dir, 'local.db'))).toBe('다른 폴더의 메모')
    expect(readFileSync(join(dir, 'plugins', 'p1', 'main.js'), 'utf8')).toBe('// plugin')
    expect(existsSync(join(dir, 'backups', 'state.json'))).toBe(true)
    // the pointer to the other folder is gone (the data is in the seat folder now), the older DB was set aside
    const storage = JSON.parse(readFileSync(join(dir, 'storage.json'), 'utf8')) as { localDir?: string; last?: unknown }
    expect(storage.localDir).toBeUndefined()
    expect(storage.last).toBeDefined()
    const aside = readdirSync(dir).find((n) => n.startsWith('replaced-'))!
    expect(memoOf(join(dir, aside, 'local.db'))).toBe('예전 메모')
  })

  it('when the backup cannot be made nothing is removed', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const outside = join(x.base, 'elsewhere')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'local.db'), 'this is not a database, so the consistent copy fails')
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    const held = await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir, data: { dir: outside, entries: ENTRIES } })
    expect(held.ok).toBe(false)
    expect(held.error).toBeTruthy()
    expect(readFileSync(join(dir, 'device.dpapi'), 'utf8')).toBe('device-key')
    expect(existsSync(join(outside, 'local.db'))).toBe(true)
    expect(existsSync(join(x.base, REMOVED_DIR, id))).toBe(false)
    expect(x.reg.get(id)).not.toBeNull()
    expect(x.held.list()).toEqual([])
  })

  it('a folder that cannot be renamed (another drive, a file held open) is copied, compared and then removed', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const noRename = (): void => {
      throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' })
    }
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    const held = await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir, rename: noRename })
    expect(held).toMatchObject({ ok: true })
    expect(held.warning).toBeUndefined()
    expect(existsSync(dir)).toBe(false)
    expect(readFileSync(join(x.base, REMOVED_DIR, id, 'seat', 'logs', 'main.log'), 'utf8')).toBe('log')

    // moveDir never writes over something that is there
    const a = join(x.base, 'a')
    const b = join(x.base, 'b')
    mkdirSync(a)
    mkdirSync(b)
    writeFileSync(join(a, 'f'), '1')
    expect(() => moveDir(a, b)).toThrow()
    expect(existsSync(join(a, 'f'))).toBe(true)
  })

  it('undoing a hold puts the folder back (the registry entry could not be dropped)', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    expect((await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })).ok).toBe(true)
    x.held.unhold(id, dir)
    expect(readFileSync(join(dir, 'device.dpapi'), 'utf8')).toBe('device-key')
    expect(existsSync(join(x.base, REMOVED_DIR, id))).toBe(false)
  })

  it('a restore never overwrites an existing seat, and a taken name gets a mark', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })
    x.reg.drop(id)
    const meta = x.held.meta(id)!

    // somebody made a folder with that id meanwhile
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'device.dpapi'), 'somebody else')
    expect(x.held.restoreProblem(id, dir)).toMatch(/이미 있어/)
    expect(() => x.held.restoreFiles(id, dir, ENTRIES)).toThrow()
    expect(readFileSync(join(dir, 'device.dpapi'), 'utf8')).toBe('somebody else')
    expect(x.held.list()).toHaveLength(1) // the backup is intact
    rmSync(dir, { recursive: true })

    // a new 김주무 was added: the restored one is told apart, and keeps the old PIN
    const other = x.reg.add(OWNER, '김주무', '3141').id!
    const back = x.reg.restore(OWNER, meta.record)
    expect(back).toMatchObject({ ok: true, name: '김주무 (복구)' })
    x.held.restoreFiles(id, dir, ENTRIES)
    expect(x.reg.verify(id, KIM).ok).toBe(true)
    expect(x.reg.verify(other, '3141').ok).toBe(true)
    // registered twice is refused
    expect(x.reg.restore(OWNER, meta.record)).toMatchObject({ ok: false })
    expect(x.reg.restoreProblem(meta.record)).toMatch(/이미 등록/)
  })

  it('restored names stay distinct and within the length limit', () => {
    expect(restoredSeatName('김주무', ['홍길동'])).toBe('김주무')
    expect(restoredSeatName('김주무', ['홍길동', '김주무'])).toBe('김주무 (복구)')
    expect(restoredSeatName('Kim', ['kim', 'KIM (복구)'])).toBe('Kim (복구 2)')
    const long = '가'.repeat(SEAT_NAME_MAX)
    const n = restoredSeatName(long, [long])
    expect(n.length).toBeLessThanOrEqual(SEAT_NAME_MAX)
    expect(n.endsWith('(복구)')).toBe(true)
  })

  it('restore is refused while the mode is off and when the PC is full', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })
    x.reg.drop(id)
    const meta = x.held.meta(id)!
    // turning the mode off keeps the backup; it is listed, but cannot be restored until the mode is on again
    expect(x.reg.disable(OWNER).ok).toBe(true)
    expect(x.held.list()).toHaveLength(1)
    expect(x.reg.restore(OWNER, meta.record)).toMatchObject({ ok: false })
    expect(x.reg.verifyOwner(OWNER).ok).toBe(false)
    expect(x.reg.ids()).toEqual([])
    // on again (a new PC 책임자 PIN): restorable
    expect(x.reg.enable('홍길동', '9182').ok).toBe(true)
    for (let i = 0; i < 9; i++) expect(x.reg.add('9182', `사람${i}`, KIM).ok).toBe(true)
    expect(x.reg.restore('9182', meta.record).error).toMatch(/10명까지/)
    const one = x.reg.list().find((s) => s.name === '사람0')!
    x.reg.remove(one.id, '9182', 'owner')
    expect(x.reg.restore('9182', meta.record).ok).toBe(true)
  })

  it('ids and paths are checked: nothing outside the holding area is ever named', () => {
    const x = fresh()
    for (const bad of ['..', '../users', 'a/b', 'ABCDEFABCDEF', 'abcdefabcde', '', 'abcdefabcdef/..', 'C:\\Windows']) {
      expect(() => x.held.dirOf(bad)).toThrow()
      expect(x.held.meta(bad)).toBeNull()
      expect(x.held.purge(bad).ok).toBe(false)
    }
    expect(x.held.dirOf('abcdefabcdef')).toBe(join(x.base, REMOVED_DIR, 'abcdefabcdef'))
  })

  it('the record of a backup is validated before anybody is put back', () => {
    const id = 'abcdefabcdef'
    const rec: SeatRecord = { id, name: '김주무', owner: false, salt: 'ab'.repeat(16), hash: 'cd'.repeat(32), createdAt: 1, lastUsedAt: 2, fails: 4, lockUntil: 99 }
    const good = { version: 1, id, name: '김주무', removedAt: 1000, by: 'owner', record: rec, dataFrom: null }
    expect(parseRemovedMeta(good, id)).toMatchObject({ id, name: '김주무', removedAt: 1000, record: { fails: 0, lockUntil: 0, owner: false } })
    expect(parseRemovedMeta(good, 'ffffffffffff')).toBeNull() // not this folder's
    expect(parseRemovedMeta({ ...good, record: { ...rec, owner: true } }, id)).toBeNull() // nobody becomes PC 책임자 by a restore
    expect(parseRemovedMeta({ ...good, record: { ...rec, id: 'ffffffffffff' } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, hash: 'not-hex' } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, salt: '' } }, id)).toBeNull()
    // a person without a PIN comes back without one: said by null in both fields, and by nothing else
    expect(parseRemovedMeta({ ...good, record: { ...rec, salt: null, hash: null } }, id)).toMatchObject({ record: { salt: null, hash: null } })
    expect(parseRemovedMeta({ ...good, record: { ...rec, hash: null } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, salt: null } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, hash: '' } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, salt: undefined, hash: undefined } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, name: '   ' } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, record: { ...rec, name: 'x'.repeat(SEAT_NAME_MAX + 1) } }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, removedAt: 'yesterday' }, id)).toBeNull()
    expect(parseRemovedMeta({ ...good, version: 2 }, id)).toBeNull()
    expect(parseRemovedMeta(null, id)).toBeNull()
    expect(parseRemovedMeta('{}', id)).toBeNull()
  })

  it('after 30 days the backup is erased for good; until then the days left are shown', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const t0 = x.clock.t
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })
    x.reg.drop(id)
    const seatDirOf = (i: string): string => x.reg.dirOf({ id: i, owner: false })

    expect(removedDaysLeft(t0, t0)).toBe(30)
    expect(removedDaysLeft(t0, t0 + DAY + 1)).toBe(29)
    expect(removedDaysLeft(t0, t0 + REMOVED_KEEP_MS - 1)).toBe(1)
    expect(removedDaysLeft(t0, t0 + REMOVED_KEEP_MS)).toBe(0)

    x.clock.t = t0 + REMOVED_KEEP_MS - 1000
    expect(x.held.cleanup(x.reg.ids(), seatDirOf)).toEqual([])
    expect(x.held.list()).toHaveLength(1)

    x.clock.t = t0 + REMOVED_KEEP_MS
    expect(x.held.list()).toEqual([]) // not offered any more
    expect(x.held.restoreProblem(id, dir)).toMatch(/30일/)
    expect(x.held.cleanup(x.reg.ids(), seatDirOf)).toEqual([id])
    expect(existsSync(join(x.base, REMOVED_DIR))).toBe(false) // the empty holding area goes too
    expect(x.held.meta(id)).toBeNull()
  })

  it('cleanup undoes a removal that was cut short and removes old leftovers, nothing else', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const seatDirOf = (i: string): string => x.reg.dirOf({ id: i, owner: false })
    // the folder was moved, then the program stopped before the registry entry was dropped
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })
    expect(existsSync(dir)).toBe(false)
    expect(x.held.list(x.reg.ids()!)).toEqual([]) // a registered person is never listed as removed
    // a leftover that is no backup: young (kept) and old (removed)
    const young = join(x.base, REMOVED_DIR, 'abcdefabcdef.old-1')
    const old = join(x.base, REMOVED_DIR, 'stray')
    mkdirSync(young)
    mkdirSync(old)
    const past = new Date(x.clock.t - REMOVED_KEEP_MS - DAY)
    utimesSync(old, past, past)
    utimesSync(young, new Date(x.clock.t), new Date(x.clock.t))

    expect(x.held.cleanup(x.reg.ids(), seatDirOf)).toEqual([])
    expect(readFileSync(join(dir, 'device.dpapi'), 'utf8')).toBe('device-key')
    expect(existsSync(join(x.base, REMOVED_DIR, id))).toBe(false)
    expect(existsSync(young)).toBe(true)
    expect(existsSync(old)).toBe(false)
    expect(x.reg.verify(id, KIM).ok).toBe(true)
  })

  it('완전히 지우기 erases one backup at once', async () => {
    const x = fresh()
    const { id, dir } = withKim(x)
    const auth = x.reg.authRemove(id, OWNER, 'owner')
    await x.held.hold({ record: auth.record!, by: 'owner', seatDir: dir })
    x.reg.drop(id)
    expect(x.reg.verifyOwner('000111').ok).toBe(false)
    expect(x.reg.verifyOwner(OWNER).ok).toBe(true)
    expect(x.held.purge(id)).toEqual({ ok: true })
    expect(existsSync(join(x.base, REMOVED_DIR, id))).toBe(false)
    expect(x.held.purge(id).ok).toBe(false)
    expect(x.held.list()).toEqual([])
  })
})
