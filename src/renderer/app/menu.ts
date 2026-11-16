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
}

export const MENU: MenuItem[] = [
  { key: 'home', label: '홈', path: '/home', icon: Home },
  { key: 'notices', label: '공지', path: '/notices', icon: Megaphone },
  { key: 'calendar', label: '일정', path: '/calendar', icon: CalendarDays },
  { key: 'files', label: '자료실', path: '/files', icon: FolderOpen },
  { key: 'meetings', label: '회의', path: '/meetings', icon: Video },
  { key: 'chat', label: '메신저', path: '/chat', icon: MessagesSquare },
  { key: 'tasks', label: '할 일', path: '/tasks', icon: ListTodo },
  { key: 'boards', label: '게시판', path: '/boards', icon: ClipboardList },
  { key: 'directory', label: '주소록', path: '/directory', icon: Contact },
  { key: 'docs', label: '기록', path: '/docs', icon: BookOpen },
  { key: 'diary', label: '다이어리', path: '/diary', icon: NotebookPen, personal: true },
  { key: 'memos', label: '메모', path: '/memos', icon: StickyNote, personal: true },
  { key: 'alarms', label: '알람', path: '/alarms', icon: AlarmClock, personal: true },
  { key: 'notes', label: '지식 노트', path: '/notes', icon: Library, personal: true },
  { key: 'myfiles', label: '내 파일', path: '/myfiles', icon: FolderSearch, personal: true },
  { key: 'launcher', label: '런처', path: '/launcher', icon: Rocket, personal: true },
  { key: 'utilities', label: '유틸리티', path: '/utilities', icon: Gauge, personal: true },
  { key: 'ledger', label: '관리대장', path: '/ledger', icon: Table2 },
  { key: 'plugins', label: '확장 기능', path: '/plugins', icon: Puzzle, personal: true }
]

export const BOTTOM_MENU: MenuItem[] = [
  { key: 'admin', label: '관리', path: '/admin', icon: Shield, adminOnly: true },
  { key: 'settings', label: '설정', path: '/settings', icon: Settings },
  { key: 'help', label: '도움말', path: '/help', icon: CircleHelp }
]
