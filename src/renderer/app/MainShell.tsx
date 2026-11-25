import { Loading } from '@renderer/components/EmptyState'
import { PageErrorBoundary } from '@renderer/components/PageErrorBoundary'
import { lazy, Suspense, useEffect, useState } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { UpdateChip } from './UpdateChip'
import { OrgBadge } from './OrgBadge'
import { ConnChip } from './ConnChip'
import { clearQueryPersist } from '@renderer/lib/query-persist'
import { SearchPalette } from './SearchPalette'
import { Search } from 'lucide-react'
import { StatusBar } from './StatusBar'
import { MENU } from './menu'
import { useConn } from './conn-store'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { WallpaperLayer } from './WallpaperLayer'
import { ComingSoon } from '@renderer/features/placeholder/ComingSoon'
import { CommandPage } from '@renderer/features/command/CommandPage'
import { ConnectionCard } from '@renderer/features/settings/ConnectionCard'
import { HomePage } from '@renderer/features/home/HomePage'
import { BlockingScreen } from './BlockingScreen'
import { NoticesPage } from '@renderer/features/notices/NoticesPage'
import { useNoticeAlerts, useUnreadNotices } from '@renderer/features/notices/useNoticeAlerts'
import { useSpace } from './space-store'
import { useWarmCache } from './useWarmCache'
import { useEventReminders } from '@renderer/features/calendar/useEventReminders'
import { TransferPanel } from '@renderer/features/files/TransferPanel'
import { useChatAlerts, useChatUnread } from '@renderer/features/chat/useChatAlerts'
import { ChatDock } from '@renderer/features/chat/ChatDock'
import { useJoinAlerts } from '@renderer/features/admin/useJoinAlerts'
import { useLedgerAlerts } from '@renderer/features/ledger/useLedgerAlerts'
import { useDocAlerts } from '@renderer/features/docs/useDocAlerts'
import { CaptureDialog } from '@renderer/features/memos/CaptureDialog'
import { useMorningSummary, useTeamAlarms } from '@renderer/features/alarms/useTeamAlarms'
import { usePluginInvites } from '@renderer/features/plugins/usePluginInvites'
import { MeetingsPage, useLiveMeetings, useMeetingAlerts } from '@renderer/features/meetings/MeetingsPage'
import { useEventAlerts } from '@renderer/features/calendar/useEventAlerts'

// Pages load when first opened: a smaller start-up bundle and less idle memory (11장).
const SettingsPage = lazy(() => import('@renderer/features/settings/SettingsPage').then((m) => ({ default: m.SettingsPage })))
const AdminPage = lazy(() => import('@renderer/features/admin/AdminPage').then((m) => ({ default: m.AdminPage })))
const HelpPage = lazy(() => import('@renderer/features/help/HelpPage').then((m) => ({ default: m.HelpPage })))
const GroupsPage = lazy(() => import('@renderer/features/groups/GroupsPage').then((m) => ({ default: m.GroupsPage })))
const CalendarPage = lazy(() => import('@renderer/features/calendar/CalendarPage').then((m) => ({ default: m.CalendarPage })))
const DiaryPage = lazy(() => import('@renderer/features/diary/DiaryPage').then((m) => ({ default: m.DiaryPage })))
const FilesPage = lazy(() => import('@renderer/features/files/FilesPage').then((m) => ({ default: m.FilesPage })))
const ChatPage = lazy(() => import('@renderer/features/chat/ChatPage').then((m) => ({ default: m.ChatPage })))
const BoardsPage = lazy(() => import('@renderer/features/boards/BoardsPage').then((m) => ({ default: m.BoardsPage })))
const DutyPage = lazy(() => import('@renderer/features/duty/DutyPage').then((m) => ({ default: m.DutyPage })))
const OrgChartPage = lazy(() => import('@renderer/features/org/OrgChartPage').then((m) => ({ default: m.OrgChartPage })))
const DirectoryPage = lazy(() => import('@renderer/features/directory/DirectoryPage').then((m) => ({ default: m.DirectoryPage })))
const DocsPage = lazy(() => import('@renderer/features/docs/DocsPage').then((m) => ({ default: m.DocsPage })))
const MemosPage = lazy(() => import('@renderer/features/memos/MemosPage').then((m) => ({ default: m.MemosPage })))
const AlarmsPage = lazy(() => import('@renderer/features/alarms/AlarmsPage').then((m) => ({ default: m.AlarmsPage })))
const UtilitiesPage = lazy(() => import('@renderer/features/utilities/UtilitiesPage').then((m) => ({ default: m.UtilitiesPage })))
const LauncherPage = lazy(() => import('@renderer/features/launcher/LauncherPage').then((m) => ({ default: m.LauncherPage })))
const MyFilesPage = lazy(() => import('@renderer/features/myfiles/MyFilesPage').then((m) => ({ default: m.MyFilesPage })))
const NotesPage = lazy(() => import('@renderer/features/notes/NotesPage').then((m) => ({ default: m.NotesPage })))
const PluginsPage = lazy(() => import('@renderer/features/plugins/PluginsPage').then((m) => ({ default: m.PluginsPage })))
const LedgerPage = lazy(() => import('@renderer/features/ledger/LedgerPage').then((m) => ({ default: m.LedgerPage })))
const PluginHost = lazy(() => import('@renderer/features/plugins/PluginHost').then((m) => ({ default: m.PluginHost })))
const MenuPlugin = lazy(() => import('@renderer/features/plugins/PluginHost').then((m) => ({ default: m.MenuPlugin })))

