import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import { expand, isEmptyRule, truncateRule } from '../../shared/recurrence'
import type { PersonalEventDto, PersonalEventInput, PersonalOccurrenceDto } from '../../shared/schemas/personal'

interface Row {
  id: string
  title: string
  body_html: string
  start_at: number
  end_at: number
  all_day: number
  rrule: string | null
  exdates: string
  location: string | null
  reminders: string
  busy_event_id: string | null
}

const toDto = (r: Row): PersonalEventDto => ({
  id: r.id,
  title: r.title,
  bodyHtml: r.body_html,
  startAt: r.start_at,
  endAt: r.end_at,
  allDay: !!r.all_day,
  rrule: r.rrule,
  exdates: parseJson<number[]>(r.exdates, []),
  location: r.location,
  reminders: parseJson<number[]>(r.reminders, []),
  busyEventId: r.busy_event_id
})

/** Personal calendar stored only in the local DB (2.3). */
export class PersonalEventsRepo {
  constructor(private readonly db: Db) {}

  get(id: string): PersonalEventDto | null {
    const r = this.db.get<Row>('SELECT * FROM personal_events WHERE id = ?', [id])
    return r ? toDto(r) : null
  }

  list(from: number, to: number): PersonalOccurrenceDto[] {
    const rows = this.db.all<Row>('SELECT * FROM personal_events WHERE start_at < ? AND (rrule IS NOT NULL OR end_at > ?)', [to, from])
    const out: PersonalOccurrenceDto[] = []
    for (const r of rows) {
      const d = toDto(r)
      for (const o of expand(d, from, to, 500)) {
        out.push({ id: d.id, key: o.key, start: o.start, end: o.end, allDay: d.allDay, title: d.title, location: d.location, recurring: !!d.rrule, reminders: d.reminders, busyEventId: d.busyEventId })
      }
    }
    return out.sort((a, b) => a.start - b.start)
  }

  private insert(i: Omit<PersonalEventInput, 'mode' | 'occurrenceStart'>, busyEventId: string | null = null): string {
    const id = newId()
    const t = Date.now()
    this.db.run(
      `INSERT INTO personal_events (id, title, body_html, start_at, end_at, all_day, rrule, exdates, location, reminders, busy_event_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?)`,
      [id, i.title, i.bodyHtml ?? '', i.startAt, i.endAt, i.allDay ? 1 : 0, i.rrule ?? null, i.location || null, JSON.stringify(i.reminders ?? []), busyEventId, t, t]
    )
    return id
  }

  /** Create or update; recurring edits support this / following / all (same rules as the server). */
  save(i: PersonalEventInput): string {
    if (!i.id) return this.insert(i)
    const cur = this.db.get<Row>('SELECT * FROM personal_events WHERE id = ?', [i.id])
    if (!cur) return this.insert(i)
    return this.db.tx(() => {
      if (i.mode === 'this' && cur.rrule && i.occurrenceStart !== undefined) {
        const ex = [...parseJson<number[]>(cur.exdates, []), i.occurrenceStart]
        this.db.run('UPDATE personal_events SET exdates = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ex), Date.now(), cur.id])
        return this.insert({ ...i, rrule: null })
      }
      if (i.mode === 'following' && cur.rrule && i.occurrenceStart !== undefined && i.occurrenceStart > cur.start_at) {
        this.db.run('UPDATE personal_events SET rrule = ?, updated_at = ? WHERE id = ?', [truncateRule(cur.rrule, i.occurrenceStart), Date.now(), cur.id])
        return this.insert(i)
      }
      this.db.run(
        `UPDATE personal_events SET title = ?, body_html = ?, start_at = ?, end_at = ?, all_day = ?, rrule = ?, location = ?, reminders = ?, updated_at = ? WHERE id = ?`,
        [i.title, i.bodyHtml ?? '', i.startAt, i.endAt, i.allDay ? 1 : 0, i.rrule ?? null, i.location || null, JSON.stringify(i.reminders ?? []), Date.now(), cur.id]
      )
      return cur.id
    })
  }

  setBusyLink(id: string, busyEventId: string | null): void {
    this.db.run('UPDATE personal_events SET busy_event_id = ?, updated_at = ? WHERE id = ?', [busyEventId, Date.now(), id])
  }

  delete(id: string, mode: 'all' | 'this' | 'following' = 'all', occurrence?: number): void {
    const cur = this.db.get<Row>('SELECT * FROM personal_events WHERE id = ?', [id])
    if (!cur) return
    if (mode === 'this' && cur.rrule && occurrence !== undefined) {
      const ex = [...parseJson<number[]>(cur.exdates, []), occurrence]
      this.db.run('UPDATE personal_events SET exdates = ?, updated_at = ? WHERE id = ?', [JSON.stringify(ex), Date.now(), id])
      return
    }
    if (mode === 'following' && cur.rrule && occurrence !== undefined && occurrence > cur.start_at) {
      const rule = truncateRule(cur.rrule, occurrence)
      if (!isEmptyRule({ ...toDto(cur), rrule: rule })) {
        this.db.run('UPDATE personal_events SET rrule = ?, updated_at = ? WHERE id = ?', [rule, Date.now(), id])
        return
      }
    }
    this.db.run('DELETE FROM personal_events WHERE id = ?', [id])
  }
}
