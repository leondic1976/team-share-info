import { useCallback, useEffect, useState } from 'react'
import { usePrefs } from './app/prefs-store'
import { useSession } from './app/session-store'
import { useConn } from './app/conn-store'
import { invoke, localKv } from './lib/bridge'
import { queryClient } from './lib/query-client'
import { startQueryPersist } from './lib/query-persist'
import type { Hello, MeDto } from '@shared/schemas/auth'
import { Loading } from './components/EmptyState'
import { FirstRun } from './features/setup/FirstRun'
import { ServerWizard } from './features/setup/ServerWizard'
import { ImportServer } from './features/setup/ImportServer'
import { JoinScreen, PendingScreen } from './features/setup/JoinScreen'
import { MainShell } from './app/MainShell'
import { UrgentPopup } from './features/notices/UrgentPopup'
import { AlarmPopup } from './features/alarms/AlarmPopup'
import { QuickMemo, StickyWindow } from './features/memos/StickyWindow'
import { LauncherBar } from './features/launcher/LauncherBar'
import { MeetingRoom } from './features/meetings/MeetingRoom'
import { InvitePopup } from './features/meetings/InvitePopup'

type Screen = 'loading' | 'first-run' | 'wizard' | 'join' | 'pending' | 'main' | 'import'

/** Decides which top-level screen to show based on the connection identity of this PC. */
export function App(): React.JSX.Element {
  const loaded = usePrefs((s) => s.loaded)
  const loadPrefs = usePrefs((s) => s.load)
  const setApp = useSession((s) => s.setApp)
  const loadConn = useConn((s) => s.load)
  const [screen, setScreen] = useState<Screen>('loading')

  const refresh = useCallback(async () => {
    const info = await invoke('conn:get')
    loadConn(info)
    // Restore the last known org info and profile so the footer is right while offline (13.11).
    const [hello, me] = await Promise.all([localKv.get<Hello>('lastHello'), localKv.get<MeDto>('lastMe')])
    if (hello && info.serverUrl) queryClient.setQueryData(['hello', info.serverUrl], hello)
    if (me && info.memberId === me.id) useConn.getState().setMe(me)
    // Last results seen are shown at once, also while the server is unreachable (13.11).
    if (info.deviceId && info.memberId) await startQueryPersist(info.memberId)
    if (info.deviceId) setScreen('main')
    else if (info.pending) setScreen('pending')
    else setScreen('first-run')
  }, [loadConn])

  useEffect(() => {
    void loadPrefs()
    void invoke('app:getInfo').then(setApp)
    if (!window.location.hash.startsWith('#/popup/')) void refresh()
  }, [loadPrefs, setApp, refresh])

  // Popup windows reuse this bundle with their own hash route.
  const hash = window.location.hash
  const popup = /^#\/popup\/urgent\/([\w-]+)/.exec(hash)
  if (popup) return loaded ? <UrgentPopup id={popup[1]} /> : <Loading />
  const alarm = /^#\/popup\/alarm\/([\w-]+)/.exec(hash)
  if (alarm) return loaded ? <AlarmPopup pid={alarm[1]} /> : <Loading />
  const sticky = /^#\/popup\/sticky\/([\w-]+)/.exec(hash)
  if (sticky) return loaded ? <StickyWindow id={sticky[1]} /> : <Loading />
  if (hash.startsWith('#/popup/quickmemo')) return loaded ? <QuickMemo /> : <Loading />
  if (hash.startsWith('#/popup/launcher')) return loaded ? <LauncherBar /> : <Loading />
  const room = /^#\/popup\/meeting\/([\w-]+)/.exec(hash)
  if (room) return loaded ? <MeetingRoom id={room[1]} /> : <Loading />
  const inv = /^#\/popup\/invite\/([\w-]+)/.exec(hash)
  if (inv) return loaded ? <InvitePopup id={inv[1]} /> : <Loading />

  if (!loaded || screen === 'loading') return <Loading />
  switch (screen) {
    case 'first-run':
      return <FirstRun onChoose={(m) => setScreen(m === 'server' ? 'wizard' : m === 'import' ? 'import' : 'join')} />
    case 'import':
      return <ImportServer onBack={() => setScreen('first-run')} onDone={() => void refresh()} />
    case 'wizard':
      return <ServerWizard onBack={() => setScreen('first-run')} onDone={() => void refresh()} />
    case 'join':
      return <JoinScreen onBack={() => setScreen('first-run')} onSubmitted={() => setScreen('pending')} />
    case 'pending':
      return <PendingScreen onApproved={() => void refresh()} onReset={() => void refresh()} />
    case 'main':
      return <MainShell onReset={() => void refresh()} />
  }
}
