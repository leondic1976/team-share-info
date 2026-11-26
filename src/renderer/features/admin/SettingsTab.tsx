import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FolderOpen, Save } from 'lucide-react'
import type { AllSettings } from '@shared/schemas/settings'
import { MESSAGE_FILE_RETENTION, type FeatureKey } from '@shared/constants'
import { api, errorMessage, setAdminPin } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Field } from '@renderer/features/setup/SetupFrame'
import { Loading } from '@renderer/components/EmptyState'
import { MENU } from '@renderer/app/menu'
import { formatSize } from '@renderer/components/Attachments'
import { OwnerOnlyNote, useIsOwner } from './owner'

/** Controls inside are the 최종관리자's: a 서무 sees them but cannot change them. */
function OwnerFields({ owner, className, children }: { owner: boolean; className?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <fieldset disabled={!owner} className={`m-0 min-w-0 border-0 p-0 disabled:opacity-60 ${className ?? ''}`}>
      {children}
    </fieldset>
  )
}

const GB = 1024 ** 3
/** Bytes as a GB figure for an input: 5, 0.5, 1.25 (no trailing zeros). */
const gbText = (bytes: number): string => String(Number((bytes / GB).toFixed(3)))

/** 90일, 180일, 1년, 2년, 3년 */
const daysLabel = (d: number): string => (d % 365 === 0 ? `${d / 365}년` : `${d}일`)

interface MessageFilesStatus {
  files: number
  bytes: number
  cleanup: { checkedAt: number; last: { at: number; files: number; bytes: number; days: number } | null } | null
}

/** What the messenger files take now and what the last cleanup removed. */
function messageFilesText(m: MessageFilesStatus | undefined): string {
  if (!m) return ''
  const now = `지금 대화방 파일 ${m.files.toLocaleString()}개 · ${formatSize(m.bytes)}`
  const last = m.cleanup?.last
  if (!last) return `${now} · 아직 지운 파일 없음`
  const d = new Date(last.at)
  return `${now} · 마지막 정리 ${d.getMonth() + 1}월 ${d.getDate()}일(파일 ${last.files.toLocaleString()}개, ${formatSize(last.bytes)} 확보)`
}

