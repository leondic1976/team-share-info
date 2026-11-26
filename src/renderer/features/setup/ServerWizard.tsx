import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, Check, FolderSearch, Loader2, Copy } from 'lucide-react'
import { SetupFrame, Field } from './SetupFrame'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent } from '@renderer/components/ui/card'
import { invoke } from '@renderer/lib/bridge'
import { DEFAULT_NOTICE_TEXT, DEFAULT_PORT, LIMITS } from '@shared/constants'
import type { NetIfaceInfo, SetupResult } from '@shared/ipc'
import { serverSetupSchema, type ServerSetupInput } from '@shared/schemas/settings'
import { cn } from '@renderer/lib/utils'

const STEPS = ['조직 정보', '관리자', '네트워크', '저장 위치', '백업', '안내문', '운영', '완료']

interface Form {
  orgName: string
  teamName: string
  adminName: string
  adminDept: string
  adminTitle: string
  adminExt: string
  adminPin: string
  ip: string
  port: string
  cidr: string
  approval: 'manual' | 'auto-in-cidr'
  dataDir: string
  quotaGb: string
  maxFileGb: string
  backupDir: string
  backupTime: string
  backupKeep: string
  notice: string
  autostart: boolean
  preventSleep: boolean
  firewall: boolean
}

function toInput(f: Form): ServerSetupInput {
  return serverSetupSchema.parse({
    org: { orgName: f.orgName, teamName: f.teamName, noticeText: f.notice || DEFAULT_NOTICE_TEXT },
    admin: { name: f.adminName, deptName: f.adminDept, title: f.adminTitle, ext: f.adminExt },
    adminPin: f.adminPin,
    network: {
      bindIp: '0.0.0.0',
      advertisedIp: f.ip,
      port: Number(f.port),
      allowedCidrs: f.cidr.trim() ? [f.cidr.trim()] : [],
      approvalMode: f.approval,
      reapproveOnIpChange: false
    },
    dataDir: f.dataDir,
    storage: { quotaBytes: Math.round(Number(f.quotaGb) * 1024 ** 3), maxFileBytes: Math.round(Number(f.maxFileGb) * 1024 ** 3) },
    backup: { dir: f.backupDir, time: f.backupTime, keep: Number(f.backupKeep) },
    ops: { autostart: f.autostart, preventSleep: f.preventSleep, registerFirewall: f.firewall }
  })
}

/** Validate only the fields of the current step; returns an error message or ''. */
function stepError(step: number, f: Form): string {
  switch (step) {
    case 0:
      if (!f.orgName.trim()) return '기관/회사명을 입력하세요.'
      if (!f.teamName.trim()) return '소속 팀명을 입력하세요.'
      return ''
    case 1:
      if (!f.adminName.trim()) return '관리자 이름을 입력하세요.'
      if (f.adminPin && !/^\d{4,8}$/.test(f.adminPin)) return '관리 PIN은 숫자 4~8자리입니다.'
      return ''
    case 2: {
      const p = Number(f.port)
      if (!Number.isInteger(p) || p < 1024 || p > 65535) return '포트는 1024~65535 사이 숫자입니다.'
      if (f.cidr.trim() && !/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/.test(f.cidr.trim())) return '허용 IP 대역 형식: 192.168.10.0/24'
      if (f.approval === 'auto-in-cidr' && !f.cidr.trim()) return '자동 승인을 쓰려면 허용 IP 대역을 지정하세요.'
      return ''
    }
    case 3:
      if (f.dataDir.trim().length < 3) return '데이터 폴더를 지정하세요.'
      if (!(Number(f.quotaGb) > 0) || !(Number(f.maxFileGb) > 0)) return '용량은 0보다 커야 합니다.'
      if (Number(f.maxFileGb) > Number(f.quotaGb)) return '파일당 최대 크기는 전체 용량 한도보다 클 수 없습니다.'
      return ''
    case 4:
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(f.backupTime)) return '백업 시각 형식: 12:30'
      if (!(Number(f.backupKeep) >= 1)) return '보관 개수는 1 이상입니다.'
      return ''
    case 5:
      return f.notice.trim() ? '' : '안내문을 입력하세요.'
    default:
      return ''
  }
}

