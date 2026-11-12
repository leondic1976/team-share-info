import { useEffect } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { TopBar } from './TopBar'
import { OrgBadge } from './OrgBadge'
import { StatusBar } from './StatusBar'
import { MENU } from './menu'
import { useConn } from './conn-store'
import { realtime } from '@renderer/lib/realtime'
import { useMe } from '@renderer/lib/queries'
import { invoke } from '@renderer/lib/bridge'
import { ComingSoon } from '@renderer/features/placeholder/ComingSoon'
import { SettingsPage } from '@renderer/features/settings/SettingsPage'
import { ConnectionCard } from '@renderer/features/settings/ConnectionCard'
import { AdminPage } from '@renderer/features/admin/AdminPage'
import { HomePage } from '@renderer/features/home/HomePage'
import { BlockingScreen } from './BlockingScreen'
import { HelpPage } from '@renderer/features/help/HelpPage'
import { NoticesPage } from '@renderer/features/notices/NoticesPage'
import { GroupsPage } from '@renderer/features/groups/GroupsPage'
import { useNoticeAlerts, useUnreadNotices } from '@renderer/features/notices/useNoticeAlerts'
import { useSpace } from './space-store'
import { CalendarPage } from '@renderer/features/calendar/CalendarPage'
import { useEventReminders } from '@renderer/features/calendar/useEventReminders'
import { DiaryPage } from '@renderer/features/diary/DiaryPage'
import { FilesPage } from '@renderer/features/files/FilesPage'
import { TransferPanel } from '@renderer/features/files/TransferPanel'
import { ChatPage } from '@renderer/features/chat/ChatPage'
import { useChatAlerts, useChatUnread } from '@renderer/features/chat/useChatAlerts'
import { TasksPage } from '@renderer/features/tasks/TasksPage'
import { useTaskAlerts } from '@renderer/features/tasks/useTaskAlerts'
import { BoardsPage } from '@renderer/features/boards/BoardsPage'
import { DirectoryPage } from '@renderer/features/directory/DirectoryPage'
import { DocsPage } from '@renderer/features/docs/DocsPage'
import { useDocAlerts } from '@renderer/features/docs/useDocAlerts'
import { MemosPage } from '@renderer/features/memos/MemosPage'
import { CaptureDialog } from '@renderer/features/memos/CaptureDialog'
import { AlarmsPage } from '@renderer/features/alarms/AlarmsPage'
import { useMorningSummary, useTeamAlarms } from '@renderer/features/alarms/useTeamAlarms'
import { UtilitiesPage } from '@renderer/features/utilities/UtilitiesPage'
import { LauncherPage } from '@renderer/features/launcher/LauncherPage'
import { MyFilesPage } from '@renderer/features/myfiles/MyFilesPage'
import { NotesPage } from '@renderer/features/notes/NotesPage'
import { PluginsPage } from '@renderer/features/plugins/PluginsPage'
import { PluginHost } from '@renderer/features/plugins/PluginHost'
import { usePluginInvites } from '@renderer/features/plugins/usePluginInvites'
import { MeetingsPage, useLiveMeetings, useMeetingAlerts } from '@renderer/features/meetings/MeetingsPage'

const CHECK_UPDATE_MS = 30 * 60 * 1000

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
  useTaskAlerts()
  useDocAlerts()
  useEventReminders()
  useTeamAlarms()
  useMorningSummary()
  useMeetingAlerts()
  usePluginInvites()
  const liveMeetings = useLiveMeetings()

  useEffect(() => {
    void loadSpace()
  }, [loadSpace])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'F1') {
        e.preventDefault()
        navigate('/help')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  useEffect(() => {
    realtime.start()
    return () => realtime.stop()
  }, [])

  // Check for updates (web site first, then the server PC) at start, on connect,
  // on update.available, and every 30 minutes (M1-6).
  useEffect(() => {
    const check = (): void => void invoke('update:check', { serverUrl: serverUrl ?? null }).catch(() => undefined)
    const first = window.setTimeout(check, 20_000)
    const offEvt = realtime.on('update.available', check)
    const offRe = realtime.onReconnect(check)
    const t = window.setInterval(check, CHECK_UPDATE_MS)
    return () => {
      window.clearTimeout(first)
      offEvt()
      offRe()
      window.clearInterval(t)
    }
  }, [serverUrl])

  if (state === 'rejected' || state === 'update-required') return <BlockingScreen onReset={onReset} />

  const isAdmin = me?.role === 'admin'
  const disabled = me?.disabledFeatures ?? []
  return (
    <div className="flex h-full flex-col">
      <TopBar left={<OrgBadge />} />
      <div className="flex min-h-0 flex-1">
        <Sidebar isAdmin={isAdmin} disabledFeatures={disabled} badges={{ notices: unread, chat: chatUnread.messages + chatUnread.notes, meetings: liveMeetings.data?.length ?? 0 }} />
        <main className="min-w-0 flex-1 overflow-hidden">
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
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/boards" element={<BoardsPage />} />
            <Route path="/boards/:boardId" element={<BoardsPage />} />
            <Route path="/boards/:boardId/:postId" element={<BoardsPage />} />
            <Route path="/directory" element={<DirectoryPage />} />
            <Route path="/docs" element={<DocsPage />} />
            <Route path="/docs/:section" element={<DocsPage />} />
            <Route path="/docs/:section/:id" element={<DocsPage />} />
            <Route path="/memos" element={<MemosPage />} />
            <Route path="/alarms" element={<AlarmsPage />} />
            <Route path="/utilities" element={<UtilitiesPage />} />
            <Route path="/launcher" element={<LauncherPage />} />
            <Route path="/myfiles" element={<MyFilesPage />} />
            <Route path="/myfiles/:tab" element={<MyFilesPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/meetings" element={<MeetingsPage />} />
            <Route path="/plugins" element={<PluginsPage />} />
            <Route path="/plugins/:id" element={<PluginHost />} />
            <Route path="/notes/:id" element={<NotesPage />} />
            {MENU.filter((m) => !['home', 'notices', 'calendar', 'diary', 'files', 'chat', 'tasks', 'boards', 'directory', 'docs', 'memos', 'alarms', 'utilities', 'launcher', 'myfiles', 'notes', 'meetings', 'plugins'].includes(m.key)).map((m) => (
              <Route key={m.key} path={`${m.path}/*`} element={<ComingSoon title={m.label} />} />
            ))}
            <Route path="/settings" element={<SettingsPage extra={<ConnectionCard onReset={onReset} />} />} />
            <Route path="/help" element={<HelpPage />} />
            <Route path="/admin/*" element={isAdmin ? <AdminPage /> : <Navigate to="/home" replace />} />
            <Route path="*" element={<Navigate to="/home" replace />} />
          </Routes>
        </main>
      </div>
      <StatusBar />
      <TransferPanel />
      <CaptureDialog />
    </div>
  )
}
