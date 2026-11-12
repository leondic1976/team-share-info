import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronUp, Download, Globe, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react'
import { PRESET_BOOKMARKS, type BookmarkDto, type BookmarkInput } from '@shared/organize'
import { Button } from '@renderer/components/ui/button'
import { Input, Label, Textarea } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState } from '@renderer/components/EmptyState'
import { invoke } from '@renderer/lib/bridge'
import { errorMessage } from '@renderer/lib/api'

export const useBookmarks = () => useQuery({ queryKey: ['local', 'bookmarks'], queryFn: () => invoke('bm:list'), networkMode: 'always' })

/** Personal site collection (6.18 ④). */
export function BookmarksTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const bm = useBookmarks()
  const [q, setQ] = useState('')
  const [edit, setEdit] = useState<Partial<BookmarkInput> | null>(null)
  const [err, setErr] = useState('')
  const [presets, setPresets] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState(false)
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local', 'bookmarks'] })
  const list = (bm.data ?? []).filter((b) => !q.trim() || `${b.title} ${b.url} ${b.category} ${b.note}`.toLowerCase().includes(q.trim().toLowerCase()))
  const groups = useMemo(() => {
    const m = new Map<string, BookmarkDto[]>()
    for (const b of list) m.set(b.category, [...(m.get(b.category) ?? []), b])
    return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'ko')))
  }, [list])
  const cats = [...new Set((bm.data ?? []).map((b) => b.category).filter(Boolean))]
  const have = new Set((bm.data ?? []).map((b) => b.url))
  const move = (g: BookmarkDto[], i: number, d: -1 | 1): void => {
    const ids = g.map((x) => x.id)
    const j = i + d
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void invoke('bm:reorder', { ids }).then(refresh)
  }
  const save = async (): Promise<void> => {
    try {
      await invoke('bm:save', { id: edit?.id, title: edit?.title ?? '', url: edit?.url ?? '', category: edit?.category ?? '', note: edit?.note ?? '' })
      setEdit(null)
      refresh()
    } catch (e) {
      setErr(errorMessage(e).includes('invalid') ? '이름과 http(s):// 주소를 확인하세요.' : errorMessage(e))
    }
  }
  const importBrowser = async (browser: 'chrome' | 'edge' | 'whale'): Promise<void> => {
    const r = await invoke('bm:importBrowser', { browser })
    notify(r.ok ? `${r.count}개를 가져왔습니다(이미 있는 주소 제외).` : (r.error ?? '가져오지 못했습니다.'))
    refresh()
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="bookmarks">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" aria-label="사이트 검색" placeholder="이름·주소·분류" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Button size="sm" onClick={() => (setErr(''), setEdit({ url: 'https://', category: '' }))}>
          <Plus /> 사이트 추가
        </Button>
        <Button size="sm" variant="outline" onClick={() => (setPicked(new Set()), setPresets(true))}>
          주요 사이트 목록에서 고르기
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void importBrowser('chrome')}>
          <Download /> Chrome에서
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void importBrowser('edge')}>
          <Download /> Edge에서
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void importBrowser('whale')}>
          <Download /> 웨일에서
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('bm:importHtml').then((r) => (r.ok && notify(`${r.count}개를 가져왔습니다.`), refresh()))}>
          <Download /> HTML 가져오기
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void invoke('bm:exportHtml').then((r) => r.ok && notify(`내보냈습니다: ${r.path}`))}>
          <Upload /> HTML 내보내기
        </Button>
        <Button size="sm" variant={editing ? 'default' : 'ghost'} onClick={() => setEditing(!editing)}>
          <Pencil /> {editing ? '편집 완료' : '편집'}
        </Button>
      </div>
      {!bm.data?.length && <EmptyState icon={Globe} title="사이트 모음이 비어 있습니다" description="주요 사이트 목록에서 고르거나 브라우저 즐겨찾기를 가져오세요." />}
      {groups.map(([c, g]) => (
        <section key={c || '_'} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{c || '분류 없음'}</h3>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {g.map((b, i) => (
              <div key={b.id} className="group flex items-center gap-2 rounded-md border border-border px-3 py-2" data-testid="bookmark">
                <Globe className="size-4 shrink-0 text-primary" />
                <button className="min-w-0 flex-1 cursor-pointer text-left" title={b.url} onClick={() => void invoke('bm:open', { url: b.url })}>
                  <span className="block truncate text-sm font-medium">{b.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{b.note || b.url.replace(/^https?:\/\//, '')}</span>
                </button>
                {editing && (
                  <div className="flex">
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${b.title} 위로`} onClick={() => move(g, i, -1)}>
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${b.title} 아래로`} onClick={() => move(g, i, 1)}>
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${b.title} 고치기`} onClick={() => (setErr(''), setEdit(b))}>
                      <Pencil className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${b.title} 삭제`} onClick={() => confirmDialog(`"${b.title}"을(를) 지울까요?`) && void invoke('bm:delete', { id: b.id }).then(refresh)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      <Dialog open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? '사이트 고치기' : '사이트 추가'} footer={<Button onClick={() => void save()}>저장</Button>}>
        <div className="space-y-2">
          <Label htmlFor="bm-title">이름</Label>
          <Input id="bm-title" maxLength={100} value={edit?.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <Label htmlFor="bm-url">주소</Label>
          <Input id="bm-url" value={edit?.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} />
          <Label htmlFor="bm-cat">분류</Label>
          <Input id="bm-cat" list="bm-cats" maxLength={30} value={edit?.category ?? ''} onChange={(e) => setEdit({ ...edit, category: e.target.value })} />
          <datalist id="bm-cats">
            {cats.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <Label htmlFor="bm-note">메모</Label>
          <Textarea id="bm-note" rows={2} maxLength={500} value={edit?.note ?? ''} onChange={(e) => setEdit({ ...edit, note: e.target.value })} />
          {err && <p className="text-sm text-urgent">{err}</p>}
        </div>
      </Dialog>
      <Dialog
        open={presets}
        onClose={() => setPresets(false)}
        title="주요 사이트 고르기"
        width="max-w-2xl"
        footer={
          <Button
            disabled={!picked.size}
            onClick={() =>
              void invoke('bm:import', { items: PRESET_BOOKMARKS.filter((p) => picked.has(p.url)) }).then((n) => {
                setPresets(false)
                notify(`${n}개를 추가했습니다.`)
                refresh()
              })
            }
          >
            {picked.size}개 추가
          </Button>
        }
      >
        {[...new Set(PRESET_BOOKMARKS.map((p) => p.category))].map((c) => (
          <div key={c} className="mb-3">
            <p className="mb-1 text-sm font-semibold">{c}</p>
            <div className="grid grid-cols-2 gap-1">
              {PRESET_BOOKMARKS.filter((p) => p.category === c).map((p) => (
                <label key={p.url} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                  <input
                    type="checkbox"
                    disabled={have.has(p.url)}
                    checked={have.has(p.url) || picked.has(p.url)}
                    onChange={(e) => setPicked((s) => (e.target.checked ? new Set([...s, p.url]) : new Set([...s].filter((x) => x !== p.url))))}
                    aria-label={p.title}
                  />
                  {p.title}
                  <span className="truncate text-xs text-muted-foreground">{p.url.replace(/^https:\/\//, '')}</span>
                </label>
              ))}
            </div>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">폐쇄망(업무망)에서는 열리지 않는 사이트가 있습니다.</p>
      </Dialog>
    </div>
  )
}
