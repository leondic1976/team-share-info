import { format } from 'date-fns'
import { ko } from 'date-fns/locale'

export const pad = (n: number): string => String(n).padStart(2, '0')

/** ms -> value for <input type="datetime-local"> or <input type="date"> */
export function toInputValue(ms: number, dateOnly = false): string {
  const d = new Date(ms)
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return dateOnly ? date : `${date}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromInputValue(v: string): number {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-').map(Number)
    return new Date(y, m - 1, d).getTime()
  }
  return new Date(v).getTime()
}

export function ymd(ms: number | Date = Date.now()): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseYmd(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function startOfDay(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

export const DAY = 86400000

export function fmtRange(start: number, end: number, allDay: boolean): string {
  if (allDay) {
    const last = end - DAY
    return last > start ? `${format(start, 'M/d(EEE)', { locale: ko })} ~ ${format(last, 'M/d(EEE)', { locale: ko })}` : format(start, 'M/d(EEE) 종일', { locale: ko })
  }
  const sameDay = ymd(start) === ymd(end)
  return sameDay
    ? `${format(start, 'M/d(EEE) HH:mm', { locale: ko })} ~ ${format(end, 'HH:mm')}`
    : `${format(start, 'M/d(EEE) HH:mm', { locale: ko })} ~ ${format(end, 'M/d(EEE) HH:mm', { locale: ko })}`
}

export const REMINDER_CHOICES: { min: number; label: string }[] = [
  { min: 0, label: '정시' },
  { min: 10, label: '10분 전' },
  { min: 30, label: '30분 전' },
  { min: 60, label: '1시간 전' },
  { min: 1440, label: '1일 전' }
]
