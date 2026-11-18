import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Radar, Send, Server } from 'lucide-react'
import { SetupFrame, Field } from './SetupFrame'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import { invoke } from '@renderer/lib/bridge'
import { request, errorMessage } from '@renderer/lib/api'
import { DEFAULT_PORT } from '@shared/constants'
import { toServerUrl } from '@shared/net'
import type { DiscoveredServer } from '@shared/ipc'
import type { Hello, JoinPoll } from '@shared/schemas/auth'
import { useConn } from '@renderer/app/conn-store'

/** Client first run: find the server, enter my info, send a join request (M1-3). */
export function JoinScreen({ onBack, onSubmitted }: { onBack: () => void; onSubmitted: () => void }): React.JSX.Element {
  const conn = useConn()
  const [address, setAddress] = useState('')
  const [found, setFound] = useState<DiscoveredServer[] | null>(null)
  const [scanning, setScanning] = useState(false)
  const [hello, setHello] = useState<Hello | null>(null)
  const [name, setName] = useState('')
  const [dept, setDept] = useState('')
  const [title, setTitle] = useState('')
  const [ext, setExt] = useState('')
  const [agree, setAgree] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const scan = async (): Promise<void> => {
    setScanning(true)
    setError('')
    try {
      setFound(await invoke('discovery:scan'))
    } finally {
      setScanning(false)
    }
  }

  useEffect(() => {
    void scan()
  }, [])

  const check = async (addr = address): Promise<void> => {
    setError('')
    setHello(null)
    const url = toServerUrl(addr, DEFAULT_PORT)
    if (!url) {
      setError('서버 주소 형식이 올바르지 않습니다. 예: 192.168.10.5')
      return
    }
    setBusy(true)
    try {
      const h = await request<Hello>('/api/hello', { baseUrl: url, noAuth: true })
      if (!h.initialized) throw new Error('서버 설정이 아직 끝나지 않았습니다.')
      setAddress(url.replace('http://', ''))
      setHello(h)
    } catch (e) {
      setError(`서버에 연결할 수 없습니다: ${errorMessage(e)}`)
    } finally {
      setBusy(false)
    }
  }

  const submit = async (): Promise<void> => {
    const url = toServerUrl(address, DEFAULT_PORT)
    if (!url || !hello) return
    if (!name.trim()) {
      setError('이름을 입력하세요.')
      return
    }
    if (!agree) {
      setError('안내 사항에 동의해야 사용할 수 있습니다.')
      return
    }
    setBusy(true)
    setError('')
    try {
      // the unique value of this PC lets the server give the same account back when the PC asks again
      const pcUid = await invoke('conn:pcUid')
      const r = await request<{ requestId: string; pollToken: string }>('/api/join', {
        method: 'POST',
        baseUrl: url,
        noAuth: true,
        body: { name: name.trim(), deptName: dept, title, ext, pcName: conn.pcName, winUser: conn.winUser, appVersion: conn.appVersion, pcUid }
      })
      await invoke('conn:setPending', { serverUrl: url, requestId: r.requestId, pollToken: r.pollToken, name: name.trim() })
      await invoke('local:kv.set', { key: 'consentAt', value: Date.now() })
      onSubmitted()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SetupFrame title="서버에 접속" subtitle="서버 PC의 주소를 입력하고 사용 신청을 합니다.">
      <Card>
        <CardContent className="space-y-4">
          <Field label="서버 주소" hint="관리자에게 받은 주소(예: 192.168.10.5). 포트가 다르면 192.168.10.5:47800 처럼 입력합니다.">
            <div className="flex gap-2">
              <Input
                aria-label="서버 주소"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setHello(null)
                }}
                onKeyDown={(e) => e.key === 'Enter' && void check()}
                placeholder="192.168.10.5"
                autoFocus
              />
              <Button variant="outline" onClick={() => void check()} disabled={busy || !address.trim()}>
                {busy && !hello ? <Loader2 className="animate-spin" /> : <Server />} 연결 확인
              </Button>
            </div>
          </Field>
          <div>
            <div className="mb-1.5 flex items-center gap-2 text-sm font-medium">
              자동으로 찾은 서버
              <Button size="sm" variant="ghost" onClick={() => void scan()} disabled={scanning}>
                {scanning ? <Loader2 className="animate-spin" /> : <Radar />} 다시 찾기
              </Button>
            </div>
            {found?.length ? (
              <div className="space-y-1.5" data-testid="discovered">
                {found.map((s) => (
                  <button
                    key={s.url}
                    className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:border-primary"
                    onClick={() => void check(`${s.address}:${s.port}`)}
                  >
                    <Server className="size-4 text-primary" />
                    <span className="font-semibold">
                      {s.orgName} {s.teamName}
                    </span>
                    <span className="ml-auto text-muted-foreground">
                      {s.address}:{s.port}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{scanning ? '찾는 중…' : '찾은 서버가 없습니다. 주소를 직접 입력하세요.'}</p>
            )}
          </div>

          {hello && (
            <div className="space-y-3 border-t border-border pt-4">
              <p className="text-sm">
                <span className="font-semibold">
                  {hello.orgName} {hello.teamName}
                </span>{' '}
                서버에 사용 신청을 합니다.
              </p>
              <div className="grid grid-cols-2 gap-3">
                <Field label="이름">
                  <Input aria-label="이름" value={name} onChange={(e) => setName(e.target.value)} />
                </Field>
                <Field label="부서">
                  <Input aria-label="부서" value={dept} onChange={(e) => setDept(e.target.value)} />
                </Field>
                <Field label="직위">
                  <Input aria-label="직위" value={title} onChange={(e) => setTitle(e.target.value)} />
                </Field>
                <Field label="내선번호">
                  <Input aria-label="내선번호" value={ext} onChange={(e) => setExt(e.target.value)} />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">
                이 PC: {conn.pcName} · Windows 계정: {conn.winUser}
              </p>
              <label className="flex cursor-pointer items-start gap-2 rounded-md bg-[var(--notice-bg)] px-3 py-2 text-sm text-[var(--notice-fg)]">
                <input type="checkbox" className="mt-0.5" checked={agree} onChange={(e) => setAgree(e.target.checked)} aria-label="안내 동의" />
                <span>{hello.noticeText} 이 안내를 확인했습니다.</span>
              </label>
              <Button onClick={() => void submit()} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <Send />} 사용 신청
              </Button>
            </div>
          )}
          {error && (
            <p className="rounded-md bg-urgent/10 px-3 py-2 text-sm text-urgent" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      <Button variant="ghost" className="mt-4" onClick={onBack}>
        <ArrowLeft /> 처음으로
      </Button>
    </SetupFrame>
  )
}

/** Waiting for the admin's approval; polls every 3 seconds. */
export function PendingScreen({ onApproved, onReset }: { onApproved: () => void; onReset: () => void }): React.JSX.Element {
  const [state, setState] = useState<'pending' | 'rejected' | 'error'>('pending')
  const [info, setInfo] = useState<{ serverUrl: string; name: string } | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    const poll = async (): Promise<void> => {
      const c = await invoke('conn:get')
      const p = c.pending
      if (!p) return
      setInfo({ serverUrl: p.serverUrl, name: p.name })
      try {
        const r = await request<JoinPoll>(`/api/join/${p.requestId}`, { baseUrl: p.serverUrl, noAuth: true, query: { token: p.pollToken } })
        if (!alive) return
        if (r.state === 'approved' && r.deviceId && r.deviceKey && r.memberId) {
          await invoke('conn:saveDevice', { serverUrl: p.serverUrl, deviceId: r.deviceId, deviceKey: r.deviceKey, memberId: r.memberId })
          onApproved()
          return
        }
        if (r.state === 'rejected') {
          setState('rejected')
          return
        }
        setState('pending')
      } catch {
        if (alive) setState('error')
      }
      if (alive) timer.current = window.setTimeout(() => void poll(), 3000)
    }
    void poll()
    return () => {
      alive = false
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [onApproved])

  return (
    <SetupFrame title={state === 'rejected' ? '사용 신청이 거절되었습니다' : '승인 대기 중'} subtitle={info ? `${info.serverUrl.replace('http://', '')} · ${info.name}` : undefined}>
      <Card>
        <CardContent className="space-y-3 text-sm">
          {state === 'pending' && (
            <p className="flex items-center gap-2" data-testid="pending">
              <Loader2 className="size-4 animate-spin text-primary" /> 관리자가 서버 PC에서 승인하면 자동으로 시작됩니다.
            </p>
          )}
          {state === 'error' && <p className="text-important">서버에 연결할 수 없습니다. 서버 PC가 켜져 있는지 확인하세요. 계속 다시 시도합니다.</p>}
          {state === 'rejected' && <p>관리자에게 문의한 뒤 다시 신청하세요.</p>}
          <Button
            variant="outline"
            onClick={async () => {
              await invoke('conn:reset')
              onReset()
            }}
          >
            신청 취소하고 처음으로
          </Button>
        </CardContent>
      </Card>
    </SetupFrame>
  )
}