export function MainShell({ onReset }: { onReset: () => void }): React.JSX.Element {
  const state = useConn((s) => s.state)
  const serverUrl = useConn((s) => s.serverUrl)
  const { data: me } = useMe()
  const navigate = useNavigate()
  const loadSpace = useSpace((s) => s.load)
  const { unread } = useUnreadNotices()
  const chatUnread = useChatUnread()
  useNoticeAlerts()
  useChatAlerts()
  useDocAlerts()
  useEventReminders()
  useEventAlerts()
  useTeamAlarms()
  useMorningSummary()
  useMeetingAlerts()
  useWarmCache(state === 'online', me ? !(me.disabledFeatures ?? []).includes('meal') : true)
  usePluginInvites()
  useJoinAlerts(me?.role === 'admin')
  useLedgerAlerts(me?.id)
  const liveMeetings = useLiveMeetings()
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    void loadSpace()
  }, [loadSpace])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F1') {
        e.preventDefault()
        navigate('/help')
      }
      if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  useEffect(() => {
    realtime.start()
    return () => realtime.stop()
  }, [])

  // Check for updates shortly after start, on (re)connect and on update.available (M1-6);
  // the main process repeats the check every 30 minutes. A release the admin marked
  // mandatory is downloaded even when automatic update is turned off.
  useEffect(() => {
    const check = (): void => {
      void api
        .get<{ mandatory: boolean } | null>('/api/updates/latest')
        .catch(() => null)
        .then((r) => invoke('update:check', { serverUrl: serverUrl ?? null, force: !!r?.mandatory }))
        .catch(() => undefined)
    }
    const first = window.setTimeout(check, 20_000)
    const offEvt = realtime.on('update.available', check)
    const offRe = realtime.onReconnect(check)
    return () => {
      window.clearTimeout(first)
      offEvt()
      offRe()
    }
  }, [serverUrl])

  // A PC the server no longer accepts (blocked, removed) must not keep the team's data readable.
  // What the member wrote and could not send yet stays: it is theirs, and is sent if they are let in again.
  useEffect(() => {
    if (state === 'rejected') clearQueryPersist()
  }, [state])

  if (state === 'rejected' || state === 'update-required') return <BlockingScreen onReset={onReset} />

  const isAdmin = me?.role === 'admin'
  const disabled = me?.disabledFeatures ?? []
  return (
    <div className="relative isolate flex h-full flex-col">
      <WallpaperLayer />
      <TopBar
        left={
          <>
            <OrgBadge />
            <ConnChip />
          </>
        }
        center={
          <div className="flex w-full max-w-2xl items-center justify-center gap-2">
            <button className="no-drag flex h-8 w-full max-w-md cursor-pointer items-center gap-2 rounded-md border border-border bg-muted/60 px-2.5 text-sm text-muted-foreground hover:bg-muted" onClick={() => setSearchOpen(true)} data-testid="open-search">
              <Search className="size-4" aria-hidden />
              <span>검색 (Ctrl+K)</span>
            </button>
            <UpdateChip />
          </div>
        }
      />
      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar isAdmin={isAdmin} disabledFeatures={disabled} badges={{ notices: unread, chat: chatUnread.messages + chatUnread.notes, meetings: liveMeetings.data?.length ?? 0, admin: me?.pendingJoins ?? 0, ledger: me?.ledgerUnseen ?? 0 }} />
        <main className="min-w-0 flex-1 overflow-hidden">
          <PageErrorBoundary>
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/home" replace />} />
            <Route path="/home" element={<HomePage />} />
            <Route path="/notices" element={<NoticesPage />} />
            <Route path="/notices/:id" element={<NoticesPage />} />
            <Route path="/groups" element={<GroupsPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/diary" element={<DiaryPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/files/:folderId" element={<FilesPage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chat/:id" element={<ChatPage />} />
            {/* 할 일 was removed: old notifications and bookmarks that point here go home */}
            <Route path="/tasks/*" element={<Navigate to="/home" replace />} />
            <Route path="/boards" element={<BoardsPage />} />
            <Route path="/boards/:boardId" element={<BoardsPage />} />
            <Route path="/boards/:boardId/:postId" element={<BoardsPage />} />
            <Route path="/duty" element={<DutyPage />} />
            <Route path="/org" element={<OrgChartPage />} />
            <Route path="/meal" element={<MenuPlugin id="meal" />} />
            <Route path="/directory" element={<DirectoryPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/docs/:section" element={<DocsPage />} />
            <Route path="/docs/:section/:id" element={<DocsPage />} />
            <Route path="/command/*" element={<CommandPage />} />
            <Route path="/memos" element={<MemosPage />} />
            <Route path="/alarms" element={<AlarmsPage />} />
            <Route path="/utilities" element={<UtilitiesPage />} />
            <Route path="/launcher" element={<LauncherPage />} />
            <Route path="/myfiles" element={<MyFilesPage />} />
            <Route path="/myfiles/:tab" element={<MyFilesPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/ledger" element={<LedgerPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/plugins/:id" element={<PluginHost />} />
            <Route path="/notes/:id" element={<NotesPage />} />
            {MENU.filter((m) => !['home', 'notices', 'calendar', 'diary', 'files', 'chat', 'boards', 'duty', 'org', 'meal', 'directory', 'docs', 'command', 'memos', 'alarms', 'utilities', 'launcher', 'myfiles', 'notes', 'meetings', 'plugins'].includes(m.key)).map((m) => (
              <Route key={m.key} path={`${m.path}/*`} element={<ComingSoon title={m.label} />} />
            ))}
            <Route path="/settings" element={<SettingsPage extra={<ConnectionCard onReset={onReset} />} />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/admin/*" element={isAdmin ? <AdminPage /> : <Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
          </Suspense>
          </PageErrorBoundary>
        </main>
      </div>
      <StatusBar />
      <TransferPanel />
      <ChatDock />
      <CaptureDialog />
    </div>
  )
}
