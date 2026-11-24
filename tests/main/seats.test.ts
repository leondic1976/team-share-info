import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SeatRegistry, seatPinProblem, SEAT_ID_RE } from '../../src/node/seats'
import { waitAfter } from '../../src/node/pin'

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

const OWNER = '274913'
const KIM = '805162'

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
    expect(owner).toMatchObject({ name: '홍 길동', owner: true, waitMs: 0 })
    expect(owner.id).toMatch(SEAT_ID_RE)
    expect(reg.dirOf(owner)).toBe(dir)
    expect(reg.enable('또', OWNER).ok).toBe(false) // not twice

    // nothing readable is stored: neither the PIN nor the recovery code
    const raw = readFileSync(join(dir, 'seats.json'), 'utf8')
    expect(raw).not.toContain(OWNER)
    expect(raw).not.toContain(on.recovery!)
    expect(raw).not.toContain(on.recovery!.replace('-', ''))
  })

  it('PIN rules: digits, six or more, not one repeated digit, not a straight run', () => {
    expect(seatPinProblem('1234')).toBeTruthy()
    expect(seatPinProblem('12345a')).toBeTruthy()
    expect(seatPinProblem('000000')).toBeTruthy()
    expect(seatPinProblem('123456')).toBeTruthy()
    expect(seatPinProblem('987654')).toBeTruthy()
    expect(seatPinProblem('1234567890123')).toBeTruthy()
    expect(seatPinProblem(OWNER)).toBeNull()
    const { reg } = fresh()
    expect(reg.enable('홍길동', '1234').ok).toBe(false)
    expect(reg.enabled()).toBe(false)
  })

  it('adding a person needs the PC 책임자 PIN; each person has an own folder and an own PIN', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    expect(reg.add(KIM, '김주무', KIM)).toMatchObject({ ok: false }) // not with just any PIN
    expect(reg.add(OWNER, '홍길동', KIM).ok).toBe(false) // same name
    expect(reg.add(OWNER, ' 홍길동 ', KIM).ok).toBe(false)
    expect(reg.add(OWNER, '', KIM).ok).toBe(false)
    expect(reg.add(OWNER, '김주무', '111111').ok).toBe(false) // weak PIN
    const added = reg.add(OWNER, '김주무', KIM)
    expect(added.ok).toBe(true)
    const kim = reg.get(added.id!)!
    expect(kim).toMatchObject({ name: '김주무', owner: false })
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

  it('wrong tries: five are free, then a growing wait that survives a restart; the right PIN is refused while waiting', () => {
    const { dir, reg, clock } = fresh()
    reg.enable('홍길동', OWNER)
    const id = reg.list()[0].id
    for (let i = 1; i <= 4; i++) {
      const r = reg.verify(id, '999999')
      expect(r.ok).toBe(false)
      expect(r.waitMs).toBeUndefined()
      expect(r.error).toContain('PIN이 맞지 않습니다')
    }
    expect(reg.verify(id, '999999').waitMs).toBe(30_000)
    // a new process (restart of the program) still has to wait
    const again = new SeatRegistry(dir, () => clock.t)
    expect(again.get(id)!.waitMs).toBe(30_000)
    const blocked = again.verify(id, OWNER)
    expect(blocked.ok).toBe(false)
    expect(blocked.waitMs).toBe(30_000)
    clock.t += 30_001
    expect(again.verify(id, '999999').waitMs).toBe(60_000) // and longer each time
    clock.t += 60_001
    expect(again.verify(id, OWNER).ok).toBe(true)
    expect(again.get(id)!.waitMs).toBe(0)
    expect(again.verify(id, '999999').waitMs).toBeUndefined() // the count starts over
    expect(waitAfter(4)).toBe(0)
    expect(waitAfter(30)).toBe(600_000)
  })

  it('a wrong PC 책임자 PIN counts against the PC 책임자, not against the person being managed', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    for (let i = 0; i < 5; i++) expect(reg.resetPin('999999', kim, '314159').ok).toBe(false)
    expect(reg.get(kim)!.waitMs).toBe(0)
    expect(reg.list().find((s) => s.owner)!.waitMs).toBe(30_000)
    expect(reg.verify(kim, KIM).ok).toBe(true) // 김주무 is not kept out by somebody guessing the owner's PIN
  })

  it('forgotten PIN: the PC 책임자 resets another person\'s; the owner\'s own needs the recovery code, which is replaced', () => {
    const { reg } = fresh()
    const on = reg.enable('홍길동', OWNER)
    const owner = reg.list()[0].id
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.resetPin(KIM, kim, '314159').ok).toBe(false)
    expect(reg.resetPin(OWNER, kim, '314159').ok).toBe(true)
    expect(reg.verify(kim, KIM).ok).toBe(false)
    expect(reg.verify(kim, '314159').ok).toBe(true)
    expect(reg.resetPin(OWNER, owner, '314159').ok).toBe(false) // not the owner's own this way

    expect(reg.recoverOwner('AAAA-BBBB', '602214').ok).toBe(false)
    const rec = reg.recoverOwner(on.recovery!.toLowerCase(), '602214')
    expect(rec.ok).toBe(true)
    expect(rec.recovery).not.toBe(on.recovery)
    expect(reg.verify(owner, OWNER).ok).toBe(false)
    expect(reg.verify(owner, '602214').ok).toBe(true)
    expect(reg.recoverOwner(on.recovery!, '271828').ok).toBe(false) // the old code is used up
    expect(reg.recoverOwner(rec.recovery!, '271828').ok).toBe(true)
  })

  it('a person changes their own PIN with the old one', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    const kim = reg.add(OWNER, '김주무', KIM).id!
    expect(reg.changePin(kim, OWNER, '314159').ok).toBe(false)
    expect(reg.changePin(kim, KIM, '222222').ok).toBe(false)
    expect(reg.changePin(kim, KIM, '314159').ok).toBe(true)
    expect(reg.verify(kim, '314159').ok).toBe(true)
  })

  it('removing: own PIN or the PC 책임자\'s; never the PC 책임자; turning off only when one person is left', () => {
    const { dir, reg } = fresh()
    reg.enable('홍길동', OWNER)
    const owner = reg.list()[0].id
    const kim = reg.add(OWNER, '김주무', KIM).id!
    const lee = reg.add(OWNER, '이주무', '660174').id!
    expect(reg.remove(owner, OWNER, 'owner').ok).toBe(false)
    expect(reg.remove(kim, '660174', 'self').ok).toBe(false) // 이주무's PIN does not remove 김주무
    expect(reg.remove(kim, KIM, 'owner').ok).toBe(false)
    expect(reg.disable(OWNER).ok).toBe(false) // people are left
    expect(reg.remove(kim, KIM, 'self').ok).toBe(true)
    expect(reg.remove(lee, OWNER, 'owner').ok).toBe(true)
    expect(reg.list().map((s) => s.name)).toEqual(['홍길동'])
    expect(reg.disable('999999').ok).toBe(false)
    expect(reg.disable(OWNER).ok).toBe(true)
    expect(reg.enabled()).toBe(false)
    expect(existsSync(join(dir, 'seats.json'))).toBe(false)
  })

  it('idle lock time: 3 to 60 minutes, set by the PC 책임자; 10 by default', () => {
    const { reg } = fresh()
    expect(reg.idleMinutes()).toBe(10)
    reg.enable('홍길동', OWNER)
    expect(reg.setIdleMinutes(OWNER, 2).ok).toBe(false)
    expect(reg.setIdleMinutes(OWNER, 61).ok).toBe(false)
    expect(reg.setIdleMinutes('999999', 5).ok).toBe(false)
    expect(reg.setIdleMinutes(OWNER, 5).ok).toBe(true)
    expect(reg.idleMinutes()).toBe(5)
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
    expect(reg.enable('다른사람', KIM).ok).toBe(false)
  })

  it('at most ten people on one PC', () => {
    const { reg } = fresh()
    reg.enable('홍길동', OWNER)
    for (let i = 1; i <= 9; i++) expect(reg.add(OWNER, `사용자${i}`, KIM).ok).toBe(true)
    expect(reg.add(OWNER, '사용자10', KIM).ok).toBe(false)
  })
})
