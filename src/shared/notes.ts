/** Personal knowledge notes (6.18 ⑤, Notion-style). Local only. */

export type NoteKind = 'page' | 'database'

export interface NoteTreeItem {
  id: string
  parentId: string | null
  kind: NoteKind
  title: string
  icon: string
  sort: number
  favorite: boolean
  isTemplate: boolean
}

export type PropType = 'text' | 'number' | 'select' | 'multi' | 'date' | 'check' | 'url'
export interface PropDef {
  id: string
  name: string
  type: PropType
  options?: string[]
}
export interface DbView {
  type: 'table' | 'board'
  groupBy?: string
  sort?: { prop: string; dir: 'asc' | 'desc' } | null
  filters?: DbFilter[]
}
export interface DbFilter {
  prop: string
  op: 'contains' | 'eq' | 'neq' | 'empty' | 'notEmpty' | 'gt' | 'lt' | 'checked' | 'unchecked'
  value?: string
}
export interface DbProps {
  columns: PropDef[]
  view: DbView
}

export type CellValue = string | number | boolean | string[] | null
export interface NoteRow {
  id: string
  title: string
  icon: string
  values: Record<string, CellValue>
  sort: number
}

export interface NoteDto extends NoteTreeItem {
  bodyHtml: string
  props: DbProps | Record<string, never>
  rowValues: Record<string, CellValue> | null
  createdAt: number
  updatedAt: number
  trashedAt: number | null
  backlinks: { id: string; title: string; icon: string }[]
  path: { id: string; title: string }[]
}

export const NOTE_LINK_ATTR = 'data-note-id'

/** Plain text of an HTML body for search. Works without a DOM. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(br|\/p|\/li|\/h\d|\/div|\/tr|\/summary)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

/** Ids of pages linked from a body (anchors carrying data-note-id). */
export function extractNoteLinks(html: string): string[] {
  return [...new Set([...html.matchAll(/data-note-id="([\w-]+)"/g)].map((m) => m[1]))]
}

const cellText = (v: CellValue): string => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v))
const isEmpty = (v: CellValue): boolean => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length) || v === false

/** Apply a database view's filters and sort to rows (6.18 ⑤ 정렬·필터). */
export function applyView(rows: NoteRow[], props: DbProps): NoteRow[] {
  const val = (r: NoteRow, prop: string): CellValue => (prop === 'title' ? r.title : (r.values[prop] ?? null))
  const typeOf = (prop: string): PropType => (prop === 'title' ? 'text' : (props.columns.find((c) => c.id === prop)?.type ?? 'text'))
  let out = rows.filter((r) =>
    (props.view.filters ?? []).every((f) => {
      const v = val(r, f.prop)
      const t = typeOf(f.prop)
      switch (f.op) {
        case 'contains':
          return cellText(v).toLowerCase().includes((f.value ?? '').toLowerCase())
        case 'eq':
          return Array.isArray(v) ? v.includes(f.value ?? '') : cellText(v) === (f.value ?? '')
        case 'neq':
          return Array.isArray(v) ? !v.includes(f.value ?? '') : cellText(v) !== (f.value ?? '')
        case 'empty':
          return isEmpty(v)
        case 'notEmpty':
          return !isEmpty(v)
        case 'checked':
          return v === true
        case 'unchecked':
          return v !== true
        case 'gt':
        case 'lt': {
          const a = t === 'number' ? Number(v) : cellText(v)
          const b = t === 'number' ? Number(f.value) : (f.value ?? '')
          if (v === null || v === '') return false
          return f.op === 'gt' ? a > b : a < b
        }
      }
    })
  )
  const s = props.view.sort
  if (s) {
    const t = typeOf(s.prop)
    out = [...out].sort((a, b) => {
      const x = val(a, s.prop)
      const y = val(b, s.prop)
      if (isEmpty(x) && !isEmpty(y)) return 1
      if (!isEmpty(x) && isEmpty(y)) return -1
      const c = t === 'number' ? Number(x) - Number(y) : t === 'check' ? Number(x === true) - Number(y === true) : cellText(x).localeCompare(cellText(y), 'ko')
      return s.dir === 'asc' ? c : -c
    })
  } else out = [...out].sort((a, b) => a.sort - b.sort)
  return out
}

