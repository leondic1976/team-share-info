import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { AlertTriangle, Folder, FolderPlus, Pencil, Sparkles, StickyNote, Tag, Trash2, X } from 'lucide-react'
import { TAG_COLORS, type TaggedItem } from '@shared/organize'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { confirmDialog } from '@renderer/components/Dialog'
import { EmptyState, EmptyNote } from '@renderer/components/EmptyState'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { FileIcon, TagChips, fmtSize, useCollections, useFileActions, useTags } from './common'
import { HitList } from './SearchTab'

type Sel = { kind: 'tag'; id: string } | { kind: 'col'; id: string } | { kind: 'smart'; id: string } | null

function ItemList({ items, notify, onRemove, removeLabel }: { items: TaggedItem[]; notify: (s: string) => void; onRemove?: (p: string) => void; removeLabel: string }): React.JSX.Element {
  const qc = useQueryClient()
  const act = useFileActions(notify)
  const tags = useTags()
  const colors = useMemo(() => Object.fromEntries((tags.data ?? []).map((t) => [t.name, t.color])), [tags.data])
  if (!items.length) return <EmptyState icon={Folder} title="비어 있습니다" description="내 파일·빠른 검색에서 파일을 골라 태그를 달거나 가상 폴더에 넣으세요." />
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="organize-items">
      {items.map((i) => (
        <div key={i.path} className="group flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-sm hover:bg-muted" onDoubleClick={() => i.exists && void act.open(i.path)} data-testid="organize-item">
          {i.exists ? <FileIcon name={i.name} dir={i.isDir} /> : <AlertTriangle className="size-4 shrink-0 text-amber-500" aria-label="찾을 수 없음" />}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className={cn('truncate font-medium', !i.exists && 'text-muted-foreground line-through')}>{i.name}</span>
              {!i.exists && <span className="shrink-0 text-xs text-amber-600">찾을 수 없음</span>}
              <TagChips tags={i.tags} colors={colors} />
            </span>
            <span className="block truncate text-xs text-muted-foreground">{i.path}</span>
            {i.note && <span className="block truncate text-xs">
                <StickyNote className="mr-1 inline size-3 align-[-0.1em]" aria-label="메모" />
                {i.note}
              </span>}
          </span>
          <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{i.exists && !i.isDir ? fmtSize(i.size) : ''}</span>
          <span className="w-28 shrink-0 text-right text-xs text-muted-foreground">{i.exists ? format(i.mtime, 'yyyy-MM-dd') : ''}</span>
          <div className="invisible flex group-hover:visible">
            {i.exists && (
              <Button size="sm" variant="ghost" onClick={() => act.reveal(i.path)}>
                폴더 열기
              </Button>
            )}
            <Button size="icon-sm" variant="ghost" aria-label="태그" onClick={() => act.tag([i.path])}>
              <Tag />
            </Button>
            {onRemove && (
              <Button size="icon-sm" variant="ghost" aria-label={removeLabel} title={removeLabel} onClick={() => onRemove(i.path)}>
                <X />
              </Button>
            )}
            {!i.exists && (
              <Button size="sm" variant="ghost" onClick={() => void invoke('org:forget', { path: i.path }).then(() => qc.invalidateQueries({ queryKey: ['local'] }))}>
                목록에서 빼기
              </Button>
            )}
          </div>
        </div>
      ))}
      {act.dialogs}
    </div>
  )
}

