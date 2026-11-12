import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import type { LauncherInput, LauncherItemDto, LauncherKind } from '../../shared/schemas/launcher'
import type { SecurityItem, SecurityRunDto } from '../../shared/schemas/sysutil'

interface Row {
  id: string
  kind: LauncherKind
  name: string
  target: string
  args: string
  group_name: string
  sort: number
  detected: number
  hidden: number
}

const dto = (r: Row): LauncherItemDto => ({ id: r.id, kind: r.kind, name: r.name, target: r.target, args: r.args, groupName: r.group_name, sort: r.sort, detected: !!r.detected, hidden: !!r.hidden })

/** Personal launcher items, recent documents and security check results (local only). */
export class LauncherRepo {
  constructor(private readonly db: Db) {}

  list(includeHidden = false): LauncherItemDto[] {
    return this.db.all<Row>(`SELECT * FROM launcher_personal ${includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY group_name, sort, name`).map(dto)
  }
  get(id: string): LauncherItemDto | null {
    const r = this.db.get<Row>('SELECT * FROM launcher_personal WHERE id = ?', [id])
    return r ? dto(r) : null
  }
  save(i: LauncherInput): string {
    if (i.id && this.db.get('SELECT 1 FROM launcher_personal WHERE id = ?', [i.id])) {
      this.db.run('UPDATE launcher_personal SET kind = ?, name = ?, target = ?, args = ?, group_name = ?, hidden = 0 WHERE id = ?', [i.kind, i.name, i.target, i.args ?? '', i.groupName ?? '', i.id])
      return i.id
    }
    const existing = this.db.get<{ id: string }>('SELECT id FROM launcher_personal WHERE kind = ? AND target = ?', [i.kind, i.target])
    if (existing) {
      this.db.run('UPDATE launcher_personal SET name = ?, args = ?, group_name = ?, hidden = 0 WHERE id = ?', [i.name, i.args ?? '', i.groupName ?? '', existing.id])
      return existing.id
    }
    const id = newId()
    const sort = this.db.get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM launcher_personal WHERE group_name = ?', [i.groupName ?? ''])?.m ?? 0
    this.db.run('INSERT INTO launcher_personal (id, kind, name, target, args, group_name, sort, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [id, i.kind, i.name, i.target, i.args ?? '', i.groupName ?? '', sort, Date.now()])
    return id
  }
  /** Detected programs are added once; items the user removed stay hidden. Returns how many were new. */
  addDetected(items: { name: string; path: string; group: string }[]): number {
    let n = 0
    for (const d of items) {
      if (this.db.get('SELECT 1 FROM launcher_personal WHERE kind = ? AND lower(target) = lower(?)', ['app', d.path])) continue
      const id = this.save({ kind: 'app', name: d.name, target: d.path, groupName: d.group })
      this.db.run('UPDATE launcher_personal SET detected = 1 WHERE id = ?', [id])
      n++
    }
    return n
  }
  /** Detected items are hidden instead of deleted so that the next scan does not re-add them. */
  remove(id: string): void {
    const r = this.db.get<Row>('SELECT * FROM launcher_personal WHERE id = ?', [id])
    if (!r) return
    if (r.detected) this.db.run('UPDATE launcher_personal SET hidden = 1 WHERE id = ?', [id])
    else this.db.run('DELETE FROM launcher_personal WHERE id = ?', [id])
  }
  /** Reorder within a group: ids in their new order. */
  reorder(ids: string[]): void {
    this.db.tx(() => ids.forEach((id, i) => this.db.run('UPDATE launcher_personal SET sort = ? WHERE id = ?', [i, id])))
  }

  // recent documents opened from TeamHub, plus pins
  touchRecent(path: string): void {
    this.db.run('INSERT INTO recent_docs (path, opened_at) VALUES (?, ?) ON CONFLICT(path) DO UPDATE SET opened_at = excluded.opened_at', [path, Date.now()])
    this.db.run('DELETE FROM recent_docs WHERE pinned = 0 AND path NOT IN (SELECT path FROM recent_docs WHERE pinned = 0 ORDER BY opened_at DESC LIMIT 100)')
  }
  recent(): { path: string; openedAt: number; pinned: boolean }[] {
    return this.db.all<{ path: string; opened_at: number; pinned: number }>('SELECT * FROM recent_docs ORDER BY pinned DESC, opened_at DESC').map((r) => ({ path: r.path, openedAt: r.opened_at, pinned: !!r.pinned }))
  }
  pinRecent(path: string, pinned: boolean): void {
    this.db.run('INSERT INTO recent_docs (path, opened_at, pinned) VALUES (?, ?, ?) ON CONFLICT(path) DO UPDATE SET pinned = excluded.pinned', [path, Date.now(), pinned ? 1 : 0])
  }
  forgetRecent(path: string): void {
    this.db.run('DELETE FROM recent_docs WHERE path = ?', [path])
  }

  // security check history (never sent anywhere)
  saveSecurity(items: SecurityItem[]): SecurityRunDto {
    const run = { id: newId(), runAt: Date.now(), items }
    this.db.run('INSERT INTO security_results (id, run_at, items) VALUES (?, ?, ?)', [run.id, run.runAt, JSON.stringify(items)])
    this.db.run('DELETE FROM security_results WHERE id NOT IN (SELECT id FROM security_results ORDER BY run_at DESC LIMIT 24)')
    return run
  }
  securityHistory(): SecurityRunDto[] {
    return this.db.all<{ id: string; run_at: number; items: string }>('SELECT * FROM security_results ORDER BY run_at DESC').map((r) => ({ id: r.id, runAt: r.run_at, items: parseJson<SecurityItem[]>(r.items, []) }))
  }
}
