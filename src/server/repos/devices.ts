import type { Db } from '../../node/sqlite'
import { newId } from '../../node/sqlite'
import { randomKey, sha256Hex } from '../crypto'

export interface DeviceRow {
  id: string
  member_id: string
  key_hash: string
  pc_name: string
  win_user: string
  approved_ip: string
  last_ip: string | null
  app_version: string | null
  approved_at: number
  approved_by: string | null
  revoked_at: number | null
  last_seen_at: number | null
}

export function createDevice(
  db: Db,
  input: { memberId: string; pcName: string; winUser: string; ip: string; appVersion?: string | null; approvedBy?: string | null }
): { deviceId: string; deviceKey: string } {
  const id = newId()
  const key = randomKey()
  const t = Date.now()
  db.run(
    `INSERT INTO devices (id, member_id, key_hash, pc_name, win_user, approved_ip, last_ip, app_version, approved_at, approved_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.memberId, sha256Hex(key), input.pcName, input.winUser, input.ip, input.ip, input.appVersion ?? null, t, input.approvedBy ?? null, t, t]
  )
  return { deviceId: id, deviceKey: key }
}

export function getDevice(db: Db, id: string): DeviceRow | undefined {
  return db.get<DeviceRow>('SELECT * FROM devices WHERE id = ?', [id])
}

export function touchDevice(db: Db, id: string, ip: string, appVersion?: string): void {
  db.run('UPDATE devices SET last_ip = ?, last_seen_at = ?, app_version = COALESCE(?, app_version) WHERE id = ?', [
    ip,
    Date.now(),
    appVersion ?? null,
    id
  ])
}

export function listDevices(db: Db): (DeviceRow & { member_name: string })[] {
  return db.all<DeviceRow & { member_name: string }>(
    `SELECT d.*, m.name AS member_name FROM devices d JOIN members m ON m.id = d.member_id ORDER BY d.revoked_at IS NOT NULL, m.name`
  )
}

export function setDeviceRevoked(db: Db, id: string, revoked: boolean): void {
  db.run('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?', [revoked ? Date.now() : null, Date.now(), id])
}
