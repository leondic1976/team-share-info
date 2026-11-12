import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, Users, Settings2, Check } from 'lucide-react'
import { useSpace } from './space-store'
import { useMe } from '@renderer/lib/queries'
import { usePrefs } from './prefs-store'
import { cn } from '@renderer/lib/utils'

/** "팀 전체 ▾" switcher at the top of the sidebar (6.2 ④). */
export function SpaceSwitcher(): React.JSX.Element {
  const { space, setSpace } = useSpace()
  const { data: me } = useMe()
  const collapsed = usePrefs((s) => s.sidebarCollapsed)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const groups = me?.groups ?? []
  const current = groups.find((g) => g.id === space)

  // If I left the selected group, fall back to the team space.
  useEffect(() => {
    if (me && space !== 'team' && !current) setSpace('team')
  }, [me, space, current, setSpace])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [open])

  return (
    <div ref={ref} className="relative px-2 pt-2">
      <button
        className="flex h-9 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-background px-2.5 text-sm font-semibold hover:bg-muted"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`공간: ${current?.name ?? '팀 전체'}`}
        data-testid="space-switcher"
      >
        {current ? <span className="size-3 shrink-0 rounded-full" style={{ background: current.color }} /> : <Users className="size-4 shrink-0" />}
        {!collapsed && <span className="truncate">{current?.name ?? '팀 전체'}</span>}
        {!collapsed && <ChevronDown className="ml-auto size-4 shrink-0 text-muted-foreground" />}
      </button>
      {open && (
        <div role="listbox" className="absolute left-2 z-40 mt-1 w-56 rounded-md border border-border bg-card p-1 shadow-lg">
          {[{ id: 'team', name: '팀 전체', color: '' }, ...groups].map((g) => (
            <button
              key={g.id}
              role="option"
              aria-selected={space === g.id}
              className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                setSpace(g.id)
                setOpen(false)
              }}
            >
              {g.color ? <span className="size-3 rounded-full" style={{ background: g.color }} /> : <Users className="size-4" />}
              <span className={cn('truncate', space === g.id && 'font-semibold')}>{g.name}</span>
              {space === g.id && <Check className="ml-auto size-4 text-primary" />}
            </button>
          ))}
          <div className="my-1 h-px bg-border" />
          <button
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => {
              setOpen(false)
              navigate('/groups')
            }}
          >
            <Settings2 className="size-4" /> 그룹 관리…
          </button>
        </div>
      )}
    </div>
  )
}
