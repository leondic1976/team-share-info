import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { Clock, Download, ExternalLink, Info, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import type { UpdateSettings, UpdateState } from '@shared/ipc'
import { DOWNLOAD_SITE } from '@shared/constants'
import { heldBackText, SERVER_PC_UPDATE_NOTE } from '@shared/update-policy'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Select } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { invoke, onMain } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { useSession } from '@renderer/app/session-store'

const STATUS: Record<UpdateState['status'], string> = {
  idle: '아직 확인하지 않았습니다.',
  disabled: '개발 실행에서는 업데이트를 쓰지 않습니다.',
  checking: '확인 중…',
  available: '새 버전이 있습니다.',
  downloading: '내려받는 중…',
  downloaded: '설치할 준비가 됐습니다.',
  none: '최신 버전입니다.',
  error: '확인하지 못했습니다.'
}

/** Settings: version, automatic/manual update, update source (8, 배포). */
export function UpdateCard(): React.JSX.Element {
  const app = useSession((s) => s.app)
  const serverUrl = useConn((s) => s.serverUrl)
  const [st, setSt] = useState<UpdateState | null>(null)
  const [cfg, setCfg] = useState<UpdateSettings | null>(null)
  useEffect(() => {
    void invoke('update:getState').then(setSt)
    void invoke('update:getSettings').then(setCfg)
    return onMain('update:state', setSt)
  }, [])
  const save = (c: UpdateSettings): void => {
    setCfg(c)
    void invoke('update:setSettings', c)
  }
  const check = (): void => void invoke('update:check', { serverUrl: serverUrl ?? null, manual: true }).then(setSt)
  const busy = st?.status === 'checking' || st?.status === 'downloading'
  // a member PC waiting for the server PC is not "up to date"
  const statusText = st ? (st.status === 'none' && st.heldBack ? '서버 PC의 업데이트를 기다리는 중입니다.' : STATUS[st.status]) : ''
  const waitingHere = !!st?.serverPc && (st.status === 'available' || st.status === 'downloading' || st.status === 'downloaded')
  return (
    <Card data-testid="update-card">
      <CardHeader>
        <CardTitle>업데이트</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            현재 버전 <b>{app?.version}</b>
          </span>
          <span className="text-muted-foreground">
            · {statusText}
            {st?.version && st.status !== 'none' ? ` (v${st.version})` : ''}
            {st?.status === 'downloading' && st.percent !== undefined ? ` ${st.percent}%` : ''}
            {st?.source ? ` · ${st.source === 'web' ? '다운로드 사이트' : '서버 PC'}에서` : ''}
            {st?.checkedAt ? ` · ${format(st.checkedAt, 'M/d HH:mm')} 확인` : ''}
          </span>
          {st?.status === 'error' && st.message && <span className="text-xs text-urgent">{st.message}</span>}
        </div>
        {st?.heldBack && st.status === 'none' && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="update-held-back">
            <Clock className="mt-px size-3.5 shrink-0" aria-hidden />
            {heldBackText(st.heldBack)}
          </p>
        )}
        {waitingHere && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="update-server-pc-note">
            <Info className="mt-px size-3.5 shrink-0" aria-hidden />
            {SERVER_PC_UPDATE_NOTE}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy} onClick={check}>
            {st?.status === 'checking' ? <Loader2 className="animate-spin" /> : <RefreshCw />} 지금 확인
          </Button>
          {st?.status === 'available' && (
            <Button size="sm" onClick={() => void invoke('update:download').then(setSt)}>
              <Download /> 내려받기
            </Button>
          )}
          {st?.status === 'downloaded' && (
            <Button size="sm" onClick={() => void invoke('update:install')}>
              <RotateCcw /> 설치하고 다시 시작
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => void invoke('app:openExternal', { url: DOWNLOAD_SITE })}>
            <ExternalLink /> 다운로드 사이트·버전 기록
          </Button>
        </div>
        {cfg && (
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex cursor-pointer items-center gap-2">
              <Switch checked={cfg.auto} onCheckedChange={(v) => save({ ...cfg, auto: v })} label="자동 업데이트(새 버전을 알아서 내려받고 다음 실행 때 설치)" />
              자동 업데이트 <span className="text-xs text-muted-foreground">(새 버전을 알아서 내려받고 다음 실행 때 설치)</span>
            </label>
            <label className="flex items-center gap-2">
              <span className="text-muted-foreground">받는 곳</span>
              <Select aria-label="업데이트 받는 곳" className="w-56" value={cfg.source} onChange={(e) => save({ ...cfg, source: e.target.value as UpdateSettings['source'] })}>
                <option value="auto">자동(인터넷 사이트 → 서버 PC)</option>
                <option value="web">다운로드 사이트만</option>
                <option value="lan">서버 PC만(폐쇄망)</option>
              </Select>
            </label>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
