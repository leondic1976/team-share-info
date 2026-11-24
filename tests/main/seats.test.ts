import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeatRegistry, seatHasPin, seatPinProblem, SEAT_ID_RE, type SeatsFile } from '../../src/node/seats'
import { newPinProblem, sealPin, waitAfter } from '../../src/node/pin'

const dirs: string[] = []
function fresh(): { dir: string; reg: SeatRegistry; clock: { t: number } } {
  const dir = mkdtempSync(join(tmpdir(), 'teamhub-seats-'))
  dirs.push(dir)
  const clock = { t: 1_800_000_000_000 }
  return { dir, reg: new SeatRegistry(dir, () => clock.t), clock }
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const OWNER = '2749'
const KIM = '8051'
const WRONG = '9999'
const fileOf = (dir: string): SeatsFile => JSON.parse(readFileSync(join(dir, 'seats.json'), 'utf8')) as SeatsFile

describe('shared PC: the registry of people (seats)', () => {
  it('is off until somebody turns it on; that person is the PC 책임자 and keeps the base folder', () => {
    const { dir, reg } = fresh()
    expect(reg.enabled()).toBe(false)
    expect(reg.list()).toEqual([])
    expect(reg.verify('abcdefabcdef', OWNER).ok).toBe(false)

    const on = reg.enable('  홍 길동 ', OWNER)
    expect(on.ok).toBe(true)
    expect(on.recovery).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(reg.enabled()).toBe(true)
    const [owner] = reg.list()
    expect(owner).toMatchObject({ name: '홍 길동', owner: true, hasPin: true, waitMs: 0 })
    expect(owner.id).toMatch(SEAT_ID_RE)
    expect(reg.dirOf(owner)).toBe(dir)
    expect(reg.enable('또', OWNER).ok).toBe(false) // not twice

    // nothing readable is stored: neither the PIN nor the recovery code
    const raw = readFileSync(join(dir, 'seats.json'), 'utf8')
    expect(raw).not.toContain(`"${OWNER}"`)
    expect(raw).not.toContain(on.recovery!)
    expect(raw).not.toContain(on.recovery!.replace('-', ''))
  })

  it('PIN rule for every new PIN: exactly four digits, not one repeated digit, not a straight run', () => {
    expect(seatPinProblem).toBe(newPinProblem) // one rule for the program lock and the shared PC
    for (const bad of ['', '123', '12345', '274913', '12a4', ' 274', '2749 ']) expect(seatPinProblem(bad)).toMatch(/숫자 4자리/)
    for (const same of ['0000', '1111', '9999']) expect(seatPinProblem(same)).toMatch(/같은 숫자/)
    for (const run of ['0123', '1234', '6789', '9876', '3210']) expect(seatPinProblem(run)).toMatch(/이어지는 숫자/)
    // only that handful is refused: 24 of the 10,000
    let refused = 0
    for (let i = 0; i < 10000; i++) if (seatPinProblem(String(i).padStart(4, '0'))) refused++
    expect(refused).toBe(24)
    for (const ok of [OWNER, KIM, '1357', '2580', '1122', '1235']) expect(seatPinProblem(ok)).toBeNull()

    const { reg } = fresh()
    expect(reg.enable('홍길동', '1234').ok).toBe(false)
    expect(reg.enable('홍길동', '274913').ok).toBe(false) // the old length is not made any more
    expect(reg.enabled()).toBe(false)
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.add(OWNER, '이주무', '660174').ok).toBe(false)
    expect(reg.changePin(kim, KIM, '314159').ok).toBe(false)
    expect(reg.resetPin(OWNER, kim, '314159').ok).toBe(false)
    expect(reg.resetPin(OWNER, kim, '1111').ok).toBe(false)
    expect(reg.verify(kim, KIM).ok).toBe(true) // nothing was changed by the refused tries
  })

  it('PINs made before the 4-digit rule (6 to 12 digits) keep working until they are changed', () => {
    const { dir, reg } = fresh()
    const on = reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    // the registry as an earlier version wrote it: long PINs for both
    const f = fileOf(dir)
    Object.assign(f.seats.find((s) => s.owner)!, sealPin('274913'))
    Object.assign(f.seats.find((s) => s.id === kim)!, sealPin('805162803317'))
    writeFileSync(join(dir, 'seats.json'), JSON.stringify(f))
    const owner = reg.list().find((s) => s.owner)!.id

    expect(reg.verify(owner, '274913').ok).toBe(true)
    expect(reg.verify(kim, '805162803317').ok).toBe(true)
    expect(reg.verify(owner, '2749').ok).toBe(false) // not a prefix of it
    expect(reg.verify(kim, '8051').ok).toBe(false)
    // the old PIN still authorises: management, removal by oneself, the recovery code
    expect(reg.setIdleMinutes('274913', 7).ok).toBe(true)
    expect(reg.add('274913', '이주무', '6601').ok).toBe(true)
    expect(reg.authRemove(kim, '805162803317', 'self').ok).toBe(true)
    // changing it: the old one is accepted as it is, the new one follows the rule
    expect(reg.changePin(kim, '805162803317', '805162').ok).toBe(false)
    expect(reg.changePin(kim, '805162803317', KIM).ok).toBe(true)
    expect(reg.verify(kim, '805162803317').ok).toBe(false)
    expect(reg.verify(kim, KIM).ok).toBe(true)
    expect(reg.recoverOwner(on.recovery!, '6022').ok).toBe(true)
    expect(reg.verify(owner, '274913').ok).toBe(false)
    expect(reg.verify(owner, '6022').ok).toBe(true)
  })

  it('adding a person needs the PC 책임자 PIN; each person has an own folder and an own PIN', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    expect(reg.add(KIM, '김주무', KIM)).toMatchObject({ ok: false }) // not with just any PIN
    expect(reg.add('', '김주무', KIM)).toMatchObject({ ok: false }) // not without it
    expect(reg.add(OWNER, '홍길동', KIM).ok).toBe(false) // same name
    expect(reg.add(OWNER, ' 홍길동 ', KIM).ok).toBe(false)
    expect(reg.add(OWNER, '', KIM).ok).toBe(false)
    expect(reg.add(OWNER, '김주무', '1111').ok).toBe(false) // weak PIN
    const added = reg.add(OWNER, '김주무', KIM)
    expect(added.ok).toBe(true)
    const kim = reg.get(added.id!)!
    expect(kim).toMatchObject({ name: '김주무', owner: false, hasPin: true })
    expect(reg.dirOf(kim)).toBe(join(dir, 'users', kim.id))
    expect(() => reg.dirOf({ id: '..\\..\\x', owner: false })).toThrow()

    const owner = reg.list().find((s) => s.owner)!
    expect(reg.verify(kim.id, KIM).ok).toBe(true)
    expect(reg.verify(kim.id, OWNER).ok).toBe(false) // the owner's PIN does not open somebody else's seat
    expect(reg.verify(owner.id, KIM).ok).toBe(false)
    expect(reg.verify(owner.id, OWNER).ok).toBe(true)
    // an unknown person gets the same answer as a wrong PIN
    expect(reg.verify('000000000000', KIM)).toEqual({ ok: false, error: 'PIN이 맞지 않습니다.' })
  })

  it('a person may use no PIN: the name alone signs them in, and the registry says so explicitly', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    const lee = reg.add(OWNER, '이주무', '').id!
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.get(lee)).toMatchObject({ name: '이주무', hasPin: false })
    expect(reg.get(kim)).toMatchObject({ hasPin: true })
    // "no PIN" is null in both fields - not an empty string, not a hash of ""
    const rec = fileOf(dir).seats.find((s) => s.id === lee)!
    expect(rec.salt).toBeNull()
    expect(rec.hash).toBeNull()
    expect(seatHasPin(rec)).toBe(false)

    expect(reg.verify(lee, '').ok).toBe(true)
    // removing oneself needs nothing either
    expect(reg.authRemove(lee, '', 'self').ok).toBe(true)
  })

  it('a person who has a PIN is never opened by an empty or missing one, and an empty try is not counted', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    const owner = reg.list()[0].id
    const kim = reg.add(OWNER, '김주무', KIM).id!
    for (const none of ['', undefined, null] as unknown as string[]) {
      expect(reg.verify(kim, none)).toMatchObject({ ok: false, error: 'PIN을 입력하세요.' })
      expect(reg.verify(owner, none).ok).toBe(false)
      expect(reg.authRemove(kim, none, 'self').ok).toBe(false)
      expect(reg.authRemove(kim, none, 'owner').ok).toBe(false)
      expect(reg.add(none, '이주무', '').ok).toBe(false)
      expect(reg.resetPin(none, kim, '').ok).toBe(false)
      expect(reg.changePin(kim, none, '3141').ok).toBe(false)
      expect(reg.removePin(kim, none).ok).toBe(false)
      expect(reg.setIdleMinutes(none, 5).ok).toBe(false)
      expect(reg.verifyOwner(none).ok).toBe(false)
      expect(reg.disable(none).ok).toBe(false)
    }
    // many empty tries later nobody waits, and the PINs are what they were
    expect(reg.get(kim)!.waitMs).toBe(0)
    expect(reg.get(owner)!.waitMs).toBe(0)
    expect(reg.verify(kim, KIM).ok).toBe(true)
    expect(reg.verify(owner, OWNER).ok).toBe(true)

    // a record somebody damaged is not "no PIN": nothing opens it
    for (const broken of [{ hash: '' }, { hash: null }, { salt: null }, { salt: '', hash: '' }, { salt: undefined, hash: undefined }]) {
      const f = fileOf(dir)
      Object.assign(f.seats.find((s) => s.id === kim)!, sealPin(KIM), broken, { fails: 0, lockUntil: 0 })
      writeFileSync(join(dir, 'seats.json'), JSON.stringify(f))
      expect(reg.get(kim)!.hasPin).toBe(true)
      for (const tryPin of ['', KIM, '0']) expect(reg.verify(kim, tryPin).ok).toBe(false)
    }
  })

  it('a person makes, changes and removes their own PIN; removing needs the current one', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const lee = reg.add(OWNER, '이주무', '').id!
    // without a PIN there is none to remove, and making one needs nothing
    expect(reg.removePin(lee, '').ok).toBe(false)
    expect(reg.changePin(lee, '', '1234').ok).toBe(false) // the rule applies
    expect(reg.get(lee)!.hasPin).toBe(false)
    const made = reg.changePin(lee, '', '6601')
    expect(made).toMatchObject({ ok: true })
    expect(made.recovery).toBeUndefined() // only the PC 책임자 has a recovery code
    expect(reg.get(lee)!.hasPin).toBe(true)
    expect(reg.verify(lee, '').ok).toBe(false)
    expect(reg.verify(lee, '6601').ok).toBe(true)
    // changing: the old one
    expect(reg.changePin(lee, OWNER, '3141').ok).toBe(false)
    expect(reg.changePin(lee, '', '3141').ok).toBe(false)
    expect(reg.changePin(lee, '6601', '2222').ok).toBe(false)
    expect(reg.changePin(lee, '6601', '3141').ok).toBe(true)
    expect(reg.verify(lee, '3141').ok).toBe(true)
    // removing: the current one, nobody else's
    expect(reg.removePin(lee, '').ok).toBe(false)
    expect(reg.removePin(lee, OWNER).ok).toBe(false)
    expect(reg.removePin(lee, '6601').ok).toBe(false)
    expect(reg.get(lee)!.hasPin).toBe(true)
    expect(reg.removePin(lee, '3141').ok).toBe(true)
    expect(reg.get(lee)).toMatchObject({ hasPin: false, waitMs: 0 })
    expect(reg.verify(lee, '').ok).toBe(true)
  })

  it('a PC 책임자 without a PIN: management asks for nothing, and there is no recovery code until a PIN is made', () => {
    const { dir, reg } = fresh()
    const on = reg.enable('홍길동', '')
    expect(on.ok).toBe(true)
    expect(on.recovery).toBeUndefined()
    const owner = reg.list()[0]
    expect(owner).toMatchObject({ owner: true, hasPin: false })
    expect(fileOf(dir)).toMatchObject({ recoverySalt: null, recoveryHash: null })
    expect(reg.verify(owner.id, '').ok).toBe(true)

    // every management action works without a PIN
    const kim = reg.add('', '김주무', KIM).id!
    const lee = reg.add('', '이주무', '').id!
    expect(reg.verifyOwner('').ok).toBe(true)
    expect(reg.setIdleMinutes('', 5).ok).toBe(true)
    expect(reg.resetPin('', kim, '3141').ok).toBe(true)
    expect(reg.verify(kim, '3141').ok).toBe(true)
    expect(reg.resetPin('', kim, '').ok).toBe(true) // reset to "no PIN"
    expect(reg.get(kim)!.hasPin).toBe(false)
    const gone = reg.authRemove(lee, '', 'owner')
    expect(gone.ok).toBe(true)
    expect(reg.drop(lee)).toBe(true)
    expect(reg.restore('', gone.record!).ok).toBe(true)
    expect(reg.remove(lee, '', 'owner').ok).toBe(true)
    // nothing to recover
    expect(reg.recoverOwner('AAAA-BBBB', '6022')).toMatchObject({ ok: false, error: expect.stringContaining('복구 코드가 없습니다') })
    expect(reg.recoverOwner('', '6022').ok).toBe(false)
    expect(reg.get(owner.id)!.hasPin).toBe(false)

    // the PC 책임자 makes a PIN: from then on it is asked, and a recovery code exists
    const made = reg.changePin(owner.id, '', OWNER)
    expect(made.recovery).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    expect(reg.add('', '박주무', '').ok).toBe(false)
    expect(reg.add(WRONG, '박주무', '').ok).toBe(false)
    expect(reg.add(OWNER, '박주무', '').ok).toBe(true)
    expect(reg.changePin(owner.id, OWNER, '6022').recovery).toBeUndefined() // a change keeps the code
    const rec = reg.recoverOwner(made.recovery!, '2718')
    expect(rec.ok).toBe(true)
    expect(reg.verify(owner.id, '2718').ok).toBe(true)

    // and removes it again: the code goes with it
    expect(reg.removePin(owner.id, WRONG).ok).toBe(false)
    expect(reg.removePin(owner.id, '2718').ok).toBe(true)
    expect(fileOf(dir)).toMatchObject({ recoverySalt: null, recoveryHash: null })
    expect(reg.recoverOwner(rec.recovery!, '6022').ok).toBe(false)
    expect(reg.setIdleMinutes('', 9).ok).toBe(true)
    expect(reg.remove(kim, '', 'owner').ok).toBe(true)
    expect(reg.remove(reg.list().find((s) => s.name === '박주무')!.id, '', 'owner').ok).toBe(true)
    expect(reg.disable('').ok).toBe(true)
    expect(reg.enabled()).toBe(false)
  })

  it('a removed person is put back with the PIN state they had: with their PIN, or without one', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    const lee = reg.add(OWNER, '이주무', '').id!
    const a = reg.authRemove(kim, OWNER, 'owner')
    const b = reg.authRemove(lee, OWNER, 'owner')
    expect(b.record).toMatchObject({ salt: null, hash: null })
    reg.drop(kim)
    reg.drop(lee)
    expect(reg.verify(lee, '').ok).toBe(false) // gone: not "no PIN"
    expect(reg.restore('', a.record!).ok).toBe(false)
    expect(reg.restore(OWNER, a.record!).ok).toBe(true)
    expect(reg.restore(OWNER, b.record!).ok).toBe(true)
    expect(reg.get(kim)).toMatchObject({ hasPin: true })
    expect(reg.verify(kim, '').ok).toBe(false)
    expect(reg.verify(kim, KIM).ok).toBe(true)
    expect(reg.get(lee)).toMatchObject({ hasPin: false })
    expect(reg.verify(lee, '').ok).toBe(true)
  })

  it('wrong tries: five are free, then a growing wait that survives a restart; the right PIN is refused while waiting', () => {
    const { dir, reg, clock } = fresh()
    reg.enable('홍길동', OWNER)
    const id = reg.list()[0].id
    for (let i = 1; i <= 4; i++) {
      const r = reg.verify(id, WRONG)
      expect(r.ok).toBe(false)
      expect(r.waitMs).toBeUndefined()
      expect(r.error).toContain('PIN이 맞지 않습니다')
      expect(r.error).toContain(`${5 - i}번 더`)
    }
    expect(reg.verify(id, WRONG).waitMs).toBe(30_000)
    // a new process (restart of the program) still has to wait
    const again = new SeatRegistry(dir, () => clock.t)
    expect(again.get(id)!.waitMs).toBe(30_000)
    const blocked = again.verify(id, OWNER)
    expect(blocked.ok).toBe(false)
    expect(blocked.waitMs).toBe(30_000)
    expect(again.verify(id, '').waitMs).toBe(30_000) // an empty try does not get around the wait
    clock.t += 30_001
    expect(again.verify(id, WRONG).waitMs).toBe(60_000) // and longer each time
    clock.t += 60_001
    expect(again.verify(id, OWNER).ok).toBe(true)
    expect(again.get(id)!.waitMs).toBe(0)
    expect(again.verify(id, WRONG).waitMs).toBeUndefined() // the count starts over
    expect(waitAfter(4)).toBe(0)
    expect(waitAfter(30)).toBe(600_000)
  })

  it('guessing all 10,000 PINs is not practical: after the free tries each wrong one costs up to 10 minutes', () => {
    const { reg, clock } = fresh()
    reg.enable('홍길동', OWNER)
    const id = reg.list()[0].id
    const start = clock.t
    let tries = 0
    // somebody who waits out every pause and tries again at once, for four hours
    while (clock.t - start < 4 * 3600_000) {
      const r = reg.verify(id, WRONG)
      tries++
      clock.t += (r.waitMs ?? 0) + 1
    }
    expect(tries).toBeLessThan(40) // from the tenth wrong try on: one try per 10 minutes, 144 a day of 10,000
    // every way of trying a PIN counts on the same counter, and the right PIN waits too
    expect(reg.setIdleMinutes(WRONG, 5).waitMs).toBe(600_000)
    const kim = reg.add(OWNER, '김주무', KIM)
    expect(kim.ok).toBe(false)
    expect(kim.waitMs).toBeGreaterThan(0)
  })

  it('a wrong PC 책임자 PIN counts against the PC 책임자, not against the person being managed', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    for (let i = 0; i < 5; i++) expect(reg.resetPin(WRONG, kim, '3141').ok).toBe(false)
    expect(reg.get(kim)!.waitMs).toBe(0)
    expect(reg.list().find((s) => s.owner)!.waitMs).toBe(30_000)
    expect(reg.verify(kim, KIM).ok).toBe(true) // 김주무 is not kept out by somebody guessing the owner's PIN
  })

  it("forgotten PIN: the PC 책임자 resets another person's; the owner's own needs the recovery code, which is replaced", () => {
    const { reg } = fresh()
    const on = reg.enable('홍길동', OWNER)
    const owner = reg.list()[0].id
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.resetPin(KIM, kim, '3141').ok).toBe(false)
    expect(reg.resetPin(OWNER, kim, '3141').ok).toBe(true)
    expect(reg.verify(kim, KIM).ok).toBe(false)
    expect(reg.verify(kim, '3141').ok).toBe(true)
    expect(reg.resetPin(OWNER, owner, '3141').ok).toBe(false) // not the owner's own this way

    expect(reg.recoverOwner('AAAA-BBBB', '6022').ok).toBe(false)
    expect(reg.recoverOwner(on.recovery!, '602214').ok).toBe(false) // the new PIN follows the rule
    const rec = reg.recoverOwner(on.recovery!.toLowerCase(), '6022')
    expect(rec.ok).toBe(true)
    expect(rec.recovery).not.toBe(on.recovery)
    expect(reg.verify(owner, OWNER).ok).toBe(false)
    expect(reg.verify(owner, '6022').ok).toBe(true)
    expect(reg.recoverOwner(on.recovery!, '2718').ok).toBe(false) // the old code is used up
    expect(reg.recoverOwner(rec.recovery!, '2718').ok).toBe(true)
  })

  it('a person changes their own PIN with the old one', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.changePin(kim, OWNER, '3141').ok).toBe(false)
    expect(reg.changePin(kim, KIM, '2222').ok).toBe(false)
    expect(reg.changePin(kim, KIM, '3141').ok).toBe(true)
    expect(reg.verify(kim, '3141').ok).toBe(true)
  })

  it("removing: own PIN or the PC 책임자's; never the PC 책임자; turning off only when one person is left", () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    const owner = reg.list()[0].id
    const kim = reg.add(OWNER, '김주무', KIM).id!
    const lee = reg.add(OWNER, '이주무', '6601').id!
    expect(reg.remove(owner, OWNER, 'owner').ok).toBe(false)
    expect(reg.remove(kim, '6601', 'self').ok).toBe(false) // 이주무's PIN does not remove 김주무
    expect(reg.remove(kim, KIM, 'owner').ok).toBe(false)
    expect(reg.disable(OWNER).ok).toBe(false) // people are left
    expect(reg.remove(kim, KIM, 'self').ok).toBe(true)
    expect(reg.remove(lee, OWNER, 'owner').ok).toBe(true)
    expect(reg.list().map((s) => s.name)).toEqual(['홍길동'])
    expect(reg.disable(WRONG).ok).toBe(false)
    expect(reg.disable(OWNER).ok).toBe(true)
    expect(reg.enabled()).toBe(false)
    expect(existsSync(join(dir, 'seats.json'))).toBe(false)
  })

  it('automatic logout time: 3 to 60 minutes, set by the PC 책임자; 10 by default; the stored key is unchanged', () => {
    const { dir, reg } = fresh()
    expect(reg.idleMinutes()).toBe(10)
    reg.enable('홍길동', OWNER)
    expect(reg.setIdleMinutes(OWNER, 2)).toMatchObject({ ok: false, error: expect.stringContaining('자동 로그아웃 시간') })
    expect(reg.setIdleMinutes(OWNER, 61).ok).toBe(false)
    expect(reg.setIdleMinutes(WRONG, 5).ok).toBe(false)
    expect(reg.setIdleMinutes(OWNER, 5).ok).toBe(true)
    expect(reg.idleMinutes()).toBe(5)
    // what was the lock time of an earlier version is the logout time now
    expect(fileOf(dir).idleMinutes).toBe(5)
  })

  it('a damaged list does not open the PC: the copy is used, and without it the mode stays on with nobody listed', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    const id = reg.list()[0].id
    writeFileSync(join(dir, 'seats.json'), '{ cut off')
    expect(reg.damaged()).toBe(false) // the copy of the last good state
    expect(reg.verify(id, OWNER).ok).toBe(true)
    writeFileSync(join(dir, 'seats.json'), '{ cut off')
    writeFileSync(join(dir, 'seats.json.bak'), '')
    expect(reg.damaged()).toBe(true)
    expect(reg.enabled()).toBe(true)
    expect(reg.list()).toEqual([])
    expect(reg.verify(id, OWNER).ok).toBe(false)
    expect(reg.verify(id, '').ok).toBe(false)
    expect(reg.enable('다른사람', KIM).ok).toBe(false)
  })

  it('at most ten people on one PC', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    for (let i = 1; i <= 9; i++) expect(reg.add(OWNER, `사용자${i}`, i % 2 ? KIM : '').ok).toBe(true)
    expect(reg.add(OWNER, '사용자10', KIM).ok).toBe(false)
  })
})
