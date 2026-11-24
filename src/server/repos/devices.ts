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
  pc_uid: string | null
  shared_pc: number
}

export function createDevice(
  db: Db,
  input: { memberId: string; pcName: string; winUser: string; ip: string; appVersion?: string | null; approvedBy?: string | null; pcUid?: string | null; sharedPc?: boolean }
): { deviceId: string; deviceKey: string } {
  const id = newId()
  const key = randomKey()
  const t = Date.now()
  db.run(
    `INSERT INTO devices (id, member_id, key_hash, pc_name, win_user, approved_ip, last_ip, app_version, approved_at, approved_by, created_at, updated_at, pc_uid, shared_pc)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.memberId, sha256Hex(key), input.pcName, input.winUser, input.ip, input.ip, input.appVersion ?? null, t, input.approvedBy ?? null, t, t, input.pcUid ?? null, input.sharedPc ? 1 : 0]
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

/** The device entry of the server PC itself (made at setup); '' on a database that has none. */
export function serverDeviceId(db: Db): string {
  const row = db.get<{ value: string }>(`SELECT value FROM settings WHERE key = 'serverDeviceId'`)
  try {
    return row ? String(JSON.parse(row.value)) : ''
  } catch {
    return ''
  }
}

/**
 * The account of the server PC itself: the 최종관리자. Every other member with role 'admin'
 * is a 서무. '' on a database without a server device.
 */
export function ownerMemberId(db: Db): string {
  const id = serverDeviceId(db)
  if (!id) return ''
  return db.get<{ member_id: string }>('SELECT member_id FROM devices WHERE id = ?', [id])?.member_id ?? ''
}

/**
 * Run when the server starts. Databases set up before the server device was recorded learn it
 * (the newest device approved on the server PC itself), and the server PC's account is kept an
 * active admin: nothing an earlier version allowed may leave the server without its 최종관리자.
 */
export function ensureServerOwner(db: Db): void {
  let id = serverDeviceId(db)
  if (!id || !getDevice(db, id)) {
    const found = db.get<{ id: string }>(
      `SELECT id FROM devices WHERE approved_ip = '127.0.0.1' AND approved_by IS NULL
       ORDER BY revoked_at IS NOT NULL, approved_at DESC, rowid DESC LIMIT 1`
    )
    if (!found) return
    id = found.id
    db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES ('serverDeviceId', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [JSON.stringify(id), Date.now()]
    )
  }
  db.run(`UPDATE members SET role = 'admin', status = 'active', updated_at = ? WHERE id = ? AND (role <> 'admin' OR status <> 'active')`, [Date.now(), ownerMemberId(db)])
}

export interface PcMatch {
  /** The account this PC gets back: the one of its newest approval. */
  member: { id: string; name: string }
  /** Every device entry that is this PC, newest first. */
  devices: { id: string; member_id: string; revoked_at: number | null }[]
}

/**
 * What the server already knows about a PC that asks for access.
 * A PC is recognised by its unique value. Devices approved by versions without unique values
 * have none: those are recognised by PC name + Windows account, which is what made one PC
 * show up as several people after it asked again (server set up anew, connection reset).
 * The server PC's own entry is never matched.
 *
 * 공용 PC (several people on one PC under one Windows account, each with an own unique value):
 * PC name + Windows account are the same for all of them, so they say nothing about who is
 * asking. A request marked as shared is recognised by its unique value only, and a device
 * marked as shared is never matched by PC name + Windows account. Otherwise the second person
 * would be given the first person's account and the first person's PC entry would be cut off.
 */
export function findPc(db: Db, pc: { pcUid?: string | null; pcName: string; winUser: string; sharedPc?: boolean }): PcMatch | null {
  const rows = db.all<{ id: string; member_id: string; revoked_at: number | null; name: string; by_uid: number }>(
    `SELECT d.id, d.member_id, d.revoked_at, m.name, (d.pc_uid IS NOT NULL) AS by_uid
     FROM devices d JOIN members m ON m.id = d.member_id
     WHERE d.id <> ?
       AND ((? IS NOT NULL AND d.pc_uid = ?) OR (? = 0 AND d.shared_pc = 0 AND d.pc_uid IS NULL AND lower(d.pc_name) = lower(?) AND lower(d.win_user) = lower(?)))
     ORDER BY by_uid DESC, d.approved_at DESC, d.rowid DESC`,
    [serverDeviceId(db), pc.pcUid ?? null, pc.pcUid ?? null, pc.sharedPc ? 1 : 0, pc.pcName, pc.winUser]
  )
  if (!rows.length) return null
  return { member: { id: rows[0].member_id, name: rows[0].name }, devices: rows.map((r) => ({ id: r.id, member_id: r.member_id, revoked_at: r.revoked_at })) }
}

export interface PcKey {
  pcUid?: string | null
  pcName: string
  winUser: string
}

/**
 * Is this PC shut out for good? Matched by the unique value, and also by PC name + Windows
 * account: a new installation gives the PC a new unique value, which must not be a way back in.
 */
export function blockedPc(db: Db, pc: PcKey): { id: string; reason: string } | null {
  return (
    db.get<{ id: string; reason: string }>(
      `SELECT id, reason FROM blocked_pcs
       WHERE (? IS NOT NULL AND pc_uid = ?) OR (lower(pc_name) = lower(?) AND lower(win_user) = lower(?)) LIMIT 1`,
      [pc.pcUid ?? null, pc.pcUid ?? null, pc.pcName, pc.winUser]
    ) ?? null
  )
}

/** Every device entry of a PC (by unique value or by PC name + Windows account), the server PC's own excluded. */
export function devicesOfPc(db: Db, pc: PcKey): { id: string; revoked_at: number | null }[] {
  return db.all<{ id: string; revoked_at: number | null }>(
    `SELECT id, revoked_at FROM devices
     WHERE id <> ? AND ((? IS NOT NULL AND pc_uid = ?) OR (lower(pc_name) = lower(?) AND lower(win_user) = lower(?)))`,
    [serverDeviceId(db), pc.pcUid ?? null, pc.pcUid ?? null, pc.pcName, pc.winUser]
  )
}

/** Devices approved before PCs had a unique value learn it from the PC itself. */
export function learnPcUid(db: Db, id: string, pcUid: string): void {
  db.run('UPDATE devices SET pc_uid = ?, updated_at = ? WHERE id = ? AND pc_uid IS NULL', [pcUid, Date.now(), id])
}

export function setDeviceRevoked(db: Db, id: string, revoked: boolean): void {
  db.run('UPDATE devices SET revoked_at = ?, updated_at = ? WHERE id = ?', [revoked ? Date.now() : null, Date.now(), id])
}
