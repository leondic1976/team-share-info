import { useCallback, useEffect, useState } from 'react'
import { usePrefs } from './app/prefs-store'
import { useSession } from './app/session-store'
import { useConn } from './app/conn-store'
import { invoke, localKv, onMain } from './lib/bridge'
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
import { FeedbackWindow } from './features/feedback/FeedbackWindow'
import { LockedSmall, LockGate } from './features/lock/LockGate'
import { LogoutWarning } from './features/seat/LogoutWarning'
import { PreviewPopup } from '@renderer/features/chat/PreviewPopup'
import { playMessageSound } from '@renderer/lib/message-sound'

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
    const [hello, me] = await Promise.all([
      info.serverUrl ? localKv.get<Hello>(`hello:${info.serverUrl}`) : null,
      info.memberId ? localKv.get<MeDto>(`me:${info.memberId}`).then((m) => m ?? localKv.get<MeDto>('lastMe')) : null
    ])
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

  // the alert sound ("팀뿌요~") of every alert is played by the TeamHub window (also hidden or locked)
  useEffect(() => {
    if (window.location.hash.startsWith('#/popup/')) return
    return onMain('app:sound', () => playMessageSound())
  }, [])

  // Popup windows reuse this bundle with their own hash route.
  const hash = window.location.hash
  // the cards of new messages near the tray (content is masked by the main process while locked)
  if (hash.startsWith('#/popup/preview')) return loaded ? <PreviewPopup /> : <></>
  const popup = /^#\/popup\/urgent\/([\w-]+)/.exec(hash)
  if (popup) return loaded ? <UrgentPopup id={popup[1]} /> : <Loading />
  const alarm = /^#\/popup\/alarm\/([\w-]+)/.exec(hash)
  if (alarm) return loaded ? <AlarmPopup pid={alarm[1]} /> : <Loading />
  const sticky = /^#\/popup\/sticky\/([\w-]+)/.exec(hash)
  // personal content stays hidden while the program is locked; notices, alarms and calls still come through
  if (sticky)
    return loaded ? (
      <LockedSmall>
        <StickyWindow id={sticky[1]} />
      </LockedSmall>
    ) : (
      <Loading />
    )
  if (hash.startsWith('#/popup/quickmemo'))
    return loaded ? (
      <LockedSmall>
        <QuickMemo />
      </LockedSmall>
    ) : (
      <Loading />
    )
  if (hash.startsWith('#/popup/launcher'))
    return loaded ? (
      <LockedSmall>
        <LauncherBar />
      </LockedSmall>
    ) : (
      <Loading />
    )
  const room = /^#\/popup\/meeting\/([\w-]+)/.exec(hash)
  if (room) return loaded ? <MeetingRoom id={room[1]} /> : <Loading />
  const inv = /^#\/popup\/invite\/([\w-]+)/.exec(hash)
  if (inv) return loaded ? <InvitePopup id={inv[1]} /> : <Loading />
  // shared PC: the notice before the automatic logout (nothing personal in it, so it shows while locked too)
  if (hash.startsWith('#/popup/logout')) return loaded ? <LogoutWarning /> : <Loading />
  if (hash.startsWith('#/popup/feedback'))
    return loaded ? (
      <LockedSmall>
        <FeedbackWindow />
      </LockedSmall>
    ) : (
      <Loading />
    )

  if (!loaded || screen === 'loading') return <Loading />
  return <LockGate>{mainScreen()}</LockGate>

  function mainScreen(): React.JSX.Element {
    switch (screen) {
      case 'first-run':
        return (
          <FirstRun
            onChoose={(m) => setScreen(m === 'server' ? 'wizard' : m === 'import' ? 'import' : 'join')}
          />
        )
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
      default:
        return <Loading />
    }
  }
}
