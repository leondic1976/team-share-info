import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { LayoutList, Lock, Search, Users } from 'lucide-react'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useConn } from './conn-store'
import { cn } from '@renderer/lib/utils'
import { BOTTOM_MENU, MENU } from './menu'
import { usePrefs } from './prefs-store'
import { matchesHangul } from '@shared/hangul'

interface Hit {
  key: string
  group: string
  local: boolean
  title: string
  snippet: string
  at?: number
  go: () => void
}

const TYPE_LABEL: Record<string, string> = { notice: '공지', event: '일정', doc: '기록', post: '게시판', file: '자료실', message: '메신저', contact: '주소록', member: '구성원', worklog: '업무일지' }

function useDebounced(v: string, ms = 200): string {
  const [d, setD] = useState(v)
  useEffect(() => {
    const t = window.setTimeout(() => setD(v), ms)
    return () => window.clearTimeout(t)
  }, [v, ms])
  return d
}

/** Ctrl+K: search the team (server, within my scope) and this PC (memos, diary, notes, files, sites). */
export function SearchPalette({ open, onClose, isAdmin = false, disabledFeatures = [] }: { open: boolean; onClose: () => void; isAdmin?: boolean; disabledFeatures?: string[] }): React.JSX.Element | null {
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const dq = useDebounced(q.trim())
  useEffect(() => {
    if (open) {
      setQ('')
      setSel(0)
      window.setTimeout(() => input.current?.focus(), 0)
    }
  }, [open])
  const go = (path: string): void => {
    onClose()
    navigate(path)
  }

  const server = useQuery({
    queryKey: ['search', dq],
    queryFn: () => api.get<{ type: string; id: string; title: string; snippet: string; route: string; at: number }[]>('/api/search', { q: dq, limit: 8 }),
    enabled: open && online && dq.length > 0
  })
  const local = useQuery({
    queryKey: ['local', 'search', dq],
    networkMode: 'always',
    enabled: open && dq.length > 0,
    queryFn: async (): Promise<Hit[]> => {
      const [memos, diary, notes, files, sites] = await Promise.all([
        invoke('local:memos.list', { q: dq }).catch(() => []),
        invoke('local:diary.search', { q: dq }).catch(() => []),
        invoke('notes:search', { q: dq }).catch(() => []),
        invoke('fsx:search', { q: dq, limit: 8 }).catch(() => []),
        invoke('bm:list').catch(() => [])
      ])
      const text = (h: string): string => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      return [
        ...memos.slice(0, 6).map((m) => ({ key: `memo${m.id}`, group: '메모', local: true, title: text(m.body).slice(0, 60) || '(빈 메모)', snippet: m.tags.map((t) => `#${t}`).join(' '), at: m.updatedAt, go: () => go('/memos') })),
        ...diary.slice(0, 6).map((d) => ({ key: `diary${d.date}`, group: '다이어리', local: true, title: d.date, snippet: d.snippet, go: () => go('/diary') })),
        ...notes.slice(0, 6).map((n) => ({ key: `note${n.id}`, group: '지식 노트', local: true, title: n.title || '제목 없음', snippet: n.snippet, go: () => go(`/notes/${n.id}`) })),
        ...files.map((f) => ({ key: `file${f.path}`, group: '내 파일', local: true, title: f.name, snippet: f.dir, at: f.mtime, go: () => void invoke('fm:open', { path: f.path }).then(onClose) })),
        ...sites
          .filter((b) => matchesHangul(`${b.title} ${b.url} ${b.category}`, dq))
          .slice(0, 6)
          .map((b) => ({ key: `bm${b.id}`, group: '사이트 모음', local: true, title: b.title, snippet: b.url, go: () => void invoke('bm:open', { url: b.url }).then(onClose) }))
      ]
    }
  })
  const hiddenMenus = usePrefs((s) => s.hiddenMenus)
  // the menus themselves, so "근무현황" or "ㄱㅁㅎㅎ" opens the screen
  const menus = useMemo<Hit[]>(
    () =>
      dq
        ? [...MENU, ...BOTTOM_MENU]
            .filter((m) => (!m.adminOnly || isAdmin) && !hiddenMenus.includes(m.key) && !disabledFeatures.includes(m.key) && matchesHangul(m.label, dq))
            .map((m) => ({ key: `menu${m.key}`, group: '메뉴', local: false, title: m.label, snippet: '', go: () => go(m.path) }))
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [dq, isAdmin, hiddenMenus, disabledFeatures]
  )
  const hits = useMemo<Hit[]>(
    () => [
      ...menus,
      ...(server.data ?? []).map((r) => ({ key: `${r.type}${r.id}`, group: TYPE_LABEL[r.type] ?? r.type, local: false, title: r.title, snippet: r.snippet, at: r.at, go: () => go(r.route) })),
      ...(local.data ?? [])
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [menus, server.data, local.data]
  )
  useEffect(() => setSel(0), [dq])
  if (!open) return null
  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSel((s) => Math.min(hits.length - 1, s + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSel((s) => Math.max(0, s - 1))
    } else if (e.key === 'Enter') hits[sel]?.go()
  }
  let lastGroup = ''
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 p-4 pt-[12vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="w-full max-w-2xl overflow-hidden rounded-xl bg-card shadow-2xl" role="dialog" aria-label="통합 검색" onKeyDown={onKey}>
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Search className="size-5 text-muted-foreground" />
          <input ref={input} aria-label="검색어" className="flex-1 bg-transparent text-base outline-none" placeholder="공지·일정·자료·메시지·기록·주소록… 그리고 내 메모·노트·파일" value={q} onChange={(e) => setQ(e.target.value)} />
          <kbd className="rounded border border-border px-1.5 text-[10px] text-muted-foreground">Esc</kbd>
        </div>
        <div className="max-h-[60vh] overflow-y-auto p-1.5" data-testid="search-results">
          {dq && !hits.length && !server.isFetching && !local.isFetching && <p className="p-6 text-center text-sm text-muted-foreground">찾는 내용이 없습니다.</p>}
          {!dq && <p className="p-6 text-center text-sm text-muted-foreground">팀 자료는 내가 볼 수 있는 범위에서만, 개인 자료(<Lock className="inline size-3.5 align-[-0.15em]" aria-label="자물쇠 표시" />)는 이 PC에서만 찾습니다.{!online && ' 서버에 연결되지 않아 지금은 내 PC 자료만 찾습니다.'}</p>}
          {hits.map((h, i) => {
            const header = h.group !== lastGroup
            lastGroup = h.group
            return (
              <div key={h.key}>
                {header && (
                  <p className="flex items-center gap-1 px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">
                    {h.group === '메뉴' ? <LayoutList className="size-3" /> : h.local ? <Lock className="size-3" /> : <Users className="size-3" />} {h.group}
                  </p>
                )}
                <button
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-3 py-1.5 text-left text-sm', i === sel ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  onMouseEnter={() => setSel(i)}
                  onClick={h.go}
                  data-testid="search-result"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{h.title}</span>
                    {h.snippet && <span className={cn('block truncate text-xs', i === sel ? 'opacity-80' : 'text-muted-foreground')}>{h.snippet}</span>}
                  </span>
                  {h.at && <span className={cn('shrink-0 text-xs', i === sel ? 'opacity-80' : 'text-muted-foreground')}>{format(h.at, 'yy-MM-dd')}</span>}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
