import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { format } from 'date-fns'
import { AlertTriangle, CheckCircle2, CircleHelp, ExternalLink, Folder, Loader2, Play, ShieldCheck, Trash2, XCircle } from 'lucide-react'
import { SETTINGS_SHORTCUTS, SYSTEM_TOOLS, type CheckStatus, type SecurityProgramDto, type SysResources } from '@shared/schemas/sysutil'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { confirmDialog } from '@renderer/components/Dialog'
import { invoke } from '@renderer/lib/bridge'
import { api } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { cn } from '@renderer/lib/utils'

export const fmtBytes = (n: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`
}

function Spark({ values, max = 100, color = 'var(--color-primary)' }: { values: number[]; max?: number; color?: string }): React.JSX.Element {
  const w = 240
  const h = 48
  const m = Math.max(max, ...values, 1)
  const pts = values.map((v, i) => `${(i / Math.max(1, 59)) * w},${h - (v / m) * h}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-12 w-full" preserveAspectRatio="none" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
    </svg>
  )
}

const pct = (a: number, b: number): number => (b ? Math.round((a / b) * 100) : 0)

/** PC resources (6.14 ①): sampled every 2 s while the tab is open. */
export function ResourcesTab(): React.JSX.Element {
  const [hist, setHist] = useState<SysResources[]>([])
  const info = useQuery({ queryKey: ['local', 'sysinfo'], queryFn: () => invoke('sys:info'), networkMode: 'always', staleTime: 600_000 })
  useEffect(() => {
    let alive = true
    const tick = async (): Promise<void> => {
      try {
        const r = await invoke('sys:resources')
        if (alive) setHist((h) => [...h.slice(-59), r])
      } catch {
        // ignore one failed sample
      }
    }
    void tick()
    const t = window.setInterval(() => void tick(), 2000)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])
  const cur = hist[hist.length - 1]
  const memPct = cur ? pct(cur.mem.used, cur.mem.total) : 0
  return (
    <div className="grid min-h-0 flex-1 auto-rows-min gap-4 overflow-y-auto p-5 lg:grid-cols-3" data-testid="sys-resources">
      <Card>
        <CardHeader>
          <CardTitle>CPU</CardTitle>
          <span className={cn('text-lg font-bold', (cur?.cpu ?? 0) >= 90 && 'text-urgent')}>{cur ? `${cur.cpu}%` : '-'}</span>
        </CardHeader>
        <CardContent>
          <Spark values={hist.map((h) => h.cpu)} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>메모리</CardTitle>
          <span className={cn('text-lg font-bold', memPct >= 90 && 'text-urgent')}>{cur ? `${memPct}%` : '-'}</span>
        </CardHeader>
        <CardContent>
          <Spark values={hist.map((h) => pct(h.mem.used, h.mem.total))} color="#16a34a" />
          {cur && (
            <p className="text-xs text-muted-foreground">
              {fmtBytes(cur.mem.used)} / {fmtBytes(cur.mem.total)}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>네트워크</CardTitle>
          <span className="text-xs text-muted-foreground">{cur ? `↓ ${fmtBytes(cur.net.rx)}/s · ↑ ${fmtBytes(cur.net.tx)}/s` : '-'}</span>
        </CardHeader>
        <CardContent>
          <Spark values={hist.map((h) => h.net.rx + h.net.tx)} max={1} color="#9333ea" />
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>드라이브</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {cur?.disks.map((d) => {
            const p = pct(d.used, d.size)
            return (
              <div key={d.mount} className="text-sm">
                <div className="flex justify-between">
                  <span className="font-medium">{d.mount}</span>
                  <span className={cn('text-xs', p >= 90 ? 'font-semibold text-urgent' : 'text-muted-foreground')}>
                    남은 공간 {fmtBytes(d.size - d.used)} / {fmtBytes(d.size)} {p >= 90 && '· 공간 부족'}
                  </span>
                </div>
                <div className="mt-1 h-2 rounded bg-muted">
                  <div className={cn('h-2 rounded', p >= 90 ? 'bg-urgent' : 'bg-primary')} style={{ width: `${p}%` }} />
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>시스템 정보</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-xs">
          {info.data && (
            <>
              <p>PC 이름: {info.data.pcName}</p>
              <p>사용자: {info.data.user}</p>
              <p>운영체제: {info.data.os}</p>
              <p>
                CPU: {info.data.cpu} ({info.data.cores}코어)
              </p>
              <p>메모리: {fmtBytes(info.data.ramTotal)}</p>
              {info.data.ips.map((i) => (
                <p key={i.ip}>
                  {i.iface}: {i.ip} · {i.mac}
                </p>
              ))}
              <p>
                부팅: {format(info.data.bootAt, 'M/d HH:mm')} ({Math.floor((cur?.uptime ?? 0) / 86400)}일 {Math.floor(((cur?.uptime ?? 0) % 86400) / 3600)}시간 경과)
              </p>
            </>
          )}
        </CardContent>
      </Card>
      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>자원을 많이 쓰는 프로그램</CardTitle>
          <Button size="sm" variant="ghost" onClick={() => void invoke('sys:openSetting', { key: 'taskmgr' })}>
            작업 관리자
          </Button>
        </CardHeader>
        <CardContent className="p-2">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">프로그램</th>
                <th className="px-2 py-1 text-right font-medium">CPU</th>
                <th className="px-2 py-1 text-right font-medium">메모리</th>
              </tr>
            </thead>
            <tbody>
              {cur?.top.map((p) => (
                <tr key={p.pid} className="border-t border-border">
                  <td className="px-2 py-1">{p.name}</td>
                  <td className="px-2 py-1 text-right">{p.cpu}%</td>
                  <td className="px-2 py-1 text-right">{p.memMB} MB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  )
}

const STATUS: Record<CheckStatus, { label: string; icon: typeof CheckCircle2; cls: string }> = {
  good: { label: '양호', icon: CheckCircle2, cls: 'text-green-600' },
  warn: { label: '주의', icon: AlertTriangle, cls: 'text-amber-600' },
  bad: { label: '취약', icon: XCircle, cls: 'text-urgent' },
  unknown: { label: '확인 불가', icon: CircleHelp, cls: 'text-muted-foreground' }
}

/** Security check (6.14 ②): personal use only, results kept on this PC. */
export function SecurityTab(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const programs = useQuery({ queryKey: ['security-programs'], queryFn: () => api.get<SecurityProgramDto[]>('/api/security-programs'), enabled: online })
  const history = useQuery({ queryKey: ['local', 'security'], queryFn: () => invoke('security:history'), networkMode: 'always' })
  const run = useMutation({ mutationFn: () => invoke('security:run', { programs: programs.data ?? [] }), onSuccess: () => void history.refetch() })
  const last = history.data?.[0]
  const counts = useMemo(() => {
    const c = { good: 0, warn: 0, bad: 0, unknown: 0 }
    for (const i of last?.items ?? []) c[i.status]++
    return c
  }, [last])
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Button disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />} {run.isPending ? '점검 중… (최대 1분)' : '보안 점검 시작'}
        </Button>
        {last && (
          <span className="text-sm text-muted-foreground" data-testid="security-summary">
            {format(last.runAt, 'yyyy-MM-dd HH:mm')} 점검 · 양호 {counts.good} · 주의 {counts.warn} · 취약 {counts.bad} · 확인 불가 {counts.unknown}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-muted-foreground">점검 결과는 이 PC에만 저장되고 관리자나 서버로 보내지 않습니다. 권한이 없어 읽을 수 없는 항목은 "확인 불가"로 표시됩니다. 30일 넘게 점검하지 않으면 알림이 옵니다.</p>
      {!last && !run.isPending && <p className="text-sm text-muted-foreground">아직 점검한 적이 없습니다.</p>}
      <div className="space-y-2" data-testid="security-items">
        {last?.items.map((i) => {
          const s = STATUS[i.status]
          return (
            <div key={i.key} className="flex items-start gap-3 rounded-md border border-border p-3" data-status={i.status}>
              <s.icon className={cn('mt-0.5 size-5 shrink-0', s.cls)} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-semibold">{i.label}</span>
                  <span className={cn('text-xs font-medium', s.cls)}>{s.label}</span>
                </div>
                <p className="text-sm text-muted-foreground">{i.detail}</p>
                {i.fix && <p className="mt-1 text-sm">조치: {i.fix}</p>}
              </div>
              {i.settings && (
                <Button size="sm" variant="outline" onClick={() => void invoke('sys:openSetting', { key: i.settings! })}>
                  <ExternalLink /> 설정 열기
                </Button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function NetworkTab(): React.JSX.Element {
  const [target, setTarget] = useState('')
  const check = useMutation({ mutationFn: () => invoke('sys:netCheck', { target: target.trim() || undefined }) })
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Button disabled={check.isPending} onClick={() => check.mutate()}>
          {check.isPending ? <Loader2 className="animate-spin" /> : <Play />} 진단 시작
        </Button>
        <Input aria-label="핑 보낼 주소" className="w-64" placeholder="핑 보낼 주소 (선택, 예: 192.168.0.10)" value={target} onChange={(e) => setTarget(e.target.value)} />
      </div>
      <div className="space-y-2" data-testid="net-steps">
        {check.data?.map((s) => {
          const st = STATUS[s.status]
          return (
            <div key={s.key} className="flex items-center gap-3 rounded-md border border-border p-3">
              <st.icon className={cn('size-5 shrink-0', st.cls)} />
              <span className="w-36 shrink-0 font-semibold">{s.label}</span>
              <span className="text-sm text-muted-foreground">{s.detail}</span>
            </div>
          )
        })}
      </div>
      {!check.data && <p className="text-sm text-muted-foreground">네트워크 연결 → 게이트웨이 → TeamHub 서버 → 인터넷 순서로 확인합니다.</p>}
    </div>
  )
}

export function TempTab(): React.JSX.Element {
  const list = useQuery({ queryKey: ['local', 'temp'], queryFn: () => invoke('sys:tempList'), networkMode: 'always', refetchOnMount: 'always' })
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState('')
  const inited = useRef(false)
  useEffect(() => {
    // Preselect entries older than 7 days.
    if (inited.current || !list.data) return
    inited.current = true
    setSel(new Set(list.data.filter((e) => Date.now() - e.mtime > 7 * 86400000).map((e) => e.path)))
  }, [list.data])
  const total = (list.data ?? []).filter((e) => sel.has(e.path)).reduce((s, e) => s + e.size, 0)
  const del = async (): Promise<void> => {
    if (!confirmDialog(`선택한 ${sel.size}개 항목(${fmtBytes(total)})을 지울까요? 지운 파일은 되살릴 수 없습니다.`)) return
    const r = await invoke('sys:tempDelete', { paths: [...sel] })
    setMsg(`${r.deleted}개 삭제 · ${fmtBytes(r.freed)} 확보${r.skipped ? ` · 사용 중이라 ${r.skipped}개 건너뜀` : ''}`)
    setSel(new Set())
    void list.refetch()
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button variant="destructive" disabled={!sel.size} onClick={() => void del()}>
          <Trash2 /> 선택 항목 지우기 ({fmtBytes(total)})
        </Button>
        <Button variant="outline" onClick={() => setSel(new Set((list.data ?? []).map((e) => e.path)))}>
          모두 선택
        </Button>
        <Button variant="ghost" onClick={() => setSel(new Set())}>
          선택 해제
        </Button>
        {msg && (
          <span className="text-sm text-primary" role="status">
            {msg}
          </span>
        )}
      </div>
      <p className="mb-2 text-xs text-muted-foreground">내 계정의 임시 폴더 목록입니다. 7일 지난 항목이 미리 선택됩니다. 확인 후 지우세요.</p>
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border" data-testid="temp-list">
        {(list.data ?? []).map((e) => (
          <label key={e.path} className="flex cursor-pointer items-center gap-2 border-b border-border px-3 py-1 text-sm last:border-0 hover:bg-muted">
            <input type="checkbox" checked={sel.has(e.path)} onChange={(ev) => setSel((s) => (ev.target.checked ? new Set([...s, e.path]) : new Set([...s].filter((x) => x !== e.path))))} />
            <span className="truncate">
              {e.dir && <Folder className="mr-1 inline size-3.5 align-[-0.15em]" aria-label="폴더" />}
              {e.name}
            </span>
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{fmtBytes(e.size)}</span>
            <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">{format(e.mtime, 'yyyy-MM-dd')}</span>
          </label>
        ))}
        {list.data && !list.data.length && <p className="p-4 text-center text-sm text-muted-foreground">임시 파일이 없습니다.</p>}
      </div>
    </div>
  )
}

export function SettingsShortcutsTab(): React.JSX.Element {
  const groups = [...new Set(SETTINGS_SHORTCUTS.map((s) => s.group))]
  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
      {groups.map((g) => (
        <section key={g}>
          <h3 className="mb-2 text-sm font-semibold text-muted-foreground">{g}</h3>
          <div className="flex flex-wrap gap-2">
            {SETTINGS_SHORTCUTS.filter((s) => s.group === g).map((s) => (
              <Button key={s.key} variant="outline" onClick={() => void invoke('sys:openSetting', { key: s.key })}>
                {s.label}
              </Button>
            ))}
          </div>
        </section>
      ))}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-muted-foreground">도구</h3>
        <div className="flex flex-wrap gap-2">
          {SYSTEM_TOOLS.map((s) => (
            <Button key={s.key} variant="outline" onClick={() => void invoke('sys:openSetting', { key: s.key })}>
              {s.label}
            </Button>
          ))}
        </div>
      </section>
    </div>
  )
}
