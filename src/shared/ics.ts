/** Minimal iCalendar (.ics) export/import for events (6.4). */

export interface IcsEvent {
  uid: string
  title: string
  description?: string
  location?: string
  startAt: number
  endAt: number
  allDay: boolean
  rrule?: string | null
}

const pad = (n: number): string => String(n).padStart(2, '0')

function utcStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
}

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function unescape(s: string): string {
  return s.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\')
}

/** Fold lines longer than 75 octets as required by RFC 5545. */
function fold(line: string): string {
  const out: string[] = []
  let cur = ''
  for (const ch of line) {
    if (new TextEncoder().encode(cur + ch).length > 74) {
      out.push(cur)
      cur = ' ' + ch
    } else cur += ch
  }
  out.push(cur)
  return out.join('\r\n')
}

export function toIcs(events: IcsEvent[], calName = 'TeamHub'): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//TeamHub//KO', 'CALSCALE:GREGORIAN', `X-WR-CALNAME:${escape(calName)}`]
  const now = utcStamp(Date.now())
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.uid}`, `DTSTAMP:${now}`)
    if (e.allDay) lines.push(`DTSTART;VALUE=DATE:${localDate(e.startAt)}`, `DTEND;VALUE=DATE:${localDate(e.endAt)}`)
    else lines.push(`DTSTART:${utcStamp(e.startAt)}`, `DTEND:${utcStamp(e.endAt)}`)
    lines.push(`SUMMARY:${escape(e.title)}`)
    if (e.location) lines.push(`LOCATION:${escape(e.location)}`)
    if (e.description) lines.push(`DESCRIPTION:${escape(e.description)}`)
    if (e.rrule) lines.push(`RRULE:${e.rrule.replace(/^RRULE:/i, '')}`)
    lines.push('END:VEVENT')
  }
  lines.push('END:VCALENDAR')
  return lines.map(fold).join('\r\n') + '\r\n'
}

function parseDate(value: string, params: string): { ms: number; allDay: boolean } | null {
  if (/VALUE=DATE(?!-)/i.test(params) || /^\d{8}$/.test(value)) {
    const m = /^(\d{4})(\d{2})(\d{2})/.exec(value)
    if (!m) return null
    return { ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime(), allDay: true }
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(value)
  if (!m) return null
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number)
  // UTC when suffixed with Z; otherwise floating/TZID times are taken as local time.
  const ms = m[7] ? Date.UTC(y, mo - 1, d, h, mi, s) : new Date(y, mo - 1, d, h, mi, s).getTime()
  return { ms, allDay: false }
}

export function parseIcs(text: string): IcsEvent[] {
  const unfolded = text.replace(/\r?\n[ \t]/g, '')
  const lines = unfolded.split(/\r?\n/)
  const out: IcsEvent[] = []
  let cur: Partial<IcsEvent> & { _dur?: number } | null = null
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = {}
      continue
    }
    if (line === 'END:VEVENT') {
      if (cur && cur.startAt !== undefined && cur.title !== undefined) {
        const allDay = !!cur.allDay
        const endAt = cur.endAt ?? (allDay ? cur.startAt + 86400000 : cur.startAt + (cur._dur ?? 3600000))
        out.push({ uid: cur.uid ?? `${cur.startAt}-${out.length}`, title: cur.title, description: cur.description, location: cur.location, startAt: cur.startAt, endAt, allDay, rrule: cur.rrule ?? null })
      }
      cur = null
      continue
    }
    if (!cur) continue
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const head = line.slice(0, idx)
    const value = line.slice(idx + 1)
    const [name, ...paramParts] = head.split(';')
    const params = paramParts.join(';')
    switch (name.toUpperCase()) {
      case 'UID':
        cur.uid = value
        break
      case 'SUMMARY':
        cur.title = unescape(value)
        break
      case 'DESCRIPTION':
        cur.description = unescape(value)
        break
      case 'LOCATION':
        cur.location = unescape(value)
        break
      case 'RRULE':
        cur.rrule = value
        break
      case 'DTSTART': {
        const d = parseDate(value, params)
        if (d) {
          cur.startAt = d.ms
          cur.allDay = d.allDay
        }
        break
      }
      case 'DTEND': {
        const d = parseDate(value, params)
        if (d) cur.endAt = d.ms
        break
      }
      case 'DURATION': {
        const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value)
        if (m) cur._dur = ((Number(m[1] ?? 0) * 24 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 60000
        break
      }
    }
  }
  return out
}
