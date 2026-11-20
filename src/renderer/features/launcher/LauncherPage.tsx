import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { AppWindow, ChevronDown, ChevronUp, FileText, Folder, FolderOpen, Globe, History, Pencil, Pin, PinOff, Plus, RefreshCw, Rocket, Search, Trash2, Users, Zap } from 'lucide-react'
import type { LauncherInput, LauncherItemDto, RecentDocDto, TeamLauncherDto } from '@shared/schemas/launcher'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Label, Select } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState, OfflineState } from '@renderer/components/EmptyState'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { useLocalQuery } from '@renderer/features/memos/tools-api'
import { BookmarksTab } from './BookmarksTab'

export function AppIcon({ path, kind, className }: { path: string; kind: string; className?: string }): React.JSX.Element {
  const q = useQuery({ queryKey: ['local', 'icon', path], queryFn: () => invoke('launcher:icon', { path }), enabled: kind !== 'url' && kind !== 'template', staleTime: Infinity, networkMode: 'always' })
  if (q.data) return <img src={q.data} alt="" className={cn('size-8', className)} />
  const Icon = kind === 'url' ? Globe : kind === 'template' ? FileText : kind === 'path' ? Folder : AppWindow
  return <Icon className={cn('size-8 text-muted-foreground', className)} />
}

export const usePersonalLauncher = () => useLocalQuery(['launcher'], () => invoke('launcher:list'), ['launcher:changed'])
export function useTeamLauncher() {
  const online = useConn((s) => s.state === 'online')
  return useQuery({ queryKey: ['launcher', 'team'], queryFn: () => api.get<TeamLauncherDto[]>('/api/launcher'), enabled: online })
}

function groupBy<T extends { groupName: string }>(items: T[]): [string, T[]][] {
  const m = new Map<string, T[]>()
  for (const i of items) m.set(i.groupName, [...(m.get(i.groupName) ?? []), i])
  return [...m.entries()].sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'ko')))
}

