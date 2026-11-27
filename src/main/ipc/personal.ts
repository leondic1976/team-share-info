import { z } from 'zod'
import { handle } from './registry'
import { localDb } from '../localdb'
import { personalEventInputSchema } from '../../shared/schemas/personal'
import { setServerReminders, tick } from '../scheduler'

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/** IPC for personal data in the local DB (calendar, diary) and the reminder scheduler. */
export function registerPersonalIpc(): void {
  handle('local:events.list', z.object({ from: z.number(), to: z.number() }), ({ from, to }) => localDb().events.list(from, to))
  handle('local:events.get', z.object({ id: z.string() }), ({ id }) => localDb().events.get(id))
  handle('local:events.save', personalEventInputSchema, (i) => {
    const id = localDb().events.save(i)
    tick()
    return id
  })
  handle('local:events.setBusy', z.object({ id: z.string(), busyEventId: z.string().nullable() }), ({ id, busyEventId }) => localDb().events.setBusyLink(id, busyEventId))
  handle('local:events.setAbsence', z.object({ id: z.string(), absenceEventId: z.string().nullable() }), ({ id, absenceEventId }) => localDb().events.setAbsenceLink(id, absenceEventId))
  handle(
    'local:events.absenceChanged',
    z.object({ absenceEventId: z.string(), change: z.object({ startAt: z.number(), endAt: z.number(), allDay: z.boolean() }).nullable() }),
    ({ absenceEventId, change }) => {
      const n = localDb().events.absenceChanged(absenceEventId, change)
      if (n) tick()
      return n
    }
  )
  handle('local:events.delete', z.object({ id: z.string(), mode: z.enum(['all', 'this', 'following']).default('all'), occurrence: z.number().optional() }), ({ id, mode, occurrence }) =>
    localDb().events.delete(id, mode, occurrence)
  )

  handle('local:diary.get', z.object({ date: DATE }), ({ date }) => localDb().diary.get(date))
  handle('local:diary.save', z.object({ date: DATE, bodyHtml: z.string().max(5_000_000), tags: z.array(z.string().max(30)).max(20) }), ({ date, bodyHtml, tags }) =>
    localDb().diary.save(date, bodyHtml, tags)
  )
  handle('local:diary.delete', z.object({ date: DATE }), ({ date }) => localDb().diary.delete(date))
  handle('local:diary.month', z.object({ ym: z.string().regex(/^\d{4}-\d{2}$/) }), ({ ym }) => localDb().diary.month(ym))
  handle('local:diary.search', z.object({ q: z.string().min(1).max(100) }), ({ q }) => localDb().diary.search(q))
  handle('local:diary.range', z.object({ from: DATE, to: DATE }), ({ from, to }) => localDb().diary.range(from, to))

  // The personal to-do channels (local:tasks.*) were removed with the 할 일 screen; the
  // personal_tasks table and its repo stay so what was written is not lost.

  handle(
    'scheduler:setServerReminders',
    z.object({
      source: z.string().max(30),
      items: z.array(z.object({ key: z.string(), fireAt: z.number(), title: z.string().max(200), body: z.string().max(500), route: z.string().max(200).optional() })).max(2000)
    }),
    ({ source, items }) => setServerReminders(source, items)
  )
}
