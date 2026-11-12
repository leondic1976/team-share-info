import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { AlarmsRepo, MemosRepo, ToolsRepo } from '../../src/main/localdb/tools'

const open = (path = ':memory:'): Db => {
  const db = new Db(path)
  db.migrate(LOCAL_MIGRATIONS)
  return db
}

describe('personal tools (local DB, M6-7..9)', () => {
  it('sticky memos keep color, bounds and always-on-top across reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-tools-'))
    const path = join(dir, 'local.db')
    try {
      let db = open(path)
      const memos = new MemosRepo(db)
      const id = memos.save({ body: '<p>전화 회신</p>', color: 'pink', tags: ['전화'] })
      memos.setSticky(id, true)
      memos.setBounds(id, { x: 100, y: 120, w: 280, h: 220 })
      memos.setOnTop(id, true)
      memos.save({ body: '<p>다른 메모</p>', pinned: true })
      db.close()

      db = open(path)
      const again = new MemosRepo(db)
      expect(again.stickies()).toEqual([expect.objectContaining({ id, color: 'pink', bounds: { x: 100, y: 120, w: 280, h: 220 }, alwaysOnTop: true, tags: ['전화'] })])
      expect(again.list()[0].pinned).toBe(true)
      expect(again.list('회신').map((m) => m.id)).toEqual([id])
      expect(again.list('전화').map((m) => m.id)).toEqual([id])
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('one-shot alarms switch off after ringing; snooze rings once more; repeats stay on', () => {
    const repo = new AlarmsRepo(open())
    const t = Date.now() + 3600_000
    const once = repo.save({ title: '보고서', kind: 'once', fireAt: t })
    expect(repo.get(once)?.next).toBe(t)
    repo.fired(once, t)
    expect(repo.get(once)).toMatchObject({ enabled: false, next: null, lastFiredAt: t })
    repo.snooze(once, t + 300_000)
    expect(repo.get(once)?.next).toBe(t + 300_000)
    repo.fired(once, t + 300_000)
    expect(repo.get(once)).toMatchObject({ snoozeUntil: null, next: null })

    const rep = repo.save({ title: '출근', kind: 'repeat', fireAt: t, rrule: 'FREQ=DAILY' })
    repo.fired(rep, t)
    expect(repo.get(rep)?.enabled).toBe(true)
    expect(repo.get(rep)?.next).toBeGreaterThan(t)

    const dl = repo.save({ title: '제출', kind: 'deadline', fireAt: t + 10 * 86400000, leadDays: [3, 0] })
    repo.fired(dl, t + 7 * 86400000)
    expect(repo.get(dl)?.enabled).toBe(true) // only D-3 rang
    repo.setEnabled(dl, false)
    expect(repo.list().at(-1)?.id).toBe(dl)
  })

  it('clipboard history dedupes and keeps 100 items; favorites toggle; focus totals', () => {
    const tools = new ToolsRepo(open())
    tools.addClipboard('text', 'a')
    tools.addClipboard('text', 'b')
    tools.addClipboard('text', 'a')
    expect(tools.clipboard().map((c) => c.body)).toEqual(['a', 'b'])
    for (let i = 0; i < 120; i++) tools.addClipboard('text', `x${i}`)
    expect(tools.clipboard()).toHaveLength(100)
    tools.deleteClipboard(null)
    expect(tools.clipboard()).toHaveLength(0)

    const f = { itemType: 'doc', itemId: 'd1', title: '출장 처리', route: '/docs/manual/d1' }
    expect(tools.toggleFavorite(f)).toBe(true)
    expect(tools.favorites().map((x) => x.title)).toEqual(['출장 처리'])
    expect(tools.toggleFavorite(f)).toBe(false)
    expect(tools.favorites()).toEqual([])

    const s = tools.startFocus(25, 'focus')
    expect(tools.focusToday()).toEqual({ sessions: 0, minutes: 0 })
    tools.endFocus(s)
    expect(tools.focusToday()).toEqual({ sessions: 1, minutes: 25 })

    const sn = tools.saveSnippet({ title: '인사', body: '안녕하십니까.', groupName: '메일' })
    tools.useSnippet(sn)
    expect(tools.snippets()[0]).toMatchObject({ title: '인사', groupName: '메일' })
  })
})
