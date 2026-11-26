/**
 * Korean public holidays (관공서의 공휴일에 관한 규정), worked out from the rules so the built-in
 * list (resources/data/holidays-kr.json, seeded into the server's holidays table) can be
 * checked and extended without the internet. Admins still edit the served list (관리 → 공휴일).
 *
 * The lunar ones need the solar date of 설날 (1/1), 부처님오신날 (4/8) and 추석 (8/15) in
 * Korean time (KST: 2028's 설날 is 1/27 here, a day after the Chinese new year).
 */

/** Solar dates (MM-DD) of the lunar holidays, per year. Checked against the new moons in KST. */
export const KR_LUNAR: Record<number, { seollal: string; buddha: string; chuseok: string }> = {
  2025: { seollal: '01-29', buddha: '05-05', chuseok: '10-06' },
  2026: { seollal: '02-17', buddha: '05-24', chuseok: '09-25' },
  2027: { seollal: '02-07', buddha: '05-13', chuseok: '09-15' },
  2028: { seollal: '01-27', buddha: '05-02', chuseok: '10-03' },
  2029: { seollal: '02-13', buddha: '05-20', chuseok: '09-22' },
  2030: { seollal: '02-03', buddha: '05-09', chuseok: '09-12' }
}

/** Days off fixed by a separate decision: election days and 임시공휴일. */
export const KR_SPECIAL_DAYS: Record<string, string> = {
  '2025-01-27': '임시공휴일',
  '2025-06-03': '제21대 대통령선거',
  '2026-06-03': '전국동시지방선거',
  // 공직선거법 제34조: the first Wednesday from 50 (국회) / 30 (지방) days before the term ends
  '2028-04-12': '제23대 국회의원선거',
  '2030-06-05': '전국동시지방선거'
}

const pad = (n: number): string => String(n).padStart(2, '0')
const ymd = (d: Date): string => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
const at = (date: string): Date => new Date(`${date}T00:00:00Z`)
const shift = (date: string, n: number): string => {
  const d = at(date)
  d.setUTCDate(d.getUTCDate() + n)
  return ymd(d)
}
const weekday = (date: string): number => at(date).getUTCDay()

interface Base {
  /** the days of the holiday (3 for 설날·추석) */
  days: string[]
  names: string[]
  /** short name used in "대체공휴일(…)" */
  short: string
  /** 'period': 설날·추석 (a Sunday or another holiday moves it); 'day': also a Saturday; 'none': never */
  rule: 'period' | 'day' | 'none'
}

/**
 * The public holidays of one year, as [date, name] in date order. 대체공휴일:
 * - 설날·추석 연휴 that falls on a Sunday or on another holiday: the first working day after it;
 * - 삼일절·어린이날·부처님오신날·광복절·개천절·한글날·성탄절 on a Saturday, a Sunday or another
 *   holiday: the first working day after it;
 * - 신정·현충일: none.
 * One clash gives one day (어린이날 and 부처님오신날 on the same Monday: one 대체공휴일).
 * Returns [] for a year whose lunar dates are not known.
 */
export function koreanHolidays(year: number): [string, string][] {
  const lunar = KR_LUNAR[year]
  if (!lunar) return []
  const y = String(year)
  const three = (md: string, name: string): Base => {
    const day = `${y}-${md}`
    return { days: [shift(day, -1), day, shift(day, 1)], names: [`${name} 연휴`, name, `${name} 연휴`], short: name, rule: 'period' }
  }
  const one = (md: string, name: string, rule: Base['rule']): Base => ({ days: [`${y}-${md}`], names: [name], short: name, rule })
  // fixed days first, so a shared date reads "어린이날·부처님오신날"
  const bases: Base[] = [
    one('01-01', '신정', 'none'),
    one('03-01', '삼일절', 'day'),
    one('05-05', '어린이날', 'day'),
    one('06-06', '현충일', 'none'),
    one('08-15', '광복절', 'day'),
    one('10-03', '개천절', 'day'),
    one('10-09', '한글날', 'day'),
    one('12-25', '성탄절', 'day'),
    three(lunar.seollal, '설날'),
    one(lunar.buddha, '부처님오신날', 'day'),
    three(lunar.chuseok, '추석')
  ]
  const names = new Map<string, string[]>()
  const owners = new Map<string, number>()
  for (const b of bases)
    b.days.forEach((d, j) => {
      names.set(d, [...(names.get(d) ?? []), b.names[j]])
      owners.set(d, (owners.get(d) ?? 0) + 1)
    })
  for (const [d, n] of Object.entries(KR_SPECIAL_DAYS)) if (d.startsWith(y) && !names.has(d)) names.set(d, [n])

  // what moves each holiday: the days that clash (a set, so one clash is counted once)
  const triggers: { causes: Set<string>; after: string; short: string[] }[] = []
  for (const b of bases) {
    if (b.rule === 'none') continue
    const causes = b.days.filter((d) => weekday(d) === 0 || (b.rule === 'day' && weekday(d) === 6) || (owners.get(d) ?? 0) > 1)
    if (!causes.length) continue
    const t = { causes: new Set(causes), after: b.days[b.days.length - 1], short: [b.short] }
    // a clash between two holidays gives one 대체공휴일, after the later of the two
    const same = triggers.find((x) => causes.some((c) => x.causes.has(c) && (owners.get(c) ?? 0) > 1))
    if (same) {
      for (const c of causes) same.causes.add(c)
      if (t.after > same.after) same.after = t.after
      same.short.push(b.short)
    } else triggers.push(t)
  }
  triggers.sort((a, b) => (a.after < b.after ? -1 : 1))
  for (const t of triggers) {
    let d = shift(t.after, 1)
    while (weekday(d) === 0 || weekday(d) === 6 || names.has(d)) d = shift(d, 1)
    names.set(d, [t.short.length > 1 ? '대체공휴일' : `대체공휴일(${t.short[0]})`])
  }
  return [...names].map(([d, n]) => [d, n.join('·')] as [string, string]).sort((a, b) => (a[0] < b[0] ? -1 : 1))
}

/** date (YYYY-MM-DD) -> holiday name, for quick lookups in a view. */
export function holidayMap(list: { date: string; name: string }[]): Map<string, string> {
  return new Map(list.map((h) => [h.date, h.name]))
}
