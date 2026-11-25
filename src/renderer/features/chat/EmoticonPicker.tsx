import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock, Search } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { ALL_EMOTICONS, EMOTICON_GROUPS, type Emoticon } from './emoticons'

const RECENT_KEY = 'teamhub.chat.recentEmoticons'
const RECENT_MAX = 24

function readRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : []
  } catch {
    return []
  }
}

/**
 * 이모티콘 고르기: tabs by situation (and the ones used lately), a search over the Korean
 * labels. Picking one inserts it into the message being written; it is sent with Enter or
 * 보내기 like any text. Closes on Esc and on a click outside.
 */
export function EmoticonPicker({ onPick, onClose, compact = false }: { onPick: (e: string) => void; onClose: () => void; compact?: boolean }): React.JSX.Element {
  const [recent, setRecent] = useState<string[]>(readRecent)
  const [tab, setTab] = useState<string>(() => (readRecent().length ? 'recent' : EMOTICON_GROUPS[0]!.id))
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('[data-emoticon-toggle]')) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const shown: Emoticon[] = useMemo(() => {
    const s = q.trim()
    if (s) return ALL_EMOTICONS.filter((x, i, all) => x.label.includes(s) && all.findIndex((y) => y.e === x.e) === i)
    if (tab === 'recent') return recent.map((e) => ALL_EMOTICONS.find((x) => x.e === e) ?? { e, label: '' })
    return EMOTICON_GROUPS.find((x) => x.id === tab)?.items ?? []
  }, [q, tab, recent])

  const pick = (e: string): void => {
    const next = [e, ...recent.filter((x) => x !== e)].slice(0, RECENT_MAX)
    setRecent(next)
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next))
    } catch {
      // storage full or blocked: the recent list is only a convenience
    }
    onPick(e)
  }

  const tabBtn = 'shrink-0 cursor-pointer rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap hover:bg-muted'
  return (
    <div ref={ref} role="dialog" aria-label="이모티콘" className={cn('absolute bottom-full left-0 z-20 mb-1 flex flex-col rounded-lg border border-border bg-card shadow-lg', compact ? 'w-[17.5rem]' : 'w-[22rem]')} data-testid="emoticon-picker">
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <input className="h-7 min-w-0 flex-1 bg-transparent text-sm outline-none" placeholder="이모티콘 찾기 (예: 감사, 축하, 커피)" aria-label="이모티콘 찾기" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      {!q.trim() && (
        <div className="flex gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1" role="tablist" aria-label="이모티콘 종류">
          <button type="button" role="tab" aria-selected={tab === 'recent'} className={cn(tabBtn, tab === 'recent' && 'bg-primary/10 text-primary')} onClick={() => setTab('recent')} title="최근 쓴 이모티콘">
            <Clock className="inline size-3.5 align-[-0.15em]" aria-hidden /> 최근
          </button>
          {EMOTICON_GROUPS.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id} className={cn(tabBtn, tab === x.id && 'bg-primary/10 text-primary')} onClick={() => setTab(x.id)}>
              {x.name}
            </button>
          ))}
        </div>
      )}
      <div className={cn('grid content-start auto-rows-max gap-0.5 overflow-y-auto p-1.5', compact ? 'h-40 grid-cols-7' : 'h-52 grid-cols-8')} role="list">
        {shown.length ? (
          shown.map((x) => (
            <button key={x.e} type="button" role="listitem" className="flex aspect-square cursor-pointer items-center justify-center rounded-md text-2xl leading-none hover:bg-muted" title={x.label || undefined} aria-label={x.label || '이모티콘'} onClick={() => pick(x.e)} data-emoticon={x.label}>
              {x.e}
            </button>
          ))
        ) : (
          <p className="col-span-full self-center text-center text-xs text-muted-foreground">{q.trim() ? '찾는 이모티콘이 없습니다' : '아직 쓴 이모티콘이 없습니다'}</p>
        )}
      </div>
    </div>
  )
}
