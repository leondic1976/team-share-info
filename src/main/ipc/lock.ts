import { z } from 'zod'
import { changePin, createPin, lockNow, lockState, recoverPin, removePin, startAppLock, unlock } from '../applock'
import { handle } from './registry'

const pin = z.string().max(8)

export function registerLockIpc(): void {
  handle('lock:state', null, () => lockState())
  handle('lock:create', z.object({ pin }), (r) => createPin(r.pin))
  handle('lock:unlock', z.object({ pin }), (r) => unlock(r.pin))
  handle('lock:change', z.object({ oldPin: pin, newPin: pin }), (r) => changePin(r.oldPin, r.newPin))
  handle('lock:recover', z.object({ code: z.string().max(20), newPin: pin }), (r) => recoverPin(r.code, r.newPin))
  handle('lock:remove', z.object({ pin }), (r) => removePin(r.pin))
  handle('lock:now', null, () => lockNow())
  startAppLock()
}
