import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import type { TeamLauncherDto } from '@shared/schemas/launcher'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'
import { AppIcon } from './LauncherPage'

interface Entry {
  key: string
  name: string
  sub: string
  kind: string
  path: string
  run: () => Promise<{ ok: boolean; error?: string }>
}

/** Quick launcher window (Ctrl+Alt+Space): type, arrow keys, Enter. */
export function LauncherBar(): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [err, setErr] = useState('')
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    void invoke('conn:get').then(loadConn)
    input.current?.focus()
  }, [loadConn])
  const personal = useQuery({ queryKey: ['local', 'launcher'], queryFn: () => invoke('launcher:list'), networkMode: 'always' })
  const sites = useQuery({ queryKey: ['local', 'bookmarks'], queryFn: () => invoke('bm:list'), networkMode: 'always' })
  const recent = useQuery({ queryKey: ['local', 'recent-docs'], queryFn: () => invoke('launcher:recent'), networkMode: 'always' })
  const serverUrl = useConn((s) => s.serverUrl)
  const team = useQuery({ queryKey: ['launcher', 'team'], queryFn: () => api.get<TeamLauncherDto[]>('/api/launcher'), retry: false, enabled: !!serverUrl })

  const entries = useMemo<Entry[]>(
    () => [
      ...(personal.data ?? []).map((i) => ({ key: `p${i.id}`, name: i.name, sub: i.groupName || '내 런처', kind: i.kind, path: i.target, run: () => invoke('launcher:run', { id: i.id }) })),
      ...(team.data ?? []).map((i) => ({ key: `t${i.id}`, name: i.name, sub: i.kind === 'template' ? '양식 · 새 문서로 열기' : '팀 공용', kind: i.kind, path: i.target, run: () => invoke('launcher:runTeam', i) })),
      ...(sites.data ?? []).map((b) => ({ key: `b${b.id}`, name: b.title, sub: b.category ? `사이트 · ${b.category}` : '사이트', kind: 'url', path: b.url, run: () => invoke('bm:open', { url: b.url }).then(() => ({ ok: true })) })),
      ...(recent.data ?? []).map((d) => ({ key: `r${d.path}`, name: d.name, sub: '최근 문서', kind: 'path', path: d.path, run: () => invoke('launcher:openRecent', { path: d.path }) }))
    ],
    [personal.data, team.data, sites.data, recent.data]
  )
  const t = q.trim().toLowerCase()
  const list = (t ? entries.filter((e) => e.name.toLowerCase().includes(t) || e.sub.toLowerCase().includes(t)) : entries).slice(0, 30)

  const go = async (e: Entry | undefined): Promise<void> => {
    if (!e) return
    const r = await e.run()
    if (r.ok) void invoke('memo:closeWindow')
    else setErr(r.error ?? '실행하지 못했습니다.')
  }
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') void invoke('memo:closeWindow')
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(list.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') void go(list[sel])
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-background shadow-xl" onKeyDown={onKey} data-testid="launcher-bar">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <Search className="size-5 text-muted-foreground" />
        <input
          ref={input}
          aria-label="실행할 항목 검색"
          className="flex-1 bg-transparent text-base outline-none"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          placeholder="프로그램·사이트·양식·최근 문서 찾기"
          value={q}
          onChange={(e) => {
            setQ(e.target.value)
            setSel(0)
            setErr('')
          }}
        />
        <kbd className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">Esc</kbd>
      </div>
      {err && <p className="px-3 py-1.5 text-sm text-urgent">{err}</p>}
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5" role="listbox" aria-label="실행 목록">
        {list.map((e, i) => (
          <button
            key={e.key}
            role="option"
            aria-selected={i === sel}
            className={cn('flex w-full cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-left text-sm', i === sel ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
            onMouseEnter={() => setSel(i)}
            onClick={() => void go(e)}
          >
            <AppIcon path={e.path} kind={e.kind} className="size-5" />
            <span className="truncate font-medium">{e.name}</span>
            <span className={cn('ml-auto shrink-0 text-xs', i === sel ? 'opacity-80' : 'text-muted-foreground')}>{e.sub}</span>
          </button>
        ))}
        {!list.length && <p className="p-4 text-center text-sm text-muted-foreground">찾는 항목이 없습니다.</p>}
      </div>
    </div>
  )
}
