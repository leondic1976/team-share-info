import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Filter, Kanban, Plus, Table2, Trash2, X } from 'lucide-react'
import { applyView, boardGroups, type CellValue, type DbFilter, type DbProps, type NoteRow, type PropDef, type PropType } from '@shared/notes'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'

const TYPE_LABEL: Record<PropType, string> = { text: '텍스트', number: '숫자', select: '선택', multi: '여러 선택', date: '날짜', check: '체크', url: '주소' }
const OPS: { op: DbFilter['op']; label: string; needs: boolean }[] = [
  { op: 'contains', label: '포함', needs: true },
  { op: 'eq', label: '같음', needs: true },
  { op: 'neq', label: '같지 않음', needs: true },
  { op: 'gt', label: '보다 큼', needs: true },
  { op: 'lt', label: '보다 작음', needs: true },
  { op: 'empty', label: '비어 있음', needs: false },
  { op: 'notEmpty', label: '비어 있지 않음', needs: false },
  { op: 'checked', label: '체크됨', needs: false },
  { op: 'unchecked', label: '체크 안 됨', needs: false }
]
const OPTION_COLORS = ['bg-slate-200', 'bg-sky-200', 'bg-amber-200', 'bg-green-200', 'bg-rose-200', 'bg-purple-200', 'bg-orange-200']
const optClass = (col: PropDef, v: string): string => `${OPTION_COLORS[Math.max(0, (col.options ?? []).indexOf(v)) % OPTION_COLORS.length]} text-slate-900`

function Cell({ col, value, onChange }: { col: PropDef; value: CellValue; onChange: (v: CellValue) => void }): React.JSX.Element {
  const [draft, setDraft] = useState<string | null>(null)
  const commit = (): void => {
    if (draft === null) return
    onChange(col.type === 'number' ? (draft.trim() === '' ? null : Number(draft)) : col.type === 'multi' ? draft.split(',').map((s) => s.trim()).filter(Boolean) : draft)
    setDraft(null)
  }
  if (col.type === 'check') return <input type="checkbox" aria-label={col.name} checked={value === true} onChange={(e) => onChange(e.target.checked)} />
  if (col.type === 'select')
    return (
      <Select aria-label={col.name} className="h-7 border-transparent bg-transparent text-xs" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">—</option>
        {(col.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    )
  if (col.type === 'date') return <input type="date" aria-label={col.name} className="h-7 bg-transparent text-xs" value={typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || null)} />
  const shown = Array.isArray(value) ? value.join(', ') : value === null || value === undefined ? '' : String(value)
  if (draft === null && col.type === 'multi' && Array.isArray(value) && value.length)
    return (
      <button className="flex w-full cursor-text flex-wrap gap-1" onClick={() => setDraft(shown)} aria-label={col.name}>
        {value.map((v) => (
          <span key={v} className={cn('rounded px-1.5 text-xs', optClass(col, v))}>
            {v}
          </span>
        ))}
      </button>
    )
  if (draft === null && col.type === 'url' && shown)
    return (
      <span className="flex items-center gap-1">
        <a className="truncate text-xs text-primary underline" href={shown} target="_blank" rel="noreferrer">
          {shown}
        </a>
        <button className="text-xs text-muted-foreground" onClick={() => setDraft(shown)} aria-label="주소 고치기">
          ✎
        </button>
      </span>
    )
  return (
    <input
      aria-label={col.name}
      className="h-7 w-full bg-transparent text-xs outline-none focus:bg-background"
      type={col.type === 'number' ? 'number' : 'text'}
      value={draft ?? shown}
      placeholder={col.type === 'multi' ? '쉼표로 구분' : ''}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === 'Enter' && commit()}
    />
  )
}

