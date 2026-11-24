import { powerMonitor } from 'electron'
import log from 'electron-log/main'
import type { ReminderItem } from '../shared/schemas/personal'
import { alarmTimes, type UpcomingReminder } from '../shared/schemas/tools'
import { localDb } from './localdb'
import { showToast } from './notifications'

/**
 * Reminder scheduler in the main process (13.13: timers in hidden renderers are
 * throttled). Sources return reminders in a time window; each fires once.
 *  - personal events (local DB) are computed here
 *  - server events are pushed by the renderer via IPC (scheduler:setServerReminders)
 *  - personal alarms (M6-3) are computed here and ring in a popup window
 */
type Source = (from: number, to: number) => ReminderItem[]

const sources = new Map<string, Source>()
const serverReminders = new Map<string, ReminderItem[]>()
let timer: NodeJS.Timeout | null = null
let fireHandler: (r: ReminderItem) => void = (r) => showToast({ title: r.title, body: r.body, route: r.route })

const TICK_MS = 15_000
const CATCH_UP_MS = 10 * 60_000
const RESUME_CATCH_UP_MS = 60 * 60_000

export function addReminderSource(name: string, fn: Source): void {
  sources.set(name, fn)
}

/** Reminders computed by the renderer from server data, per source ('events', 'docs'...). */
export function setServerReminders(source: string, items: ReminderItem[]): void {
  serverReminders.set(source, items)
}

export function onReminderFire(fn: (r: ReminderItem) => void): void {
  fireHandler = fn
}

/** Reminders whose key starts with the prefix are handled by fn instead of a toast. */
const prefixHandlers = new Map<string, (r: ReminderItem) => void>()
export function onReminderPrefix(prefix: string, fn: (r: ReminderItem) => void): void {
  prefixHandlers.set(prefix, fn)
}

function fmtTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** Personal event reminders: "제목 · 10분 전 (11/16 10:00)". */
function personalEventSource(from: number, to: number): ReminderItem[] {
  const out: ReminderItem[] = []
  // Look ahead far enough to catch reminders set up to 14 days before.
  for (const o of localDb().events.list(from, to + 14 * 86400000)) {
    for (const m of o.reminders) {
      const fireAt = o.start - m * 60000
      if (fireAt < from || fireAt > to) continue
      const when = m === 0 ? '지금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`
      out.push({ key: `pe:${o.id}:${o.key}:${m}`, fireAt, title: `개인 일정 알림 · ${when}`, body: `${o.title} (${fmtTime(o.start)})`, route: '/calendar' })
    }
  }
  return out
}

function wasFired(key: string): boolean {
  return !!localDb().db.get('SELECT 1 FROM fired_reminders WHERE key = ?', [key])
}

function markFired(key: string): void {
  localDb().db.run('INSERT INTO fired_reminders (key, fired_at) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [key, Date.now()])
}

export function tick(now = Date.now(), catchUp = CATCH_UP_MS): ReminderItem[] {
  const from = now - catchUp
  const due: ReminderItem[] = []
  const all: ReminderItem[] = [...serverReminders.values()].flat().filter((r) => r.fireAt >= from && r.fireAt <= now)
  for (const [name, src] of sources) {
    try {
      all.push(...src(from, now))
    } catch (e) {
      log.warn(`[scheduler] source ${name} failed`, e)
    }
  }
  for (const r of all.sort((a, b) => a.fireAt - b.fireAt)) {
    if (wasFired(r.key)) continue
    markFired(r.key)
    due.push(r)
    if (process.env.TEAMHUB_E2E) (globalThis as unknown as { __teamhubFired: ReminderItem[] }).__teamhubFired.push(r)
    const handler = [...prefixHandlers].find(([p]) => r.key.startsWith(p))?.[1] ?? fireHandler
    try {
      handler(r)
    } catch (e) {
      log.warn('[scheduler] handler failed', e)
    }
  }
  return due
}

/** Everything that will ring in [from, to] across all sources ("오늘 울릴 알림"). */
export function upcoming(from: number, to: number): UpcomingReminder[] {
  const out: UpcomingReminder[] = []
  for (const [source, items] of serverReminders) {
    for (const r of items) if (r.fireAt >= from && r.fireAt <= to) out.push({ ...r, source, fired: false })
  }
  for (const [source, src] of sources) {
    try {
      for (const r of src(from, to)) out.push({ ...r, source, fired: false })
    } catch {
      // ignore broken source
    }
  }
  for (const r of out) r.fired = wasFired(r.key)
  return out.sort((a, b) => a.fireAt - b.fireAt)
}

/** Personal alarms (6.12 ②): key al:<id>:<time>. */
function alarmSource(from: number, to: number): ReminderItem[] {
  const out: ReminderItem[] = []
  for (const a of localDb().alarms.raw()) {
    for (const t of alarmTimes(a, from, to)) out.push({ key: `al:${a.id}:${t}`, fireAt: t, title: a.title, body: a.note, route: '/alarms' })
  }
  return out
}

export function startScheduler(): void {
  addReminderSource('personal-events', personalEventSource)
  addReminderSource('alarms', alarmSource)
  // E2E can read fired reminders from the main process (Windows toasts are not observable).
  if (process.env.TEAMHUB_E2E) (globalThis as unknown as { __teamhubFired: ReminderItem[] }).__teamhubFired = []
  localDb().db.run('DELETE FROM fired_reminders WHERE fired_at < ?', [Date.now() - 30 * 86400000])
  // Do not replay reminders that were due long before this app start.
  timer = setInterval(() => tick(), TICK_MS)
  setTimeout(() => tick(), 3000)
  powerMonitor.on('resume', () => tick(Date.now(), RESUME_CATCH_UP_MS))
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