export function ServerWizard({ onBack, onDone }: { onBack: () => void; onDone: () => void }): React.JSX.Element {
  const [step, setStep] = useState(0)
  const [ifaces, setIfaces] = useState<NetIfaceInfo[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<SetupResult | null>(null)
  const [f, setF] = useState<Form>({
    orgName: '',
    teamName: '',
    adminName: '',
    adminDept: '',
    adminTitle: '',
    adminExt: '',
    adminPin: '',
    ip: '',
    port: String(DEFAULT_PORT),
    cidr: '',
    approval: 'manual',
    dataDir: '',
    quotaGb: String(LIMITS.defaultQuotaBytes / 1024 ** 3),
    maxFileGb: String(LIMITS.defaultMaxFileBytes / 1024 ** 3),
    backupDir: '',
    backupTime: '12:30',
    backupKeep: '14',
    notice: DEFAULT_NOTICE_TEXT,
    autostart: true,
    preventSleep: true,
    firewall: true
  })
  const set = <K extends keyof Form>(k: K, v: Form[K]): void => setF((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    void invoke('server:networkInfo').then((info) => {
      setIfaces(info.interfaces)
      const first = info.interfaces.find((i) => !i.virtual) ?? info.interfaces[0]
      setF((p) => ({
        ...p,
        adminName: p.adminName || info.winUser,
        ip: first?.address ?? '',
        cidr: first?.cidr ?? '',
        dataDir: info.suggestedDataDir,
        backupDir: `${info.suggestedDataDir}\\backups`
      }))
    })
  }, [])

  const isLast = step === STEPS.length - 1
  const summary = useMemo(() => {
    try {
      return toInput(f)
    } catch {
      return null
    }
  }, [f])

  const next = (): void => {
    const err = stepError(step, f)
    setError(err)
    if (!err) setStep((s) => Math.min(s + 1, STEPS.length - 1))
  }

  const finish = async (): Promise<void> => {
    for (let i = 0; i < STEPS.length - 1; i++) {
      const err = stepError(i, f)
      if (err) {
        setStep(i)
        setError(err)
        return
      }
    }
    setBusy(true)
    setError('')
    try {
      let r = await invoke('server:setup', toInput(f))
      if (!r.ok && r.existing) {
        // a team was set up in this folder before: nothing is deleted, the old data is moved aside
        const name = [r.existing.orgName, r.existing.teamName].filter(Boolean).join(' ') || '이전 팀'
        const q =
          `데이터 폴더(${f.dataDir})에 이미 "${name}" 서버 자료가 있습니다.\n\n` +
          '기존 자료는 지우지 않고 같은 폴더 안의 "previous-날짜" 폴더로 옮긴 뒤 새 팀을 만듭니다.' +
          (r.existing.remembered ? '\n기억해 둔 그 서버 연결은 목록에서 지워집니다.' : '') +
          '\n\n계속할까요? (기존 팀을 그대로 두려면 취소하고 "저장 위치" 단계에서 다른 폴더를 지정하세요.)'
        if (!window.confirm(q)) {
          setError('이 데이터 폴더에는 이미 서버 자료가 있습니다. 다른 폴더를 지정하거나, 설정 완료를 다시 눌러 기존 자료를 옮기고 새로 만드세요.')
          return
        }
        r = await invoke('server:setup', { ...toInput(f), replaceExisting: true })
      }
      if (!r.ok) setError(r.error ?? '서버를 시작하지 못했습니다.')
      setResult(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (result?.ok) {
    const addr = result.addresses?.[0] ?? `http://${f.ip}:${f.port}`
    return (
      <SetupFrame title="서버 설정이 끝났습니다" subtitle="아래 주소를 팀원에게 알려 주세요." wide>
        <Card>
          <CardContent className="space-y-4">
            <div>
              <div className="text-sm font-medium">접속 주소 (팀원이 입력)</div>
              {(result.addresses?.length ? result.addresses : [addr]).map((a) => (
                <div key={a} className="mt-1 flex items-center gap-2">
                  <code className="selectable rounded bg-muted px-2 py-1 text-base font-semibold" data-testid="server-address">
                    {a.replace('http://', '')}
                  </code>
                  <Button size="icon-sm" variant="ghost" aria-label="주소 복사" onClick={() => void navigator.clipboard.writeText(a.replace('http://', ''))}>
                    <Copy />
                  </Button>
                </div>
              ))}
            </div>
            <div>
              <div className="text-sm font-medium">설치 안내 주소 (브라우저로 열기)</div>
              <code className="selectable mt-1 inline-block rounded bg-muted px-2 py-1">{addr}/download</code>
            </div>
            <p className={cn('text-sm', result.firewall?.ok ? 'text-success' : 'text-important')}>방화벽: {result.firewall?.message}</p>
            <Button onClick={onDone}>
              <Check /> 시작하기
            </Button>
          </CardContent>
        </Card>
      </SetupFrame>
    )
  }

  return (
    <SetupFrame title="서버 설정" subtitle={`${step + 1} / ${STEPS.length} · ${STEPS[step]}`} wide>
      <ol className="mb-4 flex flex-wrap gap-1.5" aria-label="설정 단계">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={cn(
              'rounded-full px-2.5 py-0.5 text-xs',
              i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground'
            )}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>
      <Card>
        <CardContent className="space-y-4">
          {step === 0 && (
            <>
              <Field label="기관/회사명" hint="하단 표시줄에 표시됩니다.">
                <Input aria-label="기관/회사명" value={f.orgName} onChange={(e) => set('orgName', e.target.value)} placeholder="예: ○○시청 총무과" autoFocus />
              </Field>
              <Field label="소속 팀명">
                <Input aria-label="소속 팀명" value={f.teamName} onChange={(e) => set('teamName', e.target.value)} placeholder="예: 행정팀" />
              </Field>
            </>
          )}
          {step === 1 && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="관리자 이름">
                  <Input aria-label="관리자 이름" value={f.adminName} onChange={(e) => set('adminName', e.target.value)} />
                </Field>
                <Field label="부서">
                  <Input aria-label="관리자 부서" value={f.adminDept} onChange={(e) => set('adminDept', e.target.value)} />
                </Field>
                <Field label="직위">
                  <Input aria-label="관리자 직위" value={f.adminTitle} onChange={(e) => set('adminTitle', e.target.value)} />
                </Field>
                <Field label="내선번호">
                  <Input aria-label="관리자 내선번호" value={f.adminExt} onChange={(e) => set('adminExt', e.target.value)} />
                </Field>
              </div>
              <Field label="관리 PIN (선택)" hint="숫자 4~8자리. 설정하면 관리 메뉴를 열 때마다 입력합니다(서버 PC를 다른 사람이 잠깐 쓸 때 대비).">
                <Input aria-label="관리 PIN" type="password" inputMode="numeric" value={f.adminPin} onChange={(e) => set('adminPin', e.target.value)} />
              </Field>
            </>
          )}
          {step === 2 && (
            <>
              <Field label="사용할 네트워크(IP)" hint="팀원이 접속할 주소입니다. 고정 IP(또는 DHCP 예약)를 권장합니다.">
                <div className="space-y-1.5">
                  {ifaces.length === 0 && <p className="text-sm text-urgent">사용 가능한 네트워크가 없습니다.</p>}
                  {ifaces.map((i) => (
                    <label key={i.name + i.address} className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm">
                      <input
                        type="radio"
                        name="ip"
                        checked={f.ip === i.address}
                        onChange={() => setF((p) => ({ ...p, ip: i.address, cidr: i.cidr ?? p.cidr }))}
                      />
                      <span className="font-semibold">{i.address}</span>
                      <span className="text-muted-foreground">{i.name}</span>
                      {i.virtual && <span className="ml-auto text-xs text-important">가상/VPN</span>}
                    </label>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="포트">
                  <Input aria-label="포트" value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} />
                </Field>
                <Field label="허용 IP 대역" hint="비우면 제한 없음">
                  <Input aria-label="허용 IP 대역" value={f.cidr} onChange={(e) => set('cidr', e.target.value)} placeholder="192.168.10.0/24" />
                </Field>
              </div>
              <Field label="사용 신청 승인 방식">
                <div className="flex gap-2">
                  {(
                    [
                      ['manual', '관리자가 직접 승인'],
                      ['auto-in-cidr', '허용 대역 안은 자동 승인']
                    ] as const
                  ).map(([v, l]) => (
                    <Button key={v} size="sm" variant={f.approval === v ? 'default' : 'outline'} onClick={() => set('approval', v)}>
                      {l}
                    </Button>
                  ))}
                </div>
              </Field>
            </>
          )}
          {step === 3 && (
            <>
              <Field label="데이터 폴더" hint="DB와 자료실 파일이 저장됩니다. 기본은 D 드라이브(없으면 C 드라이브)입니다. 여유 공간이 충분한 드라이브를 고르세요.">
                <div className="flex gap-2">
                  <Input aria-label="데이터 폴더" value={f.dataDir} onChange={(e) => set('dataDir', e.target.value)} />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const p = await invoke('server:pickFolder', { title: '데이터 폴더 선택' })
                      if (p) setF((x) => ({ ...x, dataDir: p, backupDir: x.backupDir || `${p}\\backups` }))
                    }}
                  >
                    <FolderSearch /> 찾아보기
                  </Button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="전체 용량 한도 (GB)">
                  <Input aria-label="전체 용량 한도" value={f.quotaGb} onChange={(e) => set('quotaGb', e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
                <Field label="파일당 최대 크기 (GB)">
                  <Input aria-label="파일당 최대 크기" value={f.maxFileGb} onChange={(e) => set('maxFileGb', e.target.value.replace(/[^\d.]/g, ''))} />
                </Field>
              </div>
              <p className="text-xs text-muted-foreground">두 한도는 나중에 서버 PC의 관리 → 설정 → 저장 공간에서 바꿀 수 있습니다. 소수도 쓸 수 있습니다(예: 0.5).</p>
            </>
          )}
          {step === 4 && (
            <>
              <Field label="자동 백업 위치" hint="서버 PC 고장에 대비해 다른 드라이브나 NAS를 권장합니다.">
                <div className="flex gap-2">
                  <Input aria-label="백업 위치" value={f.backupDir} onChange={(e) => set('backupDir', e.target.value)} />
                  <Button
                    variant="outline"
                    onClick={async () => {
                      const p = await invoke('server:pickFolder', { title: '백업 폴더 선택' })
                      if (p) set('backupDir', p)
                    }}
                  >
                    <FolderSearch /> 찾아보기
                  </Button>
                </div>
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="매일 백업 시각">
                  <Input aria-label="백업 시각" value={f.backupTime} onChange={(e) => set('backupTime', e.target.value)} />
                </Field>
                <Field label="보관 개수">
                  <Input aria-label="보관 개수" value={f.backupKeep} onChange={(e) => set('backupKeep', e.target.value.replace(/\D/g, ''))} />
                </Field>
              </div>
            </>
          )}
          {step === 5 && (
            <Field label="하단 안내문" hint="모든 팀원 화면 맨 아래에 항상 표시됩니다.">
              <Textarea aria-label="하단 안내문" value={f.notice} onChange={(e) => set('notice', e.target.value)} />
            </Field>
          )}
          {step === 6 && (
            <div className="divide-y divide-border">
              {(
                [
                  ['autostart', 'Windows 시작 시 자동 실행', '서버는 켜져 있어야 팀원이 사용할 수 있습니다.'],
                  ['preventSleep', '절전 방지', '서버 실행 중 PC가 절전 모드로 들어가지 않게 합니다.'],
                  ['firewall', '방화벽 규칙 등록', `설정 완료를 누르면 TCP ${f.port}(서버), UDP 47801(서버 찾기), TeamHub 프로그램(화상회의)을 개인·도메인 네트워크에서 허용합니다. 관리자 권한 확인 창이 한 번 뜨고, 설정 → 서버 연결에서 지울 수 있습니다.`]
                ] as const
              ).map(([k, label, hint]) => (
                <div key={k} className="flex items-center gap-4 py-3">
                  <div className="flex-1">
                    <div className="text-sm font-medium">{label}</div>
                    <div className="text-xs text-muted-foreground">{hint}</div>
                  </div>
                  <Switch checked={f[k]} onCheckedChange={(v) => set(k, v)} label={label} />
                </div>
              ))}
            </div>
          )}
          {step === 7 && summary && (
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-muted-foreground">소속</dt>
              <dd>
                {summary.org.orgName} {summary.org.teamName}
              </dd>
              <dt className="text-muted-foreground">관리자</dt>
              <dd>
                {summary.admin.name} {summary.adminPin ? '(PIN 설정)' : ''}
              </dd>
              <dt className="text-muted-foreground">접속 주소</dt>
              <dd className="font-semibold">
                {f.ip}:{f.port}
              </dd>
              <dt className="text-muted-foreground">허용 대역 / 승인</dt>
              <dd>
                {f.cidr || '제한 없음'} / {f.approval === 'manual' ? '직접 승인' : '대역 안 자동 승인'}
              </dd>
              <dt className="text-muted-foreground">데이터 폴더</dt>
              <dd className="break-all">{summary.dataDir}</dd>
              <dt className="text-muted-foreground">백업</dt>
              <dd className="break-all">
                매일 {summary.backup.time}, {summary.backup.keep}개 보관 · {summary.backup.dir}
              </dd>
            </dl>
          )}
          {error && (
            <p className="rounded-md bg-urgent/10 px-3 py-2 text-sm text-urgent" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={() => (step === 0 ? onBack() : setStep(step - 1))} disabled={busy}>
          <ArrowLeft /> {step === 0 ? '처음으로' : '이전'}
        </Button>
        {isLast ? (
          <Button onClick={() => void finish()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />} 설정 완료
          </Button>
        ) : (
          <Button onClick={next}>
            다음 <ArrowRight />
          </Button>
        )}
      </div>
    </SetupFrame>
  )
}
