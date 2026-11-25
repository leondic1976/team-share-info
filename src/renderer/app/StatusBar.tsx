import { AlertTriangle, Download } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useConn, type ConnState } from './conn-store'
import { useSession } from './session-store'
import { useOrgDisplay } from '@renderer/lib/queries'
import { invoke, onMain } from '@renderer/lib/bridge'
import type { UpdateState } from '@shared/ipc'
import { cn } from '@renderer/lib/utils'
import { RoleMark } from '@renderer/components/RoleMark'

const CONN_LABEL: Record<ConnState, { text: string; dot: string }> = {
  loading: { text: '준비 중', dot: 'bg-muted-foreground' },
  unconfigured: { text: '서버 미설정', dot: 'bg-muted-foreground' },
  connecting: { text: '서버 연결 중', dot: 'bg-important animate-pulse' },
  online: { text: '서버 연결됨', dot: 'bg-success' },
  offline: { text: '서버 연결 끊김 · 보관된 내용 표시 중(자동 재접속)', dot: 'bg-urgent animate-pulse' },
  pending: { text: '승인 대기 중', dot: 'bg-important' },
  rejected: { text: '사용 중지됨', dot: 'bg-urgent' },
  'update-required': { text: '업데이트 필요', dot: 'bg-urgent' }
}

/**
 * Always-visible footer (5.1): safety notice on line 1, org/user/connection/version on line 2.
 * It cannot be hidden by the user.
 */
export function StatusBar(): React.JSX.Element {
  const app = useSession((s) => s.app)
  const conn = useConn((s) => s.state)
  const me = useConn((s) => s.me)
  const org = useOrgDisplay()
  const [upd, setUpd] = useState<UpdateState | null>(null)
  useEffect(() => {
    void invoke('update:getState').then(setUpd)
    return onMain('update:state', setUpd)
  }, [])
  const c = CONN_LABEL[conn]
  const orgText = [org.orgName, org.teamName].filter(Boolean).join(' ') || '소속 미설정'
  return (
    <footer className="h-[52px] shrink-0 border-t border-border text-[0.8rem]" data-testid="status-bar">
      <div
        className="flex h-[26px] items-center gap-1.5 px-3 font-medium"
        style={{ background: 'var(--notice-bg)', color: 'var(--notice-fg)' }}
        role="note"
      >
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate" data-testid="notice-text">
          {org.noticeText}
        </span>
      </div>
      <div className="flex h-[26px] items-center gap-3 px-3 text-muted-foreground">
        <span className="truncate font-medium text-foreground" data-testid="org-text">
          {orgText}
        </span>
        <span className="text-border">│</span>
        <span className="truncate">
          {me?.name ?? app?.winUser ?? ''}
          {me && <RoleMark role={me.role} isOwner={me.isOwner} />}
        </span>
        <span className="text-border">│</span>
        <span className="flex items-center gap-1.5 whitespace-nowrap" data-testid="conn-state">
          <span className={cn('inline-block size-2 rounded-full', c.dot)} />
          {c.text}
        </span>
        <span className="ml-auto flex items-center gap-2 whitespace-nowrap">
          {upd?.status === 'downloading' && <span>업데이트 받는 중 {upd.percent ?? 0}%</span>}
          {upd?.status === 'downloaded' && (
            <button
              className="flex cursor-pointer items-center gap-1 rounded bg-primary px-1.5 font-medium text-primary-foreground"
              onClick={() => void invoke('update:install')}
            >
              <Download className="size-3" /> v{upd.version} 설치(다시 시작)
            </button>
          )}
          <span data-testid="app-version">
            v{app?.version ?? ''}
            {app?.profile ? ` (${app.profile})` : ''}
          </span>
        </span>
      </div>
    </footer>
  )
}