function ItemDialog({ item, groups, onClose }: { item: Partial<LauncherInput> | null; groups: string[]; onClose: () => void }): React.JSX.Element {
  const [f, setF] = useState<Partial<LauncherInput>>({})
  const [err, setErr] = useState('')
  const open = !!item
  useEffect(() => {
    if (!item) return
    setF({ kind: 'app', name: '', target: '', args: '', groupName: '', ...item })
    setErr('')
  }, [item])
  const save = async (): Promise<void> => {
    try {
      await invoke('launcher:save', { kind: f.kind ?? 'app', name: f.name ?? '', target: f.target ?? '', args: f.args ?? '', groupName: f.groupName ?? '', id: f.id })
      onClose()
    } catch {
      setErr('저장하지 못했습니다. 이름과 대상을 확인하세요.')
    }
  }
  const pick = async (folders: boolean): Promise<void> => {
    const [p] = await invoke('transfer:pick', { folders })
    if (p) setF({ ...f, target: p, kind: folders ? 'path' : p.toLowerCase().endsWith('.exe') ? 'app' : 'path', name: f.name || p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') })
  }
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={f.id ? '항목 고치기' : '런처에 추가'}
      footer={
        <Button disabled={!f.name?.trim() || !f.target?.trim()} onClick={() => void save()}>
          저장
        </Button>
      }
    >
      <div className="space-y-2">
        <Label htmlFor="li-kind">종류</Label>
        <Select id="li-kind" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as LauncherInput['kind'] })}>
          <option value="app">프로그램</option>
          <option value="path">파일·폴더</option>
          <option value="url">웹 주소</option>
        </Select>
        <Label htmlFor="li-name">이름</Label>
        <Input id="li-name" maxLength={60} value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Label htmlFor="li-target">{f.kind === 'url' ? '주소' : '위치'}</Label>
        <div className="flex gap-2">
          <Input id="li-target" value={f.target ?? ''} onChange={(e) => setF({ ...f, target: e.target.value })} placeholder={f.kind === 'url' ? 'https://' : 'C:\\…'} />
          {f.kind !== 'url' && (
            <>
              <Button variant="outline" onClick={() => void pick(false)}>
                파일
              </Button>
              <Button variant="outline" onClick={() => void pick(true)}>
                폴더
              </Button>
            </>
          )}
        </div>
        {f.kind === 'app' && (
          <>
            <Label htmlFor="li-args">실행 옵션 (선택)</Label>
            <Input id="li-args" maxLength={500} value={f.args ?? ''} onChange={(e) => setF({ ...f, args: e.target.value })} />
          </>
        )}
        <Label htmlFor="li-group">분류 (선택)</Label>
        <Input id="li-group" list="li-groups" maxLength={30} value={f.groupName ?? ''} onChange={(e) => setF({ ...f, groupName: e.target.value })} />
        <datalist id="li-groups">
          {groups.filter(Boolean).map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function StartMenuDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const [q, setQ] = useState('')
  const list = useQuery({ queryKey: ['local', 'startmenu'], queryFn: () => invoke('launcher:startMenu'), enabled: open, networkMode: 'always', staleTime: 60_000 })
  const items = (list.data ?? []).filter((p) => !q.trim() || p.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <Dialog open={open} onClose={onClose} title="시작 메뉴에서 프로그램 추가" width="max-w-2xl">
      <Input aria-label="프로그램 검색" placeholder="프로그램 이름" value={q} onChange={(e) => setQ(e.target.value)} className="mb-2" />
      <div className="max-h-[55vh] space-y-0.5 overflow-y-auto">
        {list.isLoading && <p className="p-3 text-sm text-muted-foreground">찾는 중…</p>}
        {items.map((p) => (
          <div key={p.target} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <AppIcon path={p.target} kind="app" className="size-5" />
            <span className="truncate">{p.name}</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => void invoke('launcher:save', { kind: 'app', name: p.name, target: p.target, groupName: '' })}>
              <Plus /> 추가
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  )
}

function PersonalTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const items = usePersonalLauncher()
  const [edit, setEdit] = useState<Partial<LauncherInput> | null>(null)
  const [startMenu, setStartMenu] = useState(false)
  const [drag, setDrag] = useState(false)
  const [editing, setEditing] = useState(false)
  const groups = useMemo(() => groupBy(items.data ?? []), [items.data])
  const detect = useMutation({
    mutationFn: () => invoke('launcher:detect'),
    onSuccess: (r) => {
      notify(r.added ? `${r.added}개 프로그램을 새로 등록했습니다.` : `찾은 프로그램: ${r.found.map((f) => f.name).join(', ') || '없음'} (이미 등록됨)`)
      void qc.invalidateQueries({ queryKey: ['local', 'launcher'] })
    }
  })
  const run = async (it: LauncherItemDto): Promise<void> => {
    const r = await invoke('launcher:run', { id: it.id })
    if (!r.ok) notify(r.error ?? '실행하지 못했습니다.')
  }
  const move = (list: LauncherItemDto[], i: number, dir: -1 | 1): void => {
    const ids = list.map((x) => x.id)
    const j = i + dir
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    void invoke('launcher:reorder', { ids })
  }
  const onDrop = async (e: React.DragEvent): Promise<void> => {
    e.preventDefault()
    setDrag(false)
    const files = [...e.dataTransfer.files]
    for (const f of files) {
      const p = window.teamhub.pathForFile(f)
      if (!p) continue
      const name = f.name.replace(/\.(lnk|exe)$/i, '')
      await invoke('launcher:save', { kind: p.toLowerCase().endsWith('.exe') ? 'app' : 'path', name, target: p, groupName: '' })
    }
    const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (!files.length && /^https?:\/\//i.test(url)) await invoke('launcher:save', { kind: 'url', name: url.replace(/^https?:\/\//, '').slice(0, 60), target: url.trim(), groupName: '업무 사이트' })
  }
  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto p-5', drag && 'bg-primary/5 outline-2 -outline-offset-8 outline-dashed outline-primary')}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => void onDrop(e)}
      data-testid="launcher-personal"
    >
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => setStartMenu(true)}>
          <Plus /> 프로그램 추가
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEdit({ kind: 'path' })}>
          <FolderOpen /> 파일·폴더
        </Button>
        <Button size="sm" variant="outline" onClick={() => setEdit({ kind: 'url', target: 'https://' })}>
          <Globe /> 웹 주소
        </Button>
        <Button size="sm" variant="outline" disabled={detect.isPending} onClick={() => detect.mutate()}>
          <RefreshCw className={cn(detect.isPending && 'animate-spin')} /> 프로그램 다시 찾기
        </Button>
        <Button size="sm" variant={editing ? 'default' : 'ghost'} onClick={() => setEditing(!editing)}>
          <Pencil /> {editing ? '편집 완료' : '편집'}
        </Button>
        <span className="text-xs text-muted-foreground">파일·폴더·바로가기·웹 주소를 이 화면에 끌어다 놓아도 추가됩니다.</span>
      </div>
      {!items.data?.length && <EmptyState icon={Rocket} title="등록한 항목이 없습니다" description="한글·오피스·브라우저는 처음 실행 때 자동으로 등록됩니다. 프로그램 다시 찾기를 눌러 보세요." />}
      {groups.map(([g, list]) => (
        <section key={g || '_'} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{g || '기타'}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {list.map((it, i) => (
              <div key={it.id} className="group relative" data-testid="launcher-item">
                <button className="flex w-full cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-transparent p-3 text-center hover:border-border hover:bg-muted" title={it.target} onClick={() => void run(it)}>
                  <AppIcon path={it.target} kind={it.kind} />
                  <span className="line-clamp-2 text-xs font-medium">{it.name}</span>
                </button>
                {editing && (
                  <div className="absolute right-0 top-0 flex rounded bg-card shadow">
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${it.name} 앞으로`} onClick={() => move(list, i, -1)}>
                      <ChevronUp className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${it.name} 뒤로`} onClick={() => move(list, i, 1)}>
                      <ChevronDown className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${it.name} 고치기`} onClick={() => setEdit({ ...it })}>
                      <Pencil className="size-3.5" />
                    </button>
                    <button className="cursor-pointer p-1 hover:bg-muted" aria-label={`${it.name} 삭제`} onClick={() => confirmDialog(`"${it.name}"을(를) 런처에서 뺄까요?`) && void invoke('launcher:remove', { id: it.id })}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
      <ItemDialog item={edit} groups={groups.map(([g]) => g)} onClose={() => setEdit(null)} />
      <StartMenuDialog open={startMenu} onClose={() => setStartMenu(false)} />
    </div>
  )
}

function TeamTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const q = useTeamLauncher()
  if (!online && !q.data) return <OfflineState />
  const run = async (it: TeamLauncherDto): Promise<void> => {
    const r = await invoke('launcher:runTeam', it)
    if (!r.ok) notify(r.error ?? '열지 못했습니다.')
    else if (it.kind === 'template') notify(`"${it.name}" 사본을 문서\\TeamHub 양식 폴더에 만들어 열었습니다.`)
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5" data-testid="launcher-team">
      <p className="mb-4 text-sm text-muted-foreground">관리자가 등록한 업무 사이트·공용 폴더·양식입니다. 양식은 누를 때마다 내 문서에 새 사본을 만들어 엽니다.</p>
      {!q.data?.length && <EmptyState icon={Users} title="공용 항목이 없습니다" />}
      {groupBy(q.data ?? []).map(([g, list]) => (
        <section key={g || '_'} className="mb-5">
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{g || '기타'}</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
            {list.map((it) => (
              <button key={it.id} className="flex cursor-pointer flex-col items-center gap-1.5 rounded-lg border border-transparent p-3 text-center hover:border-border hover:bg-muted" title={it.kind === 'template' ? `${it.fileName} — 새 문서로 열기` : it.target} onClick={() => void run(it)}>
                <AppIcon path={it.target} kind={it.kind} />
                <span className="line-clamp-2 text-xs font-medium">{it.name}</span>
                {it.kind === 'template' && <span className="text-[10px] text-primary">새 문서로 열기</span>}
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

function RecentTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const recent = useQuery({ queryKey: ['local', 'recent-docs'], queryFn: () => invoke('launcher:recent'), networkMode: 'always', refetchOnMount: 'always' })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local', 'recent-docs'] })
  const list = (recent.data ?? []).filter((d: RecentDocDto) => !q.trim() || d.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="relative mb-3 max-w-sm">
        <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" aria-label="최근 문서 검색" placeholder="문서 이름" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {!list.length && <EmptyState icon={History} title="최근 문서가 없습니다" />}
      <div className="space-y-0.5" data-testid="recent-docs">
        {list.map((d) => (
          <div key={d.path} className="group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
            <AppIcon path={d.path} kind="path" className="size-5" />
            <button
              className="min-w-0 flex-1 cursor-pointer truncate text-left"
              title={d.path}
              onClick={() =>
                void invoke('launcher:openRecent', { path: d.path }).then((r) => {
                  if (!r.ok) notify(r.error ?? '열지 못했습니다.')
                  refresh()
                })
              }
            >
              {d.pinned && <Pin className="mr-1 inline size-3 text-primary" />}
              {d.name}
              <span className="ml-2 text-xs text-muted-foreground">{d.path.replace(/[\\/][^\\/]+$/, '')}</span>
            </button>
            <span className="shrink-0 text-xs text-muted-foreground">{format(d.openedAt, 'M/d HH:mm')}</span>
            <Button size="icon-sm" variant="ghost" aria-label={d.pinned ? '고정 해제' : '고정'} onClick={() => void invoke('launcher:pinRecent', { path: d.path, pinned: !d.pinned }).then(refresh)}>
              {d.pinned ? <PinOff /> : <Pin />}
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

type Tab = 'personal' | 'sites' | 'team' | 'recent'

export function LauncherPage(): React.JSX.Element {
  // The home favorites widget links straight to the site collection.
  const location = useLocation()
  const [tab, setTab] = useState<Tab>((location.state as { tab?: Tab } | null)?.tab ?? 'personal')
  const [msg, setMsg] = useState('')
  const notify = (s: string): void => {
    setMsg(s)
    window.setTimeout(() => setMsg((cur) => (cur === s ? '' : cur)), 5000)
  }
  const tabs: { key: Tab; label: string; icon: typeof Rocket }[] = [
    { key: 'personal', label: '내 런처', icon: Rocket },
    { key: 'sites', label: '사이트 모음', icon: Globe },
    { key: 'team', label: '팀 공용·양식함', icon: Users },
    { key: 'recent', label: '최근 문서', icon: History }
  ]
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="런처"
        description="내 런처와 최근 문서는 이 PC에만 저장됩니다."
        actions={
          <Button size="sm" variant="outline" onClick={() => void invoke('launcher:openBar')} title="Ctrl+Alt+Space">
            <Zap /> 빠른 실행
          </Button>
        }
      />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2" role="tablist">
        {tabs.map((t) => (
          <Button key={t.key} role="tab" aria-selected={tab === t.key} size="sm" variant={tab === t.key ? 'default' : 'ghost'} onClick={() => setTab(t.key)}>
            <t.icon /> {t.label}
          </Button>
        ))}
        {msg && (
          <span className="ml-auto self-center text-sm text-primary" role="status">
            {msg}
          </span>
        )}
      </div>
      {tab === 'personal' && <PersonalTab notify={notify} />}
      {tab === 'sites' && <BookmarksTab notify={notify} />}
      {tab === 'team' && <TeamTab notify={notify} />}
      {tab === 'recent' && <RecentTab notify={notify} />}
    </div>
  )
}
