import { z } from 'zod'
import { handle } from './registry'
import { SEAT_ID_RE, SEAT_IDLE_MAX, SEAT_IDLE_MIN } from '../../node/seats'
import { lockModeChanged, seatUnlocked } from '../applock'
import { getMode, readCredential } from '../connection'
import { lockedRole } from '../pcid'
import {
  activeSeat,
  addSeat,
  changeSeatPin,
  disableShared,
  enableShared,
  recoverOwnerPin,
  removeSeat,
  resetSeatPin,
  seatState,
  sessionStarted,
  setSeatIdle,
  signIn,
  switchUser
} from '../seats'

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
  handle('seat:resetPin', z.object({ ownerPin: pin, id, newPin: pin }), (r) => resetSeatPin(r.ownerPin, r.id, r.newPin))
  handle('seat:changePin', z.object({ oldPin: pin, newPin: pin }), (r) => changeSeatPin(r.oldPin, r.newPin))
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
}
