import { NavLink } from 'react-router-dom'
import { ChevronsLeft, ChevronsRight, Lock } from 'lucide-react'
import { MENU, BOTTOM_MENU, type MenuItem } from './menu'
import { usePrefs } from './prefs-store'
import { cn } from '@renderer/lib/utils'
import { SpaceSwitcher } from './SpaceSwitcher'

interface SidebarProps {
  isAdmin: boolean
  disabledFeatures: string[]
  badges?: Partial<Record<string, number>>
}

function orderedMenu(order: string[], hidden: string[], disabled: string[]): MenuItem[] {
  const items = MENU.filter((m) => !hidden.includes(m.key) && !disabled.includes(m.key))
  if (!order.length) return items
  return [...items].sort((a, b) => {
    const ia = order.indexOf(a.key)
    const ib = order.indexOf(b.key)
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib)
  })
}

export function Sidebar({ isAdmin, disabledFeatures, badges = {} }: SidebarProps): React.JSX.Element {
  const { sidebarCollapsed: collapsed, update, menuOrder, hiddenMenus } = usePrefs()
  const items = orderedMenu(menuOrder, hiddenMenus, disabledFeatures)
  const bottom = BOTTOM_MENU.filter((m) => !m.adminOnly || isAdmin)

  const renderItem = (m: MenuItem): React.JSX.Element => {
    const Icon = m.icon
    const count = badges[m.key] ?? 0
    return (
      <NavLink
        key={m.key}
        to={m.path}
        title={collapsed ? m.label : m.personal ? '내 PC에만 저장되는 개인 기능' : undefined}
        aria-label={count > 0 ? `${m.label} (${count})` : m.label}
        className={({ isActive }) =>
          cn(
            'group relative flex h-9 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
            isActive ? 'bg-primary/10 font-semibold text-primary' : 'text-foreground/80 hover:bg-muted'
          )
        }
      >
        <Icon className="size-[1.15rem] shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{m.label}</span>}
        {!collapsed && m.personal && <Lock className="ml-auto size-3 text-personal" aria-hidden />}
        {count > 0 && (
          <span
            className={cn(
              'rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold leading-4 text-white',
              collapsed ? 'absolute right-0.5 top-0.5' : m.personal ? 'ml-1' : 'ml-auto'
            )}
          >
            {count > 99 ? '99+' : count}
          </span>
        )}
      </NavLink>
    )
  }

  return (
    <nav
      aria-label="주 메뉴"
      className={cn(
        'flex shrink-0 flex-col border-r border-border bg-sidebar transition-[width] duration-150',
        collapsed ? 'w-[56px]' : 'w-[200px]'
      )}
    >
      <SpaceSwitcher />
      <div className="flex-1 space-y-0.5 overflow-y-auto overflow-x-hidden p-2">{items.map(renderItem)}</div>
      <div className="space-y-0.5 border-t border-border p-2">
        {bottom.map(renderItem)}
        <button
          type="button"
          onClick={() => update({ sidebarCollapsed: !collapsed })}
          className="flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-xs text-muted-foreground hover:bg-muted"
          aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'}
        >
          {collapsed ? <ChevronsRight className="size-4" /> : <ChevronsLeft className="size-4" />}
          {!collapsed && '메뉴 접기'}
        </button>
      </div>
    </nav>
  )
}
