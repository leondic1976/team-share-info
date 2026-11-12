import { describe, it, expect } from 'vitest'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { NotesRepo } from '../../src/main/localdb/notes'
import { OrganizeRepo } from '../../src/main/localdb/organize'
import { applyView, boardGroups, htmlToMarkdown, type DbProps } from '../../src/shared/notes'

const open = (): Db => {
  const db = new Db(':memory:')
  db.migrate(LOCAL_MIGRATIONS)
  return db
}

describe('knowledge notes (M7-13)', () => {
  it('page tree, links with backlinks, move, trash and restore', () => {
    const n = new NotesRepo(open())
    const root = n.create({ title: '업무 지식', icon: '📚' })
    const a = n.create({ parentId: root, title: '예산 편성 절차' })
    const b = n.create({ parentId: root, title: '회계 기준' })
    n.update(a, { bodyHtml: `<p>참고: <a href="#/notes/${b}" data-note-id="${b}">회계 기준</a> 을 먼저 봅니다. 결산 일정 확인</p>` })
    expect(n.get(b)?.backlinks.map((x) => x.title)).toEqual(['예산 편성 절차'])
    expect(n.get(a)?.path.map((x) => x.title)).toEqual(['업무 지식'])
    expect(n.search('결산 일정')[0]).toMatchObject({ id: a })
    expect(n.search('회계')[0].id).toBeDefined()

    // move b to the top level, before root; cannot move root under its child
    n.move(b, null, 0)
    expect(n.tree().filter((t) => t.parentId === null).map((t) => t.title)).toEqual(['회계 기준', '업무 지식'])
    expect(() => n.move(root, a, 0)).toThrow()

    n.moveToTrash(root)
    expect(n.tree().map((t) => t.title)).toEqual(['회계 기준'])
    expect(n.trash().map((t) => t.title)).toEqual(['업무 지식'])
    expect(n.get(b)?.backlinks).toEqual([]) // linking page is in the trash
    n.restore(root)
    expect(n.tree().map((t) => t.title).sort()).toEqual(['업무 지식', '예산 편성 절차', '회계 기준'].sort())
    n.moveToTrash(a)
    expect(n.purgeOld(Date.now() + 31 * 86400000)).toBe(1)
    expect(n.get(a)).toBeNull()
  })

  it('databases: rows, filters, sort and board groups', () => {
    const n = new NotesRepo(open())
    const db = n.create({ kind: 'database', title: '할 일 DB' })
    const props = n.get(db)!.props as DbProps
    props.columns.push({ id: 'pts', name: '점수', type: 'number' })
    n.update(db, { props })
    n.addRow(db, { status: '완료', pts: 3, tags: ['보고'] }, '보고서 제출')
    n.addRow(db, { status: '진행 중', pts: 10 }, '예산 정리')
    n.addRow(db, { status: '할 일' }, '자료 수집')
    const rows = n.rows(db)
    expect(rows.map((r) => r.title)).toEqual(['보고서 제출', '예산 정리', '자료 수집'])
    expect(n.tree().map((t) => t.title)).toEqual(['할 일 DB']) // rows are not in the tree
    const view = (v: Partial<DbProps['view']>): string[] => applyView(rows, { ...props, view: { ...props.view, ...v } }).map((r) => r.title)
    expect(view({ filters: [{ prop: 'status', op: 'neq', value: '완료' }] })).toEqual(['예산 정리', '자료 수집'])
    expect(view({ filters: [{ prop: 'pts', op: 'gt', value: '5' }] })).toEqual(['예산 정리'])
    expect(view({ filters: [{ prop: 'tags', op: 'eq', value: '보고' }] })).toEqual(['보고서 제출'])
    expect(view({ filters: [{ prop: 'pts', op: 'empty' }] })).toEqual(['자료 수집'])
    expect(view({ sort: { prop: 'pts', dir: 'desc' } })).toEqual(['예산 정리', '보고서 제출', '자료 수집'])
    expect(view({ sort: { prop: 'title', dir: 'asc' } })).toEqual(['보고서 제출', '예산 정리', '자료 수집'])
    expect(boardGroups(rows, props).map((g) => `${g.key}:${g.rows.length}`)).toEqual(['할 일:1', '진행 중:1', '완료:1', ':0'])
  })

  it('templates duplicate subpages; markdown export', () => {
    const n = new NotesRepo(open())
    const t = n.create({ title: '프로젝트 틀', bodyHtml: '<h2>목표</h2><p>x</p>' })
    n.create({ parentId: t, title: '회의 기록' })
    const tpl = n.duplicate(t, null, true)
    expect(n.get(tpl)?.isTemplate).toBe(true)
    const used = n.duplicate(tpl, null)
    expect(n.tree().filter((x) => x.parentId === used).map((x) => x.title)).toEqual(['회의 기록'])
    expect(htmlToMarkdown('<h2>목표</h2><p><strong>굵게</strong> 와 <a href="https://a.b">링크</a></p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>끝</p></li></ul><ol><li><p>하나</p></li><li><p>둘</p></li></ol>')).toBe(
      '## 목표\n**굵게** 와 [링크](https://a.b)\n- [x] 끝\n1. 하나\n2. 둘'
    )
  })

  it('organize: tags, collections and bookmarks', () => {
    const o = new OrganizeRepo(open())
    o.setTags('C:\\a\\보고서.hwp', ['예산', '중요'])
    o.addTag(['C:\\a\\계획.xlsx'], '예산')
    expect(o.tags().map((t) => `${t.name}:${t.count}`)).toEqual(['예산:2', '중요:1'])
    expect(o.tagsOf(['C:\\a\\보고서.hwp'])).toEqual({ 'C:\\a\\보고서.hwp': ['예산', '중요'] })
    o.updateTag('예산', { name: '예산2026' })
    expect(o.pathsWithTag('예산2026').length).toBe(2)
    const c = o.saveCollection({ name: '2026 예산 업무' })
    const sub = o.saveCollection({ name: '참고 자료', parentId: c })
    expect(() => o.saveCollection({ id: c, name: '2026 예산 업무', parentId: sub })).toThrow()
    expect(o.addToCollection(c, ['C:\\a\\보고서.hwp', 'D:\\b\\계획.xlsx', 'C:\\a\\보고서.hwp'])).toBe(2)
    o.deleteCollection(c)
    expect(o.collections()).toEqual([])
    expect(o.importBookmarks([{ title: '정부24', url: 'https://www.gov.kr', category: '공공' }, { title: '중복', url: 'https://www.gov.kr', category: '' }])).toBe(1)
    expect(o.bookmarks().map((b) => b.title)).toEqual(['정부24'])
  })
})
