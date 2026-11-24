import { z } from 'zod'
import { handle } from './registry'
import { SEAT_ID_RE, SEAT_IDLE_MAX, SEAT_IDLE_MIN } from '../../node/seats'
import { lockModeChanged, seatPinChanged, seatUnlocked } from '../applock'
import { getMode, readCredential } from '../connection'
import { lockedRole } from '../pcid'
import {
  activeSeat,
  addSeat,
  changeSeatPin,
  disableShared,
  enableShared,
  logoutWarning,
  recoverOwnerPin,
  purgeRemovedSeat,
  removedSeats,
  removeSeat,
  removeSeatPin,
  restoreSeat,
  resetSeatPin,
  seatState,
  sessionStarted,
  setSeatIdle,
  signIn,
  stayLoggedIn,
  switchUser
} from '../seats'

// an empty PIN is a valid request: "no PIN" where one is made, "nothing to check" where one is asked.
// What is accepted is decided by the registry (node/seats.ts), never here.
const pin = z.string().max(20)
const id = z.string().regex(SEAT_ID_RE)
const name = z.string().max(60)

/**
 * A member PC that is connected to a server. Asked only inside a session: before somebody is
 * signed in nothing that is kept per person (PC identity, device key, local DB) may be read.
 */
function allowed(): boolean {
  if (!sessionStarted()) return false
  try {
    return lockedRole() !== 'server' && getMode() === 'client' && !!readCredential()
  } catch {
    return false
  }
}

/** IPC of the shared PC mode. Registered at start, before anybody is signed in: the sign-in window uses it. */
export function registerSeatIpc(): void {
  handle('seat:state', null, () => seatState(allowed()))
  handle('seat:signIn', z.object({ id, pin }), (r) => signIn(r.id, r.pin))

  handle('seat:enable', z.object({ name, pin }), (r) => {
    if (!sessionStarted()) return { ok: false, error: '공용 PC 사용은 설정에서 켭니다.' }
    if (!allowed()) return { ok: false, error: '서버에 연결된 일반용(팀원) PC에서만 켤 수 있습니다. 서버용 PC는 여러 명이 함께 쓸 수 없습니다.' }
    const res = enableShared(r.name, r.pin)
    if (res.ok) lockModeChanged()
    return res
  })
  handle('seat:disable', z.object({ ownerPin: pin }), (r) => {
    if (!sessionStarted()) return { ok: false, error: '공용 PC 사용은 로그인한 뒤 설정에서 끕니다.' }
    const res = disableShared(r.ownerPin)
    if (res.ok) lockModeChanged()
    return res
  })
  handle('seat:add', z.object({ ownerPin: pin, name, pin }), (r) => addSeat(r.ownerPin, r.name, r.pin))
  handle('seat:remove', z.object({ id, pin, by: z.enum(['self', 'owner']) }), (r) => removeSeat(r.id, r.pin, r.by))
  // kept backups of removed people: listed and handled inside a session only (설정 → 사용자 관리)
  handle('seat:removed', null, () => (sessionStarted() ? removedSeats() : []))
  handle('seat:restore', z.object({ ownerPin: pin, id }), (r) => (sessionStarted() ? restoreSeat(r.ownerPin, r.id) : { ok: false, error: '지운 사용자 복구는 로그인한 뒤 설정에서 합니다.' }))
  handle('seat:purge', z.object({ ownerPin: pin, id }), (r) => (sessionStarted() ? purgeRemovedSeat(r.ownerPin, r.id) : { ok: false, error: '로그인한 뒤 설정에서 합니다.' }))
  handle('seat:resetPin', z.object({ ownerPin: pin, id, newPin: pin }), (r) => {
    const res = resetSeatPin(r.ownerPin, r.id, r.newPin)
    // (also used from the sign-in window, where no lock state exists yet)
    if (res.ok && sessionStarted()) seatPinChanged()
    return res
  })
  handle('seat:changePin', z.object({ oldPin: pin, newPin: pin }), (r) => {
    const res = changeSeatPin(r.oldPin, r.newPin)
    if (res.ok) seatPinChanged()
    return res
  })
  handle('seat:removePin', z.object({ pin }), (r) => {
    const res = removeSeatPin(r.pin)
    if (res.ok) seatPinChanged()
    return res
  })
  handle('seat:recover', z.object({ code: z.string().max(20), newPin: pin }), (r) => {
    const res = recoverOwnerPin(r.code, r.newPin)
    // the PC 책임자 at the lock screen: the new PIN was just set by the person at the keyboard
    if (res.ok && activeSeat()?.owner) seatUnlocked()
    return res
  })
  handle('seat:setIdle', z.object({ ownerPin: pin, minutes: z.number().int().min(SEAT_IDLE_MIN).max(SEAT_IDLE_MAX) }), (r) => setSeatIdle(r.ownerPin, r.minutes))
  handle('seat:switch', null, () => {
    if (sessionStarted() && activeSeat()) setTimeout(() => switchUser(), 200)
  })
  handle('seat:logoutWarning', null, () => logoutWarning())
  handle('seat:stay', null, () => stayLoggedIn())
}