/** Board view columns: options of the group-by select (plus "없음"). */
export function boardGroups(rows: NoteRow[], props: DbProps): { key: string; rows: NoteRow[] }[] {
  const col = props.columns.find((c) => c.id === props.view.groupBy)
  if (!col) return [{ key: '', rows }]
  const keys = [...(col.options ?? []), '']
  return keys.map((k) => ({ key: k, rows: rows.filter((r) => cellText(r.values[col.id] ?? null) === k || (k === '' && !(col.options ?? []).includes(cellText(r.values[col.id] ?? null)))) }))
}

/** Minimal HTML → Markdown for export (headings, lists, tasks, quotes, code, links, emphasis, tables as text). */
export function htmlToMarkdown(html: string): string {
  let s = html
  s = s.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_m, c: string) => `\n\`\`\`\n${htmlToText(c)}\n\`\`\`\n`)
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n${'#'.repeat(Number(n))} ${htmlToText(t)}\n`)
  s = s.replace(/<li[^>]*data-checked="(true|false)"[^>]*>([\s\S]*?)<\/li>/gi, (_m, c: string, t: string) => `- [${c === 'true' ? 'x' : ' '}] ${htmlToText(t)}\n`)
  s = s.replace(/<ol[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
    let i = 0
    return `\n${inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_x, t: string) => `${++i}. ${htmlToText(t)}\n`)}`
  })
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, t: string) => `- ${htmlToText(t)}\n`)
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, t: string) => `\n${htmlToText(t).split('\n').map((l) => `> ${l}`).join('\n')}\n`)
  s = s.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, h: string, t: string) => `[${htmlToText(t)}](${h})`)
  s = s.replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, '**$2**').replace(/<(em|i)>([\s\S]*?)<\/\1>/gi, '*$2*').replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
  s = s.replace(/<hr[^>]*>/gi, '\n---\n')
  s = s.replace(/<\/p>|<br[^>]*>/gi, '\n')
  return htmlToText(s.replace(/<(?!\/?(p|div))[^>]+>/g, (t) => (/^<\/?(ul|ol|summary|details|table|tbody|tr|td|th)/i.test(t) ? '\n' : t)))
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export const NOTE_TEMPLATES: { key: string; title: string; icon: string; html: string }[] = [
  {
    key: 'meeting',
    title: '회의 노트',
    icon: '🗓️',
    html: '<h2>회의 정보</h2><p>일시: </p><p>참석: </p><h2>안건</h2><ul><li><p></p></li></ul><h2>논의 내용</h2><p></p><h2>결정 사항</h2><ul><li><p></p></li></ul><h2>할 일</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>'
  },
  {
    key: 'worklog',
    title: '업무 일지',
    icon: '📝',
    html: '<h2>오늘 한 일</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul><h2>배운 점·메모</h2><p></p><h2>내일 할 일</h2><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p></p></li></ul>'
  },
  {
    key: 'project',
    title: '프로젝트',
    icon: '📁',
    html: '<h2>목표</h2><p></p><h2>범위·일정</h2><table><tbody><tr><th><p>단계</p></th><th><p>기간</p></th><th><p>담당</p></th></tr><tr><td><p></p></td><td><p></p></td><td><p></p></td></tr></tbody></table><h2>관련 자료</h2><ul><li><p></p></li></ul><h2>진행 기록</h2><p></p>'
  },
  {
    key: 'reading',
    title: '독서·학습 기록',
    icon: '📚',
    html: '<h2>정보</h2><p>제목·저자: </p><p>기간: </p><h2>핵심 내용</h2><ul><li><p></p></li></ul><h2>인상 깊은 부분</h2><blockquote><p></p></blockquote><h2>업무에 적용할 점</h2><p></p>'
  }
]

export const DEFAULT_DB_PROPS: DbProps = {
  columns: [
    { id: 'status', name: '상태', type: 'select', options: ['할 일', '진행 중', '완료'] },
    { id: 'due', name: '날짜', type: 'date' },
    { id: 'tags', name: '태그', type: 'multi', options: [] }
  ],
  view: { type: 'table', groupBy: 'status', sort: null, filters: [] }
}