/** Notion-style database inside a page: typed columns, table and board views, sort and filters. */
export function DatabaseView({ dbId, props, onProps, onOpen }: { dbId: string; props: DbProps; onProps: (p: DbProps) => void; onOpen: (id: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const rowsQ = useQuery({ queryKey: ['local', 'note-rows', dbId], queryFn: () => invoke('notes:rows', { dbId }), networkMode: 'always' })
  const [newCol, setNewCol] = useState<{ name: string; type: PropType } | null>(null)
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local', 'note-rows', dbId] })
  const rows = useMemo(() => applyView(rowsQ.data ?? [], props), [rowsQ.data, props])
  const view = props.view
  const setView = (v: Partial<DbProps['view']>): void => onProps({ ...props, view: { ...view, ...v } })
  const setCell = (r: NoteRow, col: PropDef, v: CellValue): void => {
    let columns = props.columns
    // new option typed into a select/multi column becomes an option
    const vals = Array.isArray(v) ? v : typeof v === 'string' && (col.type === 'select' || col.type === 'multi') ? [v] : []
    const missing = vals.filter((x) => x && !(col.options ?? []).includes(x))
    if (missing.length) {
      columns = columns.map((c) => (c.id === col.id ? { ...c, options: [...(c.options ?? []), ...missing] } : c))
      onProps({ ...props, columns })
    }
    void invoke('notes:update', { id: r.id, rowValues: { ...r.values, [col.id]: v } }).then(refresh)
  }
  const addRow = (values: Record<string, CellValue> = {}): void => void invoke('notes:addRow', { dbId, values, title: '' }).then(refresh)
  const colMenu = (col: PropDef): void => {
    const act = window.prompt(`"${col.name}" 열: 새 이름을 입력하세요. 지우려면 "삭제", 선택지를 바꾸려면 "선택지: 가,나,다"`, col.name)?.trim()
    if (!act) return
    if (act === '삭제') onProps({ ...props, columns: props.columns.filter((c) => c.id !== col.id), view: { ...view, filters: (view.filters ?? []).filter((f) => f.prop !== col.id), sort: view.sort?.prop === col.id ? null : view.sort } })
    else if (act.startsWith('선택지:'))
      onProps({
        ...props,
        columns: props.columns.map((c) =>
          c.id === col.id
            ? {
                ...c,
                options: act
                  .slice(4)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              }
            : c
        )
      })
    else onProps({ ...props, columns: props.columns.map((c) => (c.id === col.id ? { ...c, name: act.slice(0, 60) } : c)) })
  }
  const allProps = [{ id: 'title', name: '이름', type: 'text' as PropType }, ...props.columns]
  const selectCols = props.columns.filter((c) => c.type === 'select')

  return (
    <div className="space-y-2" data-testid="note-db">
      <div className="flex flex-wrap items-center gap-1.5 text-sm">
        <Button size="sm" variant={view.type === 'table' ? 'default' : 'outline'} onClick={() => setView({ type: 'table' })}>
          <Table2 /> 표
        </Button>
        <Button size="sm" variant={view.type === 'board' ? 'default' : 'outline'} disabled={!selectCols.length} onClick={() => setView({ type: 'board', groupBy: view.groupBy && selectCols.some((c) => c.id === view.groupBy) ? view.groupBy : selectCols[0]?.id })}>
          <Kanban /> 보드
        </Button>
        {view.type === 'board' && (
          <Select aria-label="묶을 열" className="h-8 w-32" value={view.groupBy ?? ''} onChange={(e) => setView({ groupBy: e.target.value })}>
            {selectCols.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <span className="mx-1 h-5 w-px bg-border" />
        <Select aria-label="정렬" className="h-8 w-36" value={view.sort ? `${view.sort.prop}:${view.sort.dir}` : ''} onChange={(e) => setView({ sort: e.target.value ? { prop: e.target.value.split(':')[0], dir: e.target.value.split(':')[1] as 'asc' | 'desc' } : null })}>
          <option value="">정렬 없음</option>
          {allProps.flatMap((p) => [
            <option key={`${p.id}a`} value={`${p.id}:asc`}>
              {p.name} ↑
            </option>,
            <option key={`${p.id}d`} value={`${p.id}:desc`}>
              {p.name} ↓
            </option>
          ])}
        </Select>
        <Button size="sm" variant="ghost" onClick={() => setView({ filters: [...(view.filters ?? []), { prop: 'title', op: 'contains', value: '' }] })}>
          <Filter /> 필터 추가
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setNewCol({ name: '', type: 'text' })}>
          <Plus /> 열 추가
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{rows.length}개</span>
      </div>
      {(view.filters ?? []).map((f, i) => {
        const set = (p: Partial<DbFilter>): void => setView({ filters: (view.filters ?? []).map((x, j) => (j === i ? { ...x, ...p } : x)) })
        const needs = OPS.find((o) => o.op === f.op)?.needs
        return (
          <div key={i} className="flex items-center gap-1.5 text-sm" data-testid="db-filter">
            <Select aria-label="필터 열" className="h-8 w-32" value={f.prop} onChange={(e) => set({ prop: e.target.value })}>
              {allProps.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label="필터 조건" className="h-8 w-32" value={f.op} onChange={(e) => set({ op: e.target.value as DbFilter['op'] })}>
              {OPS.map((o) => (
                <option key={o.op} value={o.op}>
                  {o.label}
                </option>
              ))}
            </Select>
            {needs && <Input aria-label="필터 값" className="h-8 w-40" value={f.value ?? ''} onChange={(e) => set({ value: e.target.value })} />}
            <Button size="icon-sm" variant="ghost" aria-label="필터 지우기" onClick={() => setView({ filters: (view.filters ?? []).filter((_x, j) => j !== i) })}>
              <X />
            </Button>
          </div>
        )
      })}
      {newCol && (
        <div className="flex items-center gap-1.5">
          <Input autoFocus aria-label="새 열 이름" className="h-8 w-40" placeholder="열 이름" value={newCol.name} onChange={(e) => setNewCol({ ...newCol, name: e.target.value })} />
          <Select aria-label="새 열 종류" className="h-8 w-28" value={newCol.type} onChange={(e) => setNewCol({ ...newCol, type: e.target.value as PropType })}>
            {(Object.keys(TYPE_LABEL) as PropType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABEL[t]}
              </option>
            ))}
          </Select>
          <Button
            size="sm"
            disabled={!newCol.name.trim()}
            onClick={() => {
              onProps({ ...props, columns: [...props.columns, { id: `c${Date.now().toString(36)}`, name: newCol.name.trim(), type: newCol.type, options: newCol.type === 'select' || newCol.type === 'multi' ? [] : undefined }] })
              setNewCol(null)
            }}
          >
            추가
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNewCol(null)}>
            취소
          </Button>
        </div>
      )}
      {view.type === 'table' ? (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr>
                <th className="min-w-48 px-2 py-1.5 text-left font-medium">이름</th>
                {props.columns.map((c) => (
                  <th key={c.id} className="min-w-28 px-2 py-1.5 text-left font-medium">
                    <button className="cursor-pointer hover:text-foreground" title="열 고치기" onClick={() => colMenu(c)}>
                      {c.name} <span className="opacity-60">· {TYPE_LABEL[c.type]}</span>
                    </button>
                  </th>
                ))}
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="group border-t border-border" data-testid="db-row">
                  <td className="px-2 py-0.5">
                    <span className="flex items-center gap-1">
                      <input
                        aria-label="이름"
                        className="h-7 w-full bg-transparent font-medium outline-none focus:bg-background"
                        defaultValue={r.title}
                        placeholder="제목 없음"
                        onBlur={(e) => e.target.value !== r.title && void invoke('notes:update', { id: r.id, title: e.target.value }).then(refresh)}
                      />
                      <button className="invisible shrink-0 cursor-pointer rounded border border-border px-1.5 text-xs group-hover:visible" onClick={() => onOpen(r.id)}>
                        열기
                      </button>
                    </span>
                  </td>
                  {props.columns.map((c) => (
                    <td key={c.id} className="px-2 py-0.5">
                      <Cell col={c} value={r.values[c.id] ?? null} onChange={(v) => setCell(r, c, v)} />
                    </td>
                  ))}
                  <td>
                    <button className="invisible cursor-pointer p-1 group-hover:visible" aria-label="행 삭제" onClick={() => void invoke('notes:toTrash', { id: r.id }).then(refresh)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="w-full cursor-pointer border-t border-border px-2 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted" onClick={() => addRow()}>
            + 새 행
          </button>
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2" data-testid="db-board">
          {boardGroups(rows, props).map((g) => {
            const col = props.columns.find((c) => c.id === view.groupBy)!
            return (
              <div
                key={g.key || '_none'}
                className="w-60 shrink-0 rounded-md bg-muted/50 p-2"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/x-note-row')
                  const r = rows.find((x) => x.id === id)
                  if (r) setCell(r, col, g.key || null)
                }}
              >
                <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold">
                  {g.key ? <span className={cn('rounded px-1.5', optClass(col, g.key))}>{g.key}</span> : <span className="text-muted-foreground">없음</span>}
                  <span className="text-muted-foreground">{g.rows.length}</span>
                </p>
                <div className="space-y-1.5">
                  {g.rows.map((r) => (
                    <button key={r.id} draggable onDragStart={(e) => e.dataTransfer.setData('text/x-note-row', r.id)} className="block w-full cursor-pointer rounded-md border border-border bg-card p-2 text-left text-sm shadow-sm hover:bg-muted" onClick={() => onOpen(r.id)} data-testid="db-card">
                      {r.icon} {r.title || '제목 없음'}
                    </button>
                  ))}
                  <button className="w-full cursor-pointer rounded px-2 py-1 text-left text-xs text-muted-foreground hover:bg-background" onClick={() => addRow(g.key ? { [col.id]: g.key } : {})}>
                    + 새 항목
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
