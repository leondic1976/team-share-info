import {
  Home,
  Megaphone,
  CalendarDays,
  FolderOpen,
  Video,
  MessagesSquare,
  ListTodo,
  ClipboardList,
  Contact,
  BookOpen,
  NotebookPen,
  StickyNote,
  AlarmClock,
  Rocket,
  Gauge,
  Settings,
  Shield,
  CircleHelp,
  FolderSearch,
  Library,
  Puzzle,
  Table2,
  UserCheck,
  Network,
  Utensils,
  type LucideIcon
} from 'lucide-react'
import type { FeatureKey } from '@shared/constants'

export interface MenuItem {
  key: FeatureKey | 'settings' | 'admin' | 'help'
  label: string
  path: string
  icon: LucideIcon
  /** personal (local-only) feature: works without the server */
  personal?: boolean
  adminOnly?: boolean
  /** shown as a sub-item of this menu instead of on its own line */
  under?: FeatureKey
}

/** Shared (team) features first, then the personal ones of this PC; the sidebar draws a line between the two. */
export const MENU: MenuItem[] = [
  { key: 'home', label: '홈', path: '/home', icon: Home },
  { key: 'notices', label: '공지', path: '/notices', icon: Megaphone },
  { key: 'calendar', label: '일정', path: '/calendar', icon: CalendarDays },
  { key: 'files', label: '자료실', path: '/files', icon: FolderOpen },
  { key: 'meetings', label: '회의', path: '/meetings', icon: Video },
  { key: 'chat', label: '메신저', path: '/chat', icon: MessagesSquare },
  { key: 'tasks', label: '할 일', path: '/tasks', icon: ListTodo },
  { key: 'boards', label: '게시판', path: '/boards', icon: ClipboardList },
  { key: 'duty', label: '근무현황', path: '/duty', icon: UserCheck },
  { key: 'org', label: '조직도', path: '/org', icon: Network },
  { key: 'directory', label: '주소록', path: '/directory', icon: Contact },
  // a built-in extension (plugins/meal) shown as a menu of its own; installed by itself when first opened
  { key: 'meal', label: '식사 신청', path: '/meal', icon: Utensils },
  { key: 'docs', label: '기록', path: '/docs', icon: BookOpen },
  { key: 'diary', label: '다이어리', path: '/diary', icon: NotebookPen, personal: true },
  { key: 'memos', label: '메모', path: '/memos', icon: StickyNote, personal: true },
  { key: 'alarms', label: '알람', path: '/alarms', icon: AlarmClock, personal: true },
  { key: 'notes', label: '지식 노트', path: '/notes', icon: Library, personal: true },
  { key: 'myfiles', label: '내 파일', path: '/myfiles', icon: FolderSearch, personal: true },
  { key: 'launcher', label: '런처', path: '/launcher', icon: Rocket, personal: true },
  { key: 'utilities', label: '유틸리티', path: '/utilities', icon: Gauge, personal: true },
  { key: 'plugins', label: '확장 기능', path: '/plugins', icon: Puzzle, personal: true },
  // built in, but listed with the extensions (no install needed)
  { key: 'ledger', label: '관리대장', path: '/ledger', icon: Table2, under: 'plugins' }
]

/** Menus with a line of their own in the sidebar, in the saved order. */
/** Extensions that have a menu of their own (id -> path): not listed again under 확장 기능. */
export const MENU_PLUGINS: Record<string, string> = { meal: '/meal' }

export const topMenu = (order: string[]): MenuItem[] => orderMenu(order).filter((m) => !m.under)
/** Built-in screens listed under another menu (e.g. 관리대장 under 확장 기능). */
export const subMenu = (parent: FeatureKey): MenuItem[] => MENU.filter((m) => m.under === parent)

export const BOTTOM_MENU: MenuItem[] = [
  { key: 'admin', label: '관리', path: '/admin', icon: Shield, adminOnly: true },
  { key: 'settings', label: '설정', path: '/settings', icon: Settings },
  { key: 'help', label: '도움말', path: '/help', icon: CircleHelp }
]

/**
 * The menus in the order saved on this PC. A menu added after the order was saved goes next
 * to its neighbour of the default order, not to the end.
 */
export function orderMenu(order: string[]): MenuItem[] {
  if (!order.length) return [...MENU]
  const out = MENU.filter((m) => order.includes(m.key)).sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  for (const m of MENU) {
    if (order.includes(m.key)) continue
    const before = MENU.slice(0, MENU.indexOf(m))
      .reverse()
      .find((x) => out.includes(x))
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, m)
  }
  return out
}