/** Logical organization: tags, virtual folders and smart folders (6.18 ③). */
export function OrganizeTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const tags = useTags()
  const cols = useCollections()
  const smart = useQuery({ queryKey: ['local', 'smart'], queryFn: () => invoke('org:smart'), networkMode: 'always' })
  const [sel, setSel] = useState<Sel>(null)
  const [newCol, setNewCol] = useState<{ parentId: string | null; name: string } | null>(null)
  const [editCol, setEditCol] = useState<{ id: string; name: string; note: string } | null>(null)
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local'] })

  const items = useQuery({
    queryKey: ['local', 'organize-items', sel?.kind, sel?.id],
    queryFn: () => (sel?.kind === 'tag' ? invoke('org:tagged', { tag: sel.id }) : invoke('org:collectionItems', { id: sel!.id })),
    enabled: sel?.kind === 'tag' || sel?.kind === 'col',
    networkMode: 'always',
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const smartHits = useQuery({ queryKey: ['local', 'smart-run', sel?.id], queryFn: () => invoke('org:runSmart', { id: sel!.id }), enabled: sel?.kind === 'smart', networkMode: 'always', staleTime: 0, refetchOnMount: 'always' })

  const children = (pid: string | null): typeof cols.data => (cols.data ?? []).filter((c) => c.parentId === pid)
  const renderCols = (pid: string | null, depth: number): React.ReactNode =>
    children(pid)?.map((c) => (
      <div key={c.id}>
        <div className={cn('group flex items-center gap-1.5 rounded py-1 pr-1 text-sm hover:bg-muted', sel?.kind === 'col' && sel.id === c.id && 'bg-primary/10 text-primary')} style={{ paddingLeft: 8 + depth * 14 }}>
          <button className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left" onClick={() => setSel({ kind: 'col', id: c.id })}>
            <Folder className="size-4 shrink-0 text-primary" /> <span className="truncate">{c.name}</span>
            <span className="ml-auto text-xs text-muted-foreground">{c.count}</span>
          </button>
          <button className="invisible cursor-pointer rounded p-0.5 hover:bg-background group-hover:visible" aria-label={`${c.name} 아래에 만들기`} onClick={() => setNewCol({ parentId: c.id, name: '' })}>
            <FolderPlus className="size-3.5" />
          </button>
          <button className="invisible cursor-pointer rounded p-0.5 hover:bg-background group-hover:visible" aria-label={`${c.name} 고치기`} onClick={() => setEditCol({ id: c.id, name: c.name, note: c.note })}>
            <Pencil className="size-3.5" />
          </button>
        </div>
        {renderCols(c.id, depth + 1)}
      </div>
    ))

  const selTag = sel?.kind === 'tag' ? tags.data?.find((t) => t.name === sel.id) : null
  const selCol = sel?.kind === 'col' ? cols.data?.find((c) => c.id === sel.id) : null
  const selSmart = sel?.kind === 'smart' ? smart.data?.find((s) => s.id === sel.id) : null

  return (
    <div className="flex min-h-0 flex-1">
      <aside className="w-64 shrink-0 space-y-4 overflow-y-auto border-r border-border p-2">
        <section>
          <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">태그</p>
          {(tags.data ?? []).map((t) => (
            <button key={t.name} className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted', sel?.kind === 'tag' && sel.id === t.name && 'bg-primary/10')} onClick={() => setSel({ kind: 'tag', id: t.name })}>
              <span className="size-2.5 rounded-full" style={{ background: t.color }} /> <span className="truncate">{t.name}</span>
              <span className="ml-auto text-xs text-muted-foreground">{t.count}</span>
            </button>
          ))}
          {!tags.data?.length && <EmptyNote>아직 태그가 없습니다.</EmptyNote>}
        </section>
        <section>
          <div className="mb-1 flex items-center px-2">
            <p className="text-xs font-semibold text-muted-foreground">가상 폴더</p>
            <button className="ml-auto cursor-pointer rounded p-0.5 hover:bg-muted" aria-label="새 가상 폴더" onClick={() => setNewCol({ parentId: null, name: '' })}>
              <FolderPlus className="size-4" />
            </button>
          </div>
          {renderCols(null, 0)}
          {newCol && (
            <div className="flex gap-1 px-2 py-1">
              <Input
                autoFocus
                aria-label="가상 폴더 이름"
                className="h-7"
                value={newCol.name}
                onChange={(e) => setNewCol({ ...newCol, name: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNewCol(null)
                  if (e.key === 'Enter' && newCol.name.trim())
                    void invoke('org:saveCollection', { name: newCol.name.trim(), parentId: newCol.parentId }).then((id) => {
                      setNewCol(null)
                      setSel({ kind: 'col', id })
                      refresh()
                    })
                }}
                placeholder="이름 입력 후 Enter"
              />
            </div>
          )}
        </section>
        <section>
          <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">스마트 폴더</p>
          {(smart.data ?? []).map((s) => (
            <button key={s.id} className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-muted', sel?.kind === 'smart' && sel.id === s.id && 'bg-primary/10')} onClick={() => setSel({ kind: 'smart', id: s.id })}>
              <Sparkles className="size-4 shrink-0 text-purple-500" /> <span className="truncate">{s.name}</span>
            </button>
          ))}
          {!smart.data?.length && <p className="px-2 text-xs text-muted-foreground">빠른 검색에서 조건을 정하고 "스마트 폴더로 저장"을 누르세요.</p>}
        </section>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {!sel && <EmptyState icon={Tag} title="태그·가상 폴더·스마트 폴더를 고르세요" description="파일을 옮기지 않고 주제별로 모아 봅니다. 정리 정보는 이 PC에만 저장됩니다." />}
        {selTag && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <span className="size-3 rounded-full" style={{ background: selTag.color }} />
              <h2 className="font-semibold">#{selTag.name}</h2>
              <div className="ml-2 flex gap-1">
                {TAG_COLORS.map((c) => (
                  <button key={c} aria-label={`색 ${c}`} className="size-4 cursor-pointer rounded-full" style={{ background: c }} onClick={() => void invoke('org:updateTag', { name: selTag.name, color: c }).then(refresh)} />
                ))}
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  const n = window.prompt('새 태그 이름', selTag.name)?.trim()
                  if (n && n !== selTag.name) void invoke('org:updateTag', { name: selTag.name, newName: n }).then(() => (setSel({ kind: 'tag', id: n }), refresh()))
                }}
              >
                이름 바꾸기
              </Button>
              <Button size="sm" variant="ghost" onClick={() => confirmDialog(`태그 "${selTag.name}"을(를) 지울까요? (파일은 그대로)`) && void invoke('org:deleteTag', { name: selTag.name }).then(() => (setSel(null), refresh()))}>
                <Trash2 /> 태그 삭제
              </Button>
            </div>
            <ItemList items={items.data ?? []} notify={notify} removeLabel="태그 빼기" onRemove={(p) => void invoke('org:tagsOf', { paths: [p] }).then((r) => invoke('org:setTags', { path: p, tags: (r[p] ?? []).filter((t) => t !== selTag.name) })).then(refresh)} />
          </>
        )}
        {selCol && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Folder className="size-4 text-primary" />
              <h2 className="font-semibold">{selCol.name}</h2>
              {selCol.note && <span className="truncate text-xs text-muted-foreground">{selCol.note}</span>}
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditCol({ id: selCol.id, name: selCol.name, note: selCol.note })}>
                <Pencil /> 고치기
              </Button>
              <Button size="sm" variant="ghost" onClick={() => confirmDialog(`가상 폴더 "${selCol.name}"과(와) 하위 묶음을 지울까요? (실제 파일은 그대로)`) && void invoke('org:deleteCollection', { id: selCol.id }).then(() => (setSel(null), refresh()))}>
                <Trash2 /> 삭제
              </Button>
            </div>
            <ItemList items={items.data ?? []} notify={notify} removeLabel="가상 폴더에서 빼기" onRemove={(p) => void invoke('org:removeFromCollection', { id: selCol.id, path: p }).then(refresh)} />
          </>
        )}
        {selSmart && (
          <>
            <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
              <Sparkles className="size-4 text-purple-500" />
              <h2 className="font-semibold">{selSmart.name}</h2>
              <span className="text-xs text-muted-foreground">{smartHits.data?.length ?? 0}개</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => confirmDialog('이 스마트 폴더를 지울까요?') && void invoke('org:deleteSmart', { id: selSmart.id }).then(() => (setSel(null), refresh()))}>
                <Trash2 /> 삭제
              </Button>
            </div>
            <HitList hits={smartHits.data ?? []} notify={notify} />
          </>
        )}
      </div>
      {editCol && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onMouseDown={(e) => e.target === e.currentTarget && setEditCol(null)}>
          <div className="w-96 space-y-2 rounded-xl bg-card p-4 shadow-xl" role="dialog" aria-label="가상 폴더 고치기">
            <Input aria-label="가상 폴더 이름" value={editCol.name} onChange={(e) => setEditCol({ ...editCol, name: e.target.value })} />
            <Input aria-label="메모" placeholder="메모" value={editCol.note} onChange={(e) => setEditCol({ ...editCol, note: e.target.value })} />
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditCol(null)}>
                취소
              </Button>
              <Button
                disabled={!editCol.name.trim()}
                onClick={() =>
                  void invoke('org:saveCollection', { id: editCol.id, name: editCol.name.trim(), note: editCol.note, parentId: cols.data?.find((c) => c.id === editCol.id)?.parentId ?? null }).then(() => {
                    setEditCol(null)
                    refresh()
                  })
                }
              >
                저장
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
