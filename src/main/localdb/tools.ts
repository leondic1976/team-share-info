import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import { nextAlarmTime, type AlarmDto, type AlarmInput, type ClipboardItemDto, type FavoriteDto, type MemoColor, type MemoDto, type MemoInput, type SnippetDto } from '../../shared/schemas/tools'

interface MemoRow {
  id: string
  body: string
  color: MemoColor
  pinned: number
  tags: string
  sticky: number
  x: number | null
  y: number | null
  w: number | null
  h: number | null
  always_on_top: number
  created_at: number
  updated_at: number
}

const memoDto = (r: MemoRow): MemoDto => ({
  id: r.id,
  body: r.body,
  color: r.color,
  pinned: !!r.pinned,
  tags: parseJson<string[]>(r.tags, []),
  sticky: !!r.sticky,
  bounds: r.x !== null && r.y !== null && r.w && r.h ? { x: r.x, y: r.y, w: r.w, h: r.h } : null,
  alwaysOnTop: !!r.always_on_top,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** Personal memos and sticky notes (6.12 ①), local only. */
export class MemosRepo {
  constructor(private readonly db: Db) {}
  list(q = ''): MemoDto[] {
    const like = `%${q.trim()}%`
    return this.db.all<MemoRow>(`SELECT * FROM memos ${q.trim() ? 'WHERE body LIKE ? OR tags LIKE ?' : ''} ORDER BY pinned DESC, updated_at DESC`, q.trim() ? [like, like] : []).map(memoDto)
  }
  get(id: string): MemoDto | null {
    const r = this.db.get<MemoRow>('SELECT * FROM memos WHERE id = ?', [id])
    return r ? memoDto(r) : null
  }
  save(i: MemoInput): string {
    const t = Date.now()
    if (i.id && this.db.get('SELECT 1 FROM memos WHERE id = ?', [i.id])) {
      this.db.run('UPDATE memos SET body = ?, color = ?, pinned = ?, tags = ?, updated_at = ? WHERE id = ?', [i.body, i.color ?? 'yellow', i.pinned ? 1 : 0, JSON.stringify(i.tags ?? []), t, i.id])
      return i.id
    }
    const id = i.id ?? newId()
    this.db.run('INSERT INTO memos (id, body, color, pinned, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, i.body, i.color ?? 'yellow', i.pinned ? 1 : 0, JSON.stringify(i.tags ?? []), t, t])
    return id
  }
  setSticky(id: string, sticky: boolean): void {
    this.db.run('UPDATE memos SET sticky = ?, updated_at = ? WHERE id = ?', [sticky ? 1 : 0, Date.now(), id])
  }
  setBounds(id: string, b: { x: number; y: number; w: number; h: number }): void {
    this.db.run('UPDATE memos SET x = ?, y = ?, w = ?, h = ? WHERE id = ?', [b.x, b.y, b.w, b.h, id])
  }
  setOnTop(id: string, v: boolean): void {
    this.db.run('UPDATE memos SET always_on_top = ? WHERE id = ?', [v ? 1 : 0, id])
  }
  delete(id: string): void {
    this.db.run('DELETE FROM memos WHERE id = ?', [id])
  }
  stickies(): MemoDto[] {
    return this.db.all<MemoRow>('SELECT * FROM memos WHERE sticky = 1').map(memoDto)
  }
}

interface AlarmRow {
  id: string
  title: string
  note: string
  kind: AlarmDto['kind']
  fire_at: number
  rrule: string | null
  lead_days: string
  enabled: number
  snooze_until: number | null
  last_fired_at: number | null
  sound: number
}

const alarmDto = (r: AlarmRow): AlarmDto => {
  const base = {
    id: r.id,
    title: r.title,
    note: r.note,
    kind: r.kind,
    fireAt: r.fire_at,
    rrule: r.rrule,
    leadDays: parseJson<number[]>(r.lead_days, []),
    enabled: !!r.enabled,
    snoozeUntil: r.snooze_until,
    lastFiredAt: r.last_fired_at,
    sound: !!r.sound
  }
  // An occurrence that already rang is not 'next'.
  return { ...base, next: nextAlarmTime(base, Math.max(Date.now(), (r.last_fired_at ?? 0) + 1)) }
}

/** Personal alarms (6.12 ②). */
export class AlarmsRepo {
  constructor(private readonly db: Db) {}
  list(): AlarmDto[] {
    return this.db.all<AlarmRow>('SELECT * FROM alarms ORDER BY enabled DESC, fire_at').map(alarmDto)
  }
  get(id: string): AlarmDto | null {
    const r = this.db.get<AlarmRow>('SELECT * FROM alarms WHERE id = ?', [id])
    return r ? alarmDto(r) : null
  }
  save(i: AlarmInput): string {
    const t = Date.now()
    const vals = [i.title, i.note ?? '', i.kind, i.fireAt, i.rrule ?? null, JSON.stringify(i.leadDays ?? []), i.enabled === false ? 0 : 1, i.sound === false ? 0 : 1]
    if (i.id && this.db.get('SELECT 1 FROM alarms WHERE id = ?', [i.id])) {
      this.db.run('UPDATE alarms SET title = ?, note = ?, kind = ?, fire_at = ?, rrule = ?, lead_days = ?, enabled = ?, sound = ?, snooze_until = NULL, updated_at = ? WHERE id = ?', [...vals, t, i.id])
      return i.id
    }
    const id = newId()
    this.db.run('INSERT INTO alarms (id, title, note, kind, fire_at, rrule, lead_days, enabled, sound, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, ...vals, t, t])
    return id
  }
  setEnabled(id: string, enabled: boolean): void {
    this.db.run('UPDATE alarms SET enabled = ?, snooze_until = NULL, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, Date.now(), id])
  }
  snooze(id: string, until: number): void {
    this.db.run('UPDATE alarms SET snooze_until = ?, updated_at = ? WHERE id = ?', [until, Date.now(), id])
  }
  /** After ringing: one-shot alarms switch off; snooze is consumed. */
  fired(id: string, at: number): void {
    const a = this.get(id)
    if (!a) return
    const oneShot = a.kind === 'once' || a.kind === 'timer' || (a.kind === 'deadline' && at >= a.fireAt)
    this.db.run('UPDATE alarms SET last_fired_at = ?, snooze_until = CASE WHEN snooze_until <= ? THEN NULL ELSE snooze_until END, enabled = CASE WHEN ? THEN 0 ELSE enabled END WHERE id = ?', [
      at,
      at,
      oneShot && !(a.snoozeUntil && a.snoozeUntil > at) ? 1 : 0,
      id
    ])
  }
  delete(id: string): void {
    this.db.run('DELETE FROM alarms WHERE id = ?', [id])
  }
  raw(): AlarmDto[] {
    return this.db.all<AlarmRow>('SELECT * FROM alarms').map(alarmDto)
  }
}

/** Snippets, clipboard history, favorites, focus sessions (6.12 ③). */
export class ToolsRepo {
  constructor(private readonly db: Db) {}

  snippets(): SnippetDto[] {
    return this.db
      .all<{ id: string; title: string; body: string; group_name: string; used_at: number | null }>('SELECT * FROM snippets ORDER BY group_name, sort, title')
      .map((r) => ({ id: r.id, title: r.title, body: r.body, groupName: r.group_name, usedAt: r.used_at }))
  }
  saveSnippet(i: { id?: string; title: string; body: string; groupName?: string }): string {
    const t = Date.now()
    if (i.id && this.db.get('SELECT 1 FROM snippets WHERE id = ?', [i.id])) {
      this.db.run('UPDATE snippets SET title = ?, body = ?, group_name = ?, updated_at = ? WHERE id = ?', [i.title, i.body, i.groupName ?? '', t, i.id])
      return i.id
    }
    const id = newId()
    this.db.run('INSERT INTO snippets (id, title, body, group_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [id, i.title, i.body, i.groupName ?? '', t, t])
    return id
  }
  useSnippet(id: string): void {
    this.db.run('UPDATE snippets SET used_at = ? WHERE id = ?', [Date.now(), id])
  }
  deleteSnippet(id: string): void {
    this.db.run('DELETE FROM snippets WHERE id = ?', [id])
  }

  clipboard(): ClipboardItemDto[] {
    return this.db.all<ClipboardItemDto>('SELECT id, kind, body, at FROM clipboard_items ORDER BY at DESC, rowid DESC LIMIT 100')
  }
  addClipboard(kind: 'text' | 'image', body: string): void {
    // Copying an older entry again moves it to the top.
    this.db.run('DELETE FROM clipboard_items WHERE body = ?', [body])
    this.db.run('INSERT INTO clipboard_items (id, kind, body, at) VALUES (?, ?, ?, ?)', [newId(), kind, body, Date.now()])
    this.db.run('DELETE FROM clipboard_items WHERE id NOT IN (SELECT id FROM clipboard_items ORDER BY at DESC, rowid DESC LIMIT 100)')
  }
  deleteClipboard(id: string | null): void {
    if (id) this.db.run('DELETE FROM clipboard_items WHERE id = ?', [id])
    else this.db.run('DELETE FROM clipboard_items')
  }

  favorites(): FavoriteDto[] {
    return this.db
      .all<{ id: string; item_type: string; item_id: string; title: string; route: string }>('SELECT * FROM favorites ORDER BY sort, created_at')
      .map((r) => ({ id: r.id, itemType: r.item_type, itemId: r.item_id, title: r.title, route: r.route }))
  }
  toggleFavorite(f: { itemType: string; itemId: string; title: string; route: string }): boolean {
    if (this.db.get('SELECT 1 FROM favorites WHERE item_type = ? AND item_id = ?', [f.itemType, f.itemId])) {
      this.db.run('DELETE FROM favorites WHERE item_type = ? AND item_id = ?', [f.itemType, f.itemId])
      return false
    }
    this.db.run('INSERT INTO favorites (id, item_type, item_id, title, route, created_at) VALUES (?, ?, ?, ?, ?, ?)', [newId(), f.itemType, f.itemId, f.title, f.route, Date.now()])
    return true
  }

  startFocus(minutes: number, kind: 'focus' | 'break'): string {
    const id = newId()
    this.db.run('INSERT INTO focus_sessions (id, started_at, minutes, kind) VALUES (?, ?, ?, ?)', [id, Date.now(), minutes, kind])
    return id
  }
  endFocus(id: string): void {
    this.db.run('UPDATE focus_sessions SET ended_at = ? WHERE id = ?', [Date.now(), id])
  }
  focusToday(): { sessions: number; minutes: number } {
    const d = new Date()
    const start = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const r = this.db.get<{ n: number; m: number }>(`SELECT COUNT(*) AS n, COALESCE(SUM(minutes), 0) AS m FROM focus_sessions WHERE kind = 'focus' AND started_at >= ? AND ended_at IS NOT NULL`, [start])
    return { sessions: r?.n ?? 0, minutes: r?.m ?? 0 }
  }
}
