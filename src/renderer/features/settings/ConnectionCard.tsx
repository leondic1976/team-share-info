import { useEffect, useState } from 'react'
import { Lock, Radar, Loader2, RotateCcw, Server } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { useConn } from '@renderer/app/conn-store'
import { invoke, onMain } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { request, errorMessage } from '@renderer/lib/api'
import { toServerUrl } from '@shared/net'
import { DEFAULT_PORT } from '@shared/constants'
import type { DiscoveredServer } from '@shared/ipc'
import type { ServerStatus } from '@shared/server-host'
import type { Hello } from '@shared/schemas/auth'

/** Settings > connection: server address, rediscovery (M1-5), server process status. */
export function ConnectionCard({ onReset }: { onReset: () => void }): React.JSX.Element {
  const conn = useConn()
  const [addr, setAddr] = useState(conn.serverUrl?.replace('http://', '') ?? '')
  const [found, setFound] = useState<DiscoveredServer[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [server, setServer] = useState<ServerStatus | null>(null)

  useEffect(() => {
    if (conn.mode !== 'server') return
    void invoke('server:status').then(setServer)
    return onMain('server:status', setServer)
  }, [conn.mode])

  const apply = async (input: string): Promise<void> => {
    const url = toServerUrl(input, DEFAULT_PORT)
    if (!url) {
      setMsg('주소 형식이 올바르지 않습니다.')
      return
    }
    setBusy(true)
    try {
      await request<Hello>('/api/hello', { baseUrl: url, noAuth: true })
      await invoke('conn:updateServerUrl', { serverUrl: url })
      useConn.getState().load(await invoke('conn:get'))
      realtime.reconnect()
      setAddr(url.replace('http://', ''))
      setMsg('서버 주소를 바꿨습니다.')
    } catch (e) {
      setMsg(`연결 실패: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>서버 연결</CardTitle>
        <span className="text-xs text-muted-foreground">{conn.mode === 'server' ? '이 PC가 서버입니다' : '팀원 PC'}</span>
      </CardHeader>
      <CardContent className="space-y-3">
        {conn.mode === 'server' ? (
          <div className="space-y-2 text-sm">
            <p>
              서버 상태:{' '}
              <b data-testid="server-state">
                {server?.state === 'running' ? `실행 중 (포트 ${server.port})` : server?.state === 'error' ? `오류: ${server.message}` : server?.state ?? '…'}
              </b>
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={async () => setServer(await invoke('server:restart'))}>
                <RotateCcw /> 서버 다시 시작
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={async () => {
                  const r = await invoke('server:registerFirewall')
                  setMsg(r.message)
                }}
              >
                방화벽 규칙 다시 등록
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-2">
              <Input aria-label="서버 주소" value={addr} onChange={(e) => setAddr(e.target.value)} />
              <Button variant="outline" onClick={() => void apply(addr)} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Server />} 적용
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  setBusy(true)
                  setFound(await invoke('discovery:scan'))
                  setBusy(false)
                }}
                disabled={busy}
              >
                <Radar /> 서버 다시 찾기
              </Button>
            </div>
            {found && (
              <div className="space-y-1">
                {found.length === 0 && <p className="text-xs text-muted-foreground">찾은 서버가 없습니다.</p>}
                {found.map((s) => (
                  <button
                    key={s.url}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm hover:border-primary"
                    onClick={() => void apply(`${s.address}:${s.port}`)}
                  >
                    {s.orgName} {s.teamName}
                    <span className="ml-auto text-muted-foreground">
                      {s.address}:{s.port}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </>
        )}
        {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
        <div className="space-y-1 border-t border-border pt-3 text-sm" data-testid="pc-identity">
          <div className="flex items-center gap-1.5 font-medium">
            <Lock className="size-3.5" /> 이 PC
          </div>
          <dl className="selectable grid grid-cols-[6rem_1fr] gap-y-0.5 text-xs">
            <dt className="text-muted-foreground">용도</dt>
            <dd>{conn.mode === 'server' ? '서버용 PC' : '일반용(팀원) PC'} — 처음 설정한 대로 고정되며 바꿀 수 없습니다.</dd>
            <dt className="text-muted-foreground">고유값</dt>
            <dd className="font-mono">{conn.pcUid ?? '만드는 중…'}</dd>
          </dl>
          <p className="text-xs text-muted-foreground">
            고유값은 이 PC를 다른 PC와 구별하는 값입니다. 서버는 이 값으로 같은 PC를 알아보므로, 다시 신청해도 계정이 하나 더 생기지 않습니다.
          </p>
        </div>
        <div className="border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-urgent"
            onClick={async () => {
              if (!window.confirm('이 PC의 서버 연결 정보를 지우고 처음 화면으로 돌아갑니다. 다시 쓰려면 같은 용도(' + (conn.mode === 'server' ? '서버용' : '일반용') + ' PC)로 새로 설정해야 합니다. 개인 데이터(로컬)는 유지됩니다. 계속할까요?')) return
              realtime.stop()
              await invoke('conn:reset')
              onReset()
            }}
          >
            연결 초기화(처음부터 다시 설정)
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
