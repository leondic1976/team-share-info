import type { Db } from '../../node/sqlite'
import { newId } from '../../node/sqlite'
import type { PersonalTaskDto, PersonalTaskInput } from '../../shared/schemas/personal'

interface Row {
  id: string
  title: string
  note: string
  due_at: number | null
  priority: 'low' | 'normal' | 'high'
  done_at: number | null
  sort: number
  created_at: number
  updated_at: number
}

const toDto = (r: Row): PersonalTaskDto => ({
  id: r.id,
  title: r.title,
  note: r.note,
  dueAt: r.due_at,
  priority: r.priority,
  doneAt: r.done_at,
  sort: r.sort,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** Personal to-dos stored only on this PC (6.8, 2.3). */
export class PersonalTasksRepo {
  constructor(private readonly db: Db) {}

  list(includeDone = true): PersonalTaskDto[] {
    return this.db
      .all<Row>(`SELECT * FROM personal_tasks ${includeDone ? '' : 'WHERE done_at IS NULL'} ORDER BY done_at IS NOT NULL, due_at IS NULL, due_at, sort, created_at`)
      .map(toDto)
  }

  save(i: PersonalTaskInput): string {
    const t = Date.now()
    if (i.id && this.db.get('SELECT 1 FROM personal_tasks WHERE id = ?', [i.id])) {
      this.db.run('UPDATE personal_tasks SET title = ?, note = ?, due_at = ?, priority = ?, updated_at = ? WHERE id = ?', [i.title, i.note ?? '', i.dueAt ?? null, i.priority ?? 'normal', t, i.id])
      return i.id
    }
    const id = newId()
    this.db.run('INSERT INTO personal_tasks (id, title, note, due_at, priority, sort, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, ?, ?)', [id, i.title, i.note ?? '', i.dueAt ?? null, i.priority ?? 'normal', t, t])
    return id
  }

  setDone(id: string, done: boolean): void {
    this.db.run('UPDATE personal_tasks SET done_at = ?, updated_at = ? WHERE id = ?', [done ? Date.now() : null, Date.now(), id])
  }

  delete(id: string): void {
    this.db.run('DELETE FROM personal_tasks WHERE id = ?', [id])
  }

  /** Open tasks with a due date in [from, to) — for reminders and the calendar. */
  due(from: number, to: number): PersonalTaskDto[] {
    return this.db.all<Row>('SELECT * FROM personal_tasks WHERE done_at IS NULL AND due_at >= ? AND due_at < ?', [from, to]).map(toDto)
  }
}
