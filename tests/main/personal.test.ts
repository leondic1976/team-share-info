import { describe, it, expect } from 'vitest'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { PersonalEventsRepo } from '../../src/main/localdb/personal-events'
import { DiaryRepo, htmlToPlain } from '../../src/main/localdb/diary'

const L = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime()
const open = () => {
  const db = new Db(':memory:')
  db.migrate(LOCAL_MIGRATIONS)
  return db
}

describe('personal events (local DB)', () => {
  it('saves, lists expanded occurrences, and edits this/following/all', () => {
    const repo = new PersonalEventsRepo(open())
    const id = repo.save({ title: '운동', startAt: L(2026, 11, 2, 7), endAt: L(2026, 11, 2, 8), rrule: 'FREQ=DAILY;COUNT=5', reminders: [10] })
    const titles = () => repo.list(L(2026, 11, 1), L(2026, 11, 30)).map((o) => `${new Date(o.start).getDate()}:${o.title}`)
    expect(titles()).toEqual(['2:운동', '3:운동', '4:운동', '5:운동', '6:운동'])
    repo.save({ id, mode: 'this', occurrenceStart: L(2026, 11, 3, 7), title: '쉼', startAt: L(2026, 11, 3, 7), endAt: L(2026, 11, 3, 8), rrule: 'FREQ=DAILY;COUNT=5' })
    expect(titles()).toEqual(['2:운동', '3:쉼', '4:운동', '5:운동', '6:운동'])
    repo.save({ id, mode: 'following', occurrenceStart: L(2026, 11, 5, 7), title: '걷기', startAt: L(2026, 11, 5, 7), endAt: L(2026, 11, 5, 8), rrule: 'FREQ=DAILY;COUNT=2' })
    expect(titles()).toEqual(['2:운동', '3:쉼', '4:운동', '5:걷기', '6:걷기'])
    repo.delete(id, 'this', L(2026, 11, 4, 7))
    expect(titles()).toEqual(['2:운동', '3:쉼', '5:걷기', '6:걷기'])
    repo.delete(id, 'all')
    expect(titles()).toEqual(['3:쉼', '5:걷기', '6:걷기'])
    const r2 = repo.save({ title: '회의', startAt: L(2026, 12, 1, 9), endAt: L(2026, 12, 1, 10), reminders: [10, 60] })
    expect(repo.list(L(2026, 12, 1), L(2026, 12, 2)).find((o) => o.id === r2)?.reminders).toEqual([10, 60])
  })

  it('stores the busy link', () => {
    const repo = new PersonalEventsRepo(open())
    const id = repo.save({ title: '병원', startAt: 1, endAt: 2 })
    repo.setBusyLink(id, 'server-1')
    expect(repo.get(id)?.busyEventId).toBe('server-1')
  })
})

describe('diary (local DB)', () => {
  it('saves one entry per day, lists month, searches, and deletes empty entries', () => {
    const repo = new DiaryRepo(open())
    repo.save('2026-11-12', '<p>오늘 <b>보고서</b> 끝냄</p>', ['업무'])
    repo.save('2026-11-13', '<p>휴식</p>', [])
    repo.save('2026-11-12', '<p>오늘 보고서 제출</p>', ['업무', '보고'])
    expect(repo.get('2026-11-12')?.tags).toEqual(['업무', '보고'])
    expect(repo.month('2026-11').map((d) => d.date)).toEqual(['2026-11-13', '2026-11-12'])
    expect(repo.search('제출').map((d) => d.date)).toEqual(['2026-11-12'])
    expect(repo.search('보고').length).toBe(1)
    expect(repo.save('2026-11-13', '<p></p>', [])).toBeNull()
    expect(repo.get('2026-11-13')).toBeNull()
    expect(htmlToPlain('<p>a&amp;b</p><p>c</p>')).toBe('a&b c')
  })
})
