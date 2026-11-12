import type { Db } from '../../node/sqlite'
import { newId, parseJson } from '../../node/sqlite'
import type { DiaryEntryDto, DiarySummaryDto } from '../../shared/schemas/personal'

interface Row {
  id: string
  date: string
  body_html: string
  body_text: string
  tags: string
  updated_at: number
}

export function htmlToPlain(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d|\/tr)[^>]*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Private diary, one entry per day, stored only on this PC (6.5). */
export class DiaryRepo {
  constructor(private readonly db: Db) {}

  get(date: string): DiaryEntryDto | null {
    const r = this.db.get<Row>('SELECT * FROM diary_entries WHERE date = ?', [date])
    return r ? { id: r.id, date: r.date, bodyHtml: r.body_html, tags: parseJson<string[]>(r.tags, []), updatedAt: r.updated_at } : null
  }

  save(date: string, bodyHtml: string, tags: string[]): DiaryEntryDto | null {
    const text = htmlToPlain(bodyHtml)
    if (!text && !tags.length && !/<img/i.test(bodyHtml)) {
      this.db.run('DELETE FROM diary_entries WHERE date = ?', [date])
      return null
    }
    const t = Date.now()
    this.db.run(
      `INSERT INTO diary_entries (id, date, body_html, body_text, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET body_html = excluded.body_html, body_text = excluded.body_text, tags = excluded.tags, updated_at = excluded.updated_at`,
      [newId(), date, bodyHtml, text, JSON.stringify(tags), t, t]
    )
    return this.get(date)
  }

  delete(date: string): void {
    this.db.run('DELETE FROM diary_entries WHERE date = ?', [date])
  }

  /** Entries of a month ("2026-11") for the calendar dots and list. */
  month(ym: string): DiarySummaryDto[] {
    return this.db
      .all<Row>(`SELECT * FROM diary_entries WHERE date LIKE ? ORDER BY date DESC`, [`${ym}-%`])
      .map((r) => ({ date: r.date, snippet: r.body_text.slice(0, 80), tags: parseJson<string[]>(r.tags, []) }))
  }

  search(q: string): DiarySummaryDto[] {
    const like = `%${q.trim()}%`
    return this.db
      .all<Row>(`SELECT * FROM diary_entries WHERE body_text LIKE ? OR tags LIKE ? ORDER BY date DESC LIMIT 100`, [like, like])
      .map((r) => ({ date: r.date, snippet: r.body_text.slice(0, 80), tags: parseJson<string[]>(r.tags, []) }))
  }

  range(from: string, to: string): DiaryEntryDto[] {
    return this.db
      .all<Row>('SELECT * FROM diary_entries WHERE date >= ? AND date <= ? ORDER BY date', [from, to])
      .map((r) => ({ id: r.id, date: r.date, bodyHtml: r.body_html, tags: parseJson<string[]>(r.tags, []), updatedAt: r.updated_at }))
  }
}
