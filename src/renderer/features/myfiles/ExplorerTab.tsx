import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { ArrowLeft, ArrowRight, ArrowUp, ClipboardPaste, Copy, Eye, EyeOff, FolderPlus, HardDrive, Info, Pencil, Pin, PinOff, RefreshCw, Scissors, Search, Star, Tag, Trash2, FolderInput, ExternalLink, Clock } from 'lucide-react'
import type { IpcRes } from '@shared/ipc'
import { CATEGORY_LABEL, categoryOf, crumbs, parentOf, type FmEntry } from '@shared/fm'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { FileIcon, TagChips, fmtSize, useFileActions, useTags } from './common'

type SortKey = 'name' | 'mtime' | 'size' | 'kind'
const DRAG_TYPE = 'application/x-teamhub-paths'

/** In-app file explorer (6.18 ①). */
export function ExplorerTab({ notify, onSearchHere }: { notify: (s: string) => void; onSearchHere: (dir: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const placesQ = useQuery({ queryKey: ['local', 'fm-places'], queryFn: () => invoke('fm:places'), networkMode: 'always' })
  const recentQ = useQuery({ queryKey: ['local', 'fm-recent'], queryFn: () => invoke('fm:recent'), networkMode: 'always' })
  const tags = useTags()
  const tagColors = useMemo(() => Object.fromEntries((tags.data ?? []).map((t) => [t.name, t.color])), [tags.data])
  const [path, setPath] = useState<string | null>(null)
  const [hist, setHist] = useState<{ back: string[]; fwd: string[] }>({ back: [], fwd: [] })
  const [hidden, setHidden] = useState(false)
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: 'name', asc: true })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [clip, setClip] = useState<{ paths: string[]; move: boolean } | null>(null)
  const [editPath, setEditPath] = useState<string | null>(null)
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null)
  const [props, setProps] = useState<IpcRes<'fm:props'>>(null)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const act = useFileActions(notify)

  useEffect(() => {
    if (!path && placesQ.data?.length) setPath(placesQ.data.find((p) => p.kind === 'known')?.path ?? placesQ.data[0].path)
  }, [path, placesQ.data])

  const dir = useQuery({ queryKey: ['local', 'fm-list', path, hidden], queryFn: () => invoke('fm:list', { path: path!, showHidden: hidden }), enabled: !!path, networkMode: 'always' })
  const entries = useMemo(() => {
    const list = [...(dir.data?.entries ?? [])]
    const k = sort.key
    list.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      const c = k === 'name' ? a.name.localeCompare(b.name, 'ko', { numeric: true }) : k === 'mtime' ? a.mtime - b.mtime : k === 'size' ? a.size - b.size : a.ext.localeCompare(b.ext) || a.name.localeCompare(b.name, 'ko')
      return sort.asc ? c : -c
    })
    return list
  }, [dir.data, sort])
  const tagMap = useQuery({ queryKey: ['local', 'fm-tags', path, entries.length], queryFn: () => invoke('org:tagsOf', { paths: entries.map((e) => e.path) }), enabled: entries.length > 0, networkMode: 'always' })
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['local', 'fm-list'] })
    void qc.invalidateQueries({ queryKey: ['local', 'fm-places'] })
  }, [qc])

  const go = (p: string, record = true): void => {
    if (record && path) setHist({ back: [...hist.back, path], fwd: [] })
    setPath(p)
    setSel(new Set())
    setEditPath(null)
  }
  const back = (): void => {
    const b = hist.back[hist.back.length - 1]
    if (!b || !path) return
    setHist({ back: hist.back.slice(0, -1), fwd: [path, ...hist.fwd] })
    go(b, false)
  }
  const fwd = (): void => {
    const f = hist.fwd[0]
    if (!f || !path) return
    setHist({ back: [...hist.back, path], fwd: hist.fwd.slice(1) })
    go(f, false)
  }
  const selected = entries.filter((e) => sel.has(e.path))
  const pinned = placesQ.data?.some((p) => p.kind === 'pin' && p.path.toLowerCase() === path?.toLowerCase())

  const openEntry = (e: FmEntry): void => {
    if (e.dir) go(e.path)
    else void act.open(e.path)
  }
  const click = (e: React.MouseEvent, en: FmEntry): void => {
    if (e.shiftKey && anchor) {
      const i = entries.findIndex((x) => x.path === anchor)
      const j = entries.findIndex((x) => x.path === en.path)
      const [a, b] = i < j ? [i, j] : [j, i]
      setSel(new Set(entries.slice(a, b + 1).map((x) => x.path)))
    } else if (e.ctrlKey) {
      const n = new Set(sel)
      if (n.has(en.path)) n.delete(en.path)
      else n.add(en.path)
      setSel(n)
      setAnchor(en.path)
    } else {
      setSel(new Set([en.path]))
      setAnchor(en.path)
    }
  }
  const result = (r: { ok: boolean; error?: string; done?: number }, ok: string): void => {
    notify(r.ok ? ok : (r.error ?? '실패했습니다.'))
    refresh()
  }
  const mkdir = async (): Promise<void> => {
    if (!path) return
    const r = await invoke('fm:mkdir', { parent: path, name: '새 폴더' })
    result(r, '새 폴더를 만들었습니다.')
    if (r.ok && r.paths?.[0]) setRenaming({ path: r.paths[0], name: r.paths[0].replace(/^.*\\/, '') })
  }
  const trash = async (paths: string[]): Promise<void> => {
    if (!paths.length || !confirmDialog(`${paths.length}개 항목을 휴지통으로 옮길까요? (휴지통에서 되살릴 수 있습니다)`)) return
    result(await invoke('fm:trash', { paths }), `${paths.length}개를 휴지통으로 옮겼습니다.`)
    setSel(new Set())
  }
  const paste = async (dest = path): Promise<void> => {
    if (!clip || !dest) return
    const r = await invoke('fm:transfer', { paths: clip.paths, dest, move: clip.move })
    result(r, `${r.done ?? 0}개를 ${clip.move ? '옮겼' : '복사했'}습니다.`)
    if (clip.move) setClip(null)
  }
  const drop = async (e: React.DragEvent, dest: string): Promise<void> => {
    e.preventDefault()
    setDropTarget(null)
    const internal = e.dataTransfer.getData(DRAG_TYPE)
    const paths = internal ? (JSON.parse(internal) as string[]) : [...e.dataTransfer.files].map((f) => window.teamhub.pathForFile(f)).filter(Boolean)
    if (!paths.length || paths.some((p) => p.toLowerCase() === dest.toLowerCase())) return
    const move = !!internal && !e.ctrlKey
    const r = await invoke('fm:transfer', { paths, dest, move })
    result(r, `${r.done ?? 0}개를 ${move ? '옮겼' : '복사했'}습니다.`)
  }

  const onKey = (e: React.KeyboardEvent): void => {
    if (renaming || editPath !== null) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT') return
    if (e.key === 'Delete') void trash([...sel])
    else if (e.key === 'F2' && selected.length === 1) setRenaming({ path: selected[0].path, name: selected[0].name })
    else if (e.key === 'Enter' && selected.length === 1) openEntry(selected[0])
    else if (e.key === 'Backspace') {
      const p = path && parentOf(path)
      if (p) go(p)
    } else if (e.ctrlKey && e.key.toLowerCase() === 'c' && sel.size) setClip({ paths: [...sel], move: false })
    else if (e.ctrlKey && e.key.toLowerCase() === 'x' && sel.size) setClip({ paths: [...sel], move: true })
    else if (e.ctrlKey && e.key.toLowerCase() === 'v') void paste()
    else if (e.ctrlKey && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setSel(new Set(entries.map((x) => x.path)))
    } else return
    e.preventDefault()
  }

  const SortBtn = ({ k, label, className }: { k: SortKey; label: string; className?: string }): React.JSX.Element => (
    <button className={cn('cursor-pointer text-left hover:text-foreground', className)} onClick={() => setSort({ key: k, asc: sort.key === k ? !sort.asc : true })}>
      {label} {sort.key === k ? (sort.asc ? '▲' : '▼') : ''}
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1" onKeyDown={onKey}>
      <aside className="w-52 shrink-0 overflow-y-auto border-r border-border p-2 text-sm">
        {(['known', 'pin', 'drive'] as const).map((k) => {
          const list = (placesQ.data ?? []).filter((p) => p.kind === k)
          if (!list.length) return null
          return (
            <div key={k} className="mb-3">
              <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">{k === 'known' ? '바로 가기' : k === 'pin' ? '고정한 폴더' : '드라이브'}</p>
              {list.map((p) => (
                <button
                  key={p.path}
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted', path === p.path && 'bg-primary/10 text-primary', dropTarget === p.path && 'ring-2 ring-primary')}
                  onClick={() => go(p.path)}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDropTarget(p.path)
                  }}
                  onDragLeave={() => setDropTarget(null)}
                  onDrop={(e) => void drop(e, p.path)}
                  title={p.path}
                >
                  {k === 'drive' ? <HardDrive className="size-4 shrink-0" /> : k === 'pin' ? <Star className="size-4 shrink-0 text-amber-500" /> : <FileIcon name="" dir />}
                  <span className="truncate">{p.name}</span>
                </button>
              ))}
            </div>
          )
        })}
        {!!recentQ.data?.length && (
          <div>
            <p className="mb-1 px-2 text-xs font-semibold text-muted-foreground">최근 간 폴더</p>
            {recentQ.data.slice(0, 8).map((p) => (
              <button key={p} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs hover:bg-muted" onClick={() => go(p)} title={p}>
                <Clock className="size-3.5 shrink-0" /> <span className="truncate">{p.replace(/^.*\\/, '') || p}</span>
              </button>
            ))}
          </div>
        )}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1.5">
          <Button size="icon-sm" variant="ghost" aria-label="뒤로" disabled={!hist.back.length} onClick={back}>
            <ArrowLeft />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="앞으로" disabled={!hist.fwd.length} onClick={fwd}>
            <ArrowRight />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="위로" disabled={!path || !parentOf(path)} onClick={() => path && parentOf(path) && go(parentOf(path)!)}>
            <ArrowUp />
          </Button>
          {editPath !== null ? (
            <Input
              autoFocus
              aria-label="경로"
              className="h-8 flex-1"
              value={editPath}
              onChange={(e) => setEditPath(e.target.value)}
              onBlur={() => setEditPath(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && editPath.trim()) go(editPath.trim())
                if (e.key === 'Escape') setEditPath(null)
              }}
            />
          ) : (
            <div className="flex h-8 min-w-0 flex-1 cursor-text items-center gap-0.5 overflow-x-auto rounded-md border border-input px-1.5 text-sm" onClick={() => setEditPath(path ?? '')} data-testid="fm-crumbs">
              {path &&
                crumbs(path).map((c, i) => (
                  <span key={c.path} className="flex shrink-0 items-center">
                    {i > 0 && <span className="px-0.5 text-muted-foreground">›</span>}
                    <button
                      className="cursor-pointer rounded px-1 hover:bg-muted"
                      onClick={(e) => {
                        e.stopPropagation()
                        go(c.path)
                      }}
                    >
                      {c.name}
                    </button>
                  </span>
                ))}
            </div>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={pinned ? '고정 해제' : '이 폴더 고정'} title={pinned ? '고정 해제' : '이 폴더 고정'} onClick={() => path && void invoke('fm:pin', { path, on: !pinned }).then(refresh)}>
            {pinned ? <PinOff /> : <Pin />}
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="이 폴더에서 찾기" title="이 폴더에서 찾기" onClick={() => path && onSearchHere(path)}>
            <Search />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="새로 고침" onClick={refresh}>
            <RefreshCw />
          </Button>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-1.5">
          <Button size="sm" variant="outline" onClick={() => void mkdir()}>
            <FolderPlus /> 새 폴더
          </Button>
          <Button size="sm" variant="ghost" disabled={selected.length !== 1} onClick={() => setRenaming({ path: selected[0].path, name: selected[0].name })}>
            <Pencil /> 이름 바꾸기
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => setClip({ paths: [...sel], move: false })}>
            <Copy /> 복사
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => setClip({ paths: [...sel], move: true })}>
            <Scissors /> 잘라내기
          </Button>
          <Button size="sm" variant="ghost" disabled={!clip} onClick={() => void paste()}>
            <ClipboardPaste /> 붙여넣기{clip ? ` (${clip.paths.length})` : ''}
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => void trash([...sel])}>
            <Trash2 /> 휴지통으로
          </Button>
          <span className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => act.tag([...sel])}>
            <Tag /> 태그
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.size} onClick={() => act.collect([...sel])}>
            <FolderInput /> 가상 폴더에
          </Button>
          <Button size="sm" variant="ghost" disabled={selected.length !== 1} onClick={() => void invoke('fm:props', { path: selected[0].path }).then(setProps)}>
            <Info /> 속성
          </Button>
          <Button size="sm" variant="ghost" disabled={!sel.size && !path} onClick={() => act.copyPath(sel.size ? [...sel] : [path!])}>
            경로 복사
          </Button>
          <Button size="sm" variant="ghost" disabled={!path} onClick={() => act.reveal(selected[0]?.path ?? path!)}>
            <ExternalLink /> 탐색기
          </Button>
          <Button size="sm" variant="ghost" className="ml-auto" aria-pressed={hidden} onClick={() => setHidden(!hidden)}>
            {hidden ? <Eye /> : <EyeOff />} 숨김 파일
          </Button>
        </div>
        <div
          ref={listRef}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-y-auto outline-none"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => path && void drop(e, path)}
          data-testid="fm-list"
        >
          {dir.data?.error ? (
            <p className="p-6 text-sm text-urgent">{dir.data.error}</p>
          ) : (
            <table className="w-full table-fixed text-sm">
              <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-3 py-1.5 text-left font-medium">
                    <SortBtn k="name" label="이름" />
                  </th>
                  <th className="w-40 px-2 py-1.5 text-left font-medium">
                    <SortBtn k="mtime" label="수정한 날짜" />
                  </th>
                  <th className="w-20 px-2 py-1.5 text-left font-medium">
                    <SortBtn k="kind" label="종류" />
                  </th>
                  <th className="w-24 px-2 py-1.5 text-right font-medium">
                    <SortBtn k="size" label="크기" className="w-full text-right" />
                  </th>
                </tr>
              </thead>
              <tbody>
                {entries.map((en) => (
                  <tr
                    key={en.path}
                    className={cn('cursor-default border-b border-border/50 hover:bg-muted', sel.has(en.path) && 'bg-primary/10', en.hidden && 'opacity-60', dropTarget === en.path && 'outline-2 outline-primary')}
                    onClick={(e) => click(e, en)}
                    onDoubleClick={() => openEntry(en)}
                    draggable
                    onDragStart={(e) => {
                      const paths = sel.has(en.path) ? [...sel] : [en.path]
                      e.dataTransfer.setData(DRAG_TYPE, JSON.stringify(paths))
                      e.dataTransfer.effectAllowed = 'copyMove'
                    }}
                    onDragOver={(e) => {
                      if (!en.dir) return
                      e.preventDefault()
                      e.stopPropagation()
                      setDropTarget(en.path)
                    }}
                    onDragLeave={() => setDropTarget(null)}
                    onDrop={(e) => {
                      if (!en.dir) return
                      e.stopPropagation()
                      void drop(e, en.path)
                    }}
                    data-testid="fm-entry"
                    data-name={en.name}
                  >
                    <td className="px-3 py-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <FileIcon name={en.name} dir={en.dir} />
                        {renaming?.path === en.path ? (
                          <Input
                            autoFocus
                            aria-label="새 이름"
                            className="h-7"
                            value={renaming.name}
                            onClick={(e) => e.stopPropagation()}
                            onFocus={(e) => {
                              const dot = renaming.name.lastIndexOf('.')
                              e.target.setSelectionRange(0, en.dir || dot <= 0 ? renaming.name.length : dot)
                            }}
                            onChange={(e) => setRenaming({ ...renaming, name: e.target.value })}
                            onKeyDown={(e) => {
                              e.stopPropagation()
                              if (e.key === 'Escape') setRenaming(null)
                              if (e.key === 'Enter') {
                                const r = renaming
                                setRenaming(null)
                                if (r.name !== en.name) void invoke('fm:rename', { path: r.path, name: r.name }).then((x) => result(x, '이름을 바꿨습니다.'))
                              }
                            }}
                            onBlur={() => setRenaming(null)}
                          />
                        ) : (
                          <span className="truncate">{en.name}</span>
                        )}
                        <TagChips tags={tagMap.data?.[en.path] ?? []} colors={tagColors} />
                      </span>
                    </td>
                    <td className="px-2 py-1 text-xs text-muted-foreground">{format(en.mtime, 'yyyy-MM-dd HH:mm')}</td>
                    <td className="truncate px-2 py-1 text-xs text-muted-foreground">{en.dir ? '폴더' : `${CATEGORY_LABEL[categoryOf(en.name)]}${en.ext ? ` .${en.ext}` : ''}`}</td>
                    <td className="px-2 py-1 text-right text-xs text-muted-foreground">{en.dir ? '' : fmtSize(en.size)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {dir.data && !dir.data.error && !entries.length && <p className="p-6 text-center text-sm text-muted-foreground">빈 폴더입니다.</p>}
        </div>
        <div className="shrink-0 border-t border-border px-3 py-1 text-xs text-muted-foreground">
          {entries.length}개 항목{sel.size ? ` · ${sel.size}개 선택 (${fmtSize(selected.reduce((s, e) => s + e.size, 0))})` : ''} · 더블클릭: 열기 · F2: 이름 바꾸기 · Delete: 휴지통 · Ctrl+C/X/V · 끌어 놓기로 옮기기(Ctrl: 복사)
        </div>
      </div>
      <Dialog open={!!props} onClose={() => setProps(null)} title="속성">
        {props && (
          <div className="space-y-1 text-sm">
            <p className="break-all">위치: {props.path}</p>
            <p>크기: {fmtSize(props.size)}</p>
            {props.dir && (
              <p>
                파일 {props.files.toLocaleString()}개 · 폴더 {props.folders.toLocaleString()}개
              </p>
            )}
            <p>만든 날짜: {format(props.created, 'yyyy-MM-dd HH:mm')}</p>
            <p>수정한 날짜: {format(props.modified, 'yyyy-MM-dd HH:mm')}</p>
          </div>
        )}
      </Dialog>
      {act.dialogs}
    </div>
  )
}
