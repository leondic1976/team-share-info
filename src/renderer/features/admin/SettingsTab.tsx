import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save } from 'lucide-react'
import type { AllSettings } from '@shared/schemas/settings'
import type { FeatureKey } from '@shared/constants'
import { api, errorMessage, setAdminPin } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Field } from '@renderer/features/setup/SetupFrame'
import { Loading } from '@renderer/components/EmptyState'
import { MENU } from '@renderer/app/menu'

export function SettingsTab(): React.JSX.Element {
  const qc = useQueryClient()
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<AllSettings>('/api/admin/settings') })
  const [s, setS] = useState<AllSettings | null>(null)
  const [cidrs, setCidrs] = useState('')
  const [blocked, setBlocked] = useState('')
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    if (q.data && !s) {
      setS(q.data)
      setCidrs(q.data.network.allowedCidrs.join(', '))
      setBlocked(q.data.storage.blockedExtensions.join(', '))
    }
  }, [q.data, s])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.put<AllSettings>('/api/admin/settings', body),
    onSuccess: (data, body) => {
      setS(data)
      if (typeof body.adminPin === 'string') {
        setAdminPin(body.adminPin)
        setPin('')
      }
      setMsg({ ok: true, text: '저장했습니다.' })
      void qc.invalidateQueries()
    },
    onError: (e) => setMsg({ ok: false, text: errorMessage(e) })
  })

  if (!s) return <Loading />
  const upd = <K extends keyof AllSettings>(k: K, patch: Partial<AllSettings[K]>): void => setS({ ...s, [k]: { ...s[k], ...patch } })
  const toggleFeature = (key: FeatureKey, on: boolean): void => {
    const set = new Set(s.ops.disabledFeatures)
    if (on) set.delete(key)
    else set.add(key)
    upd('ops', { disabledFeatures: [...set] })
  }

  const submit = (): void => {
    setMsg(null)
    save.mutate({
      org: s.org,
      network: {
        ...s.network,
        allowedCidrs: cidrs
          .split(/[,\s]+/)
          .map((c) => c.trim())
          .filter(Boolean)
      },
      storage: {
        ...s.storage,
        blockedExtensions: blocked
          .split(/[,\s]+/)
          .map((x) => x.replace(/^\./, '').trim())
          .filter(Boolean)
      },
      backup: s.backup,
      ops: s.ops
    })
  }

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>조직 정보</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Field label="기관/회사명">
            <Input aria-label="기관/회사명" value={s.org.orgName} onChange={(e) => upd('org', { orgName: e.target.value })} />
          </Field>
          <Field label="소속 팀명">
            <Input aria-label="소속 팀명" value={s.org.teamName} onChange={(e) => upd('org', { teamName: e.target.value })} />
          </Field>
          <div className="col-span-2">
            <Field label="하단 안내문" hint="모든 팀원 화면 맨 아래에 표시됩니다.">
              <Textarea aria-label="하단 안내문" value={s.org.noticeText} onChange={(e) => upd('org', { noticeText: e.target.value })} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>네트워크·승인</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="포트" hint="바꾸면 서버가 다시 시작되고, 팀원은 새 주소로 다시 연결해야 합니다.">
              <Input aria-label="포트" value={String(s.network.port)} onChange={(e) => upd('network', { port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
            </Field>
            <Field label="허용 IP 대역" hint="쉼표로 구분. 비우면 제한 없음">
              <Input aria-label="허용 IP 대역" value={cidrs} onChange={(e) => setCidrs(e.target.value)} placeholder="192.168.10.0/24" />
            </Field>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex-1 text-sm">허용 대역 안의 사용 신청은 자동 승인</span>
            <Switch
              checked={s.network.approvalMode === 'auto-in-cidr'}
              onCheckedChange={(v) => upd('network', { approvalMode: v ? 'auto-in-cidr' : 'manual' })}
              label="자동 승인"
            />
          </div>
          <div className="flex items-center gap-4">
            <span className="flex-1 text-sm">PC의 IP가 승인 당시와 달라지면 다시 승인 받기</span>
            <Switch checked={s.network.reapproveOnIpChange} onCheckedChange={(v) => upd('network', { reapproveOnIpChange: v })} label="IP 변경 시 재승인" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>저장 공간</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3">
          <Field label="전체 용량 한도 (GB)">
            <Input
              aria-label="전체 용량 한도"
              value={String(Math.round(s.storage.quotaBytes / 1024 ** 3))}
              onChange={(e) => upd('storage', { quotaBytes: (Number(e.target.value.replace(/\D/g, '')) || 1) * 1024 ** 3 })}
            />
          </Field>
          <Field label="파일당 최대 크기 (MB)">
            <Input
              aria-label="파일당 최대 크기"
              value={String(Math.round(s.storage.maxFileBytes / 1024 ** 2))}
              onChange={(e) => upd('storage', { maxFileBytes: (Number(e.target.value.replace(/\D/g, '')) || 1) * 1024 ** 2 })}
            />
          </Field>
          <div className="col-span-2">
            <Field label="올릴 수 없는 확장자" hint="쉼표로 구분">
              <Input aria-label="금지 확장자" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
            </Field>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>백업</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <div className="col-span-3">
            <Field label="백업 위치">
              <Input aria-label="백업 위치" value={s.backup.dir} onChange={(e) => upd('backup', { dir: e.target.value })} />
            </Field>
          </div>
          <Field label="매일 백업 시각">
            <Input aria-label="백업 시각" value={s.backup.time} onChange={(e) => upd('backup', { time: e.target.value })} />
          </Field>
          <Field label="보관 개수">
            <Input aria-label="보관 개수" value={String(s.backup.keep)} onChange={(e) => upd('backup', { keep: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>운영</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="긴급알림 발송 권한">
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                aria-label="긴급알림 발송 권한"
                value={s.ops.urgentSenders}
                onChange={(e) => upd('ops', { urgentSenders: e.target.value as 'admins' | 'everyone' })}
              >
                <option value="admins">관리자만</option>
                <option value="everyone">모든 팀원</option>
              </select>
            </Field>
            <Field label="그룹 만들기 권한">
              <select
                className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                aria-label="그룹 만들기 권한"
                value={s.ops.groupCreators}
                onChange={(e) => upd('ops', { groupCreators: e.target.value as 'admins' | 'everyone' })}
              >
                <option value="everyone">모든 팀원</option>
                <option value="admins">관리자만</option>
              </select>
            </Field>
            <Field label="메시지 보관 기간 (일)">
              <Input
                aria-label="메시지 보관 기간"
                value={String(s.ops.messageRetentionDays)}
                onChange={(e) => upd('ops', { messageRetentionDays: Number(e.target.value.replace(/\D/g, '')) || 30 })}
              />
            </Field>
          </div>
          <div className="flex items-center gap-4">
            <span className="flex-1 text-sm">서버 실행 중 절전 방지</span>
            <Switch checked={s.ops.preventSleep} onCheckedChange={(v) => upd('ops', { preventSleep: v })} label="절전 방지" />
          </div>
          <div>
            <div className="mb-1.5 text-sm font-medium">사용할 기능</div>
            <p className="mb-2 text-xs text-muted-foreground">끈 기능은 모든 팀원의 메뉴에서 숨겨집니다.</p>
            <div className="grid grid-cols-3 gap-2">
              {MENU.filter((m) => m.key !== 'home').map((m) => (
                <label key={m.key} className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm">
                  <Switch checked={!s.ops.disabledFeatures.includes(m.key as FeatureKey)} onCheckedChange={(v) => toggleFeature(m.key as FeatureKey, v)} label={`${m.label} 사용`} />
                  {m.label}
                </label>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex items-center gap-3 bg-background py-2">
        <Button onClick={submit} disabled={save.isPending}>
          <Save /> 설정 저장
        </Button>
        {msg && <span className={msg.ok ? 'text-sm text-success' : 'text-sm text-urgent'}>{msg.text}</span>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>관리 PIN</CardTitle>
        </CardHeader>
        <CardContent className="flex items-end gap-2">
          <Field label="새 PIN (숫자 4~8자리, 비우고 저장하면 PIN 해제)">
            <Input aria-label="새 관리 PIN" type="password" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value)} className="w-48" />
          </Field>
          <Button variant="outline" onClick={() => save.mutate({ adminPin: pin })}>
            PIN 저장
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