export function SettingsTab(): React.JSX.Element {
  const qc = useQueryClient()
  const owner = useIsOwner()
  const q = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api.get<AllSettings>('/api/admin/settings') })
  const [s, setS] = useState<AllSettings | null>(null)
  const [cidrs, setCidrs] = useState('')
  const [blocked, setBlocked] = useState('')
  const [quotaGb, setQuotaGb] = useState('')
  const [maxFileGb, setMaxFileGb] = useState('')
  const [pin, setPin] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const status = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => api.get<{ storageUsed: number; disk: { free: number; total: number } | null; messageFiles?: MessageFilesStatus }>('/api/admin/status')
  })

  useEffect(() => {
    if (q.data && !s) {
      setS(q.data)
      setCidrs(q.data.network.allowedCidrs.join(', '))
      setBlocked(q.data.storage.blockedExtensions.join(', '))
      setQuotaGb(gbText(q.data.storage.quotaBytes))
      setMaxFileGb(gbText(q.data.storage.maxFileBytes))
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

  const st = status.data
  const usage = st
    ? `지금 ${formatSize(st.storageUsed)} 사용 중${st.disk ? ` · 디스크 여유 ${formatSize(st.disk.free)}` : ''}`
    : '자료실·첨부 파일을 합친 한도'

  const submit = (): void => {
    setMsg(null)
    // a 서무 decides only who may send urgent notices and who may make groups
    if (!owner) return save.mutate({ ops: { urgentSenders: s.ops.urgentSenders, groupCreators: s.ops.groupCreators } })
    const quotaBytes = Math.round(Number(quotaGb) * GB)
    const maxFileBytes = Math.round(Number(maxFileGb) * GB)
    if (!(quotaBytes > 0) || !(maxFileBytes > 0)) return setMsg({ ok: false, text: '저장 공간의 용량은 0보다 큰 숫자로 입력하세요.' })
    if (maxFileBytes > quotaBytes) return setMsg({ ok: false, text: '파일당 최대 크기는 전체 용량 한도보다 클 수 없습니다.' })
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
        quotaBytes,
        maxFileBytes,
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
      {!owner && (
        <OwnerOnlyNote>
          서무는 <b>긴급알림 발송 권한</b>과 <b>그룹 만들기 권한</b>만 바꿀 수 있습니다. 조직 정보·네트워크·저장 공간·백업·사용할 기능·관리 PIN 등 흐리게 보이는 항목은 최종관리자(서버 PC)만 바꿉니다.
        </OwnerOnlyNote>
      )}
      <OwnerFields owner={owner} className="space-y-4">
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
          <Field label="전체 용량 한도 (GB)" hint={usage}>
            <Input aria-label="전체 용량 한도" value={quotaGb} onChange={(e) => setQuotaGb(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <Field label="파일당 최대 크기 (GB)" hint="자료실에 올리는 파일 하나의 한도. 소수도 쓸 수 있습니다(예: 0.5).">
            <Input aria-label="파일당 최대 크기" value={maxFileGb} onChange={(e) => setMaxFileGb(e.target.value.replace(/[^\d.]/g, ''))} />
          </Field>
          <div className="col-span-2">
            <Field label="올릴 수 없는 확장자" hint="쉼표로 구분">
              <Input aria-label="금지 확장자" value={blocked} onChange={(e) => setBlocked(e.target.value)} />
            </Field>
          </div>
          <Field label="메시지 파일 보관 기간">
            <select
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              aria-label="메시지 파일 보관 기간"
              value={s.storage.messageFileRetentionDays === null ? 'forever' : String(s.storage.messageFileRetentionDays)}
              onChange={(e) => upd('storage', { messageFileRetentionDays: e.target.value === 'forever' ? null : Number(e.target.value) })}
            >
              {[...new Set<number>([...MESSAGE_FILE_RETENTION.choices, ...(s.storage.messageFileRetentionDays === null ? [] : [s.storage.messageFileRetentionDays])])]
                .sort((a, b) => a - b)
                .map((d) => (
                  <option key={d} value={String(d)}>
                    {daysLabel(d)}
                    {d === MESSAGE_FILE_RETENTION.defaultDays ? ' (기본)' : ''}
                  </option>
                ))}
              <option value="forever">무기한 (지우지 않음)</option>
            </select>
          </Field>
          <p className="col-span-2 -mt-1 text-xs text-muted-foreground" data-testid="message-file-retention-hint">
            메신저 대화방에서 주고받은 파일과 사진은 보낸 날부터 이 기간이 지나면 서버 PC에서 지웁니다(최소 {MESSAGE_FILE_RETENTION.minDays}일). 메시지 내용은 남고, 대화방에는
            &quot;보관 기간이 지나 서버에서 삭제된 파일입니다.&quot;로 표시됩니다. 자료실·공지·게시판의 첨부 파일과 백업은 지우지 않습니다.
            {status.data?.messageFiles && <span className="mt-0.5 block">{messageFilesText(status.data.messageFiles)}</span>}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>백업</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-3 gap-3">
          <div className="col-span-3">
            <Field label="백업 위치">
              <div className="flex gap-2">
                <Input aria-label="백업 위치" value={s.backup.dir} placeholder="비우면 서버 자료 폴더의 backups\auto" onChange={(e) => upd('backup', { dir: e.target.value })} />
                <Button
                  type="button"
                  variant="outline"
                  className="shrink-0"
                  onClick={() =>
                    void invoke('server:pickFolder', { title: '백업 폴더 고르기' })
                      .then((p) => p && upd('backup', { dir: p }))
                      .catch(() => undefined)
                  }
                >
                  <FolderOpen /> 폴더 고르기…
                </Button>
              </div>
            </Field>
            <p className="mt-1.5 text-xs text-muted-foreground" data-testid="backup-dir-hint">
              저장할 때 그 폴더에 쓸 수 있는지 먼저 확인합니다. 위치를 바꿔도 이전 백업은 이전 폴더에 그대로 남고, 백업·복구 목록에는 새 위치의 백업만 보입니다(이전 백업으로 복구하려면 위치를 잠시 이전 폴더로 되돌리세요).
            </p>
          </div>
          <Field label="매일 백업 시각">
            <Input aria-label="백업 시각" value={s.backup.time} onChange={(e) => upd('backup', { time: e.target.value })} />
          </Field>
          <Field label="보관 개수">
            <Input aria-label="보관 개수" value={String(s.backup.keep)} onChange={(e) => upd('backup', { keep: Number(e.target.value.replace(/\D/g, '')) || 1 })} />
          </Field>
        </CardContent>
      </Card>
      </OwnerFields>

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
                <option value="admins">최종관리자·서무만</option>
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
                <option value="admins">최종관리자·서무만</option>
              </select>
            </Field>
            <OwnerFields owner={owner}>
              <Field label="메시지 보관 기간 (일)">
                <Input
                  aria-label="메시지 보관 기간"
                  value={String(s.ops.messageRetentionDays)}
                  onChange={(e) => upd('ops', { messageRetentionDays: Number(e.target.value.replace(/\D/g, '')) || 30 })}
                />
              </Field>
            </OwnerFields>
          </div>
          <OwnerFields owner={owner} className="space-y-3">
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
          </OwnerFields>
        </CardContent>
      </Card>

      <div className="sticky bottom-0 flex items-center gap-3 bg-background py-2">
        <Button onClick={submit} disabled={save.isPending}>
          <Save /> 설정 저장
        </Button>
        {msg && <span className={msg.ok ? 'text-sm text-success' : 'text-sm text-urgent'}>{msg.text}</span>}
      </div>

      {owner && (
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
      )}
    </div>
  )
}
