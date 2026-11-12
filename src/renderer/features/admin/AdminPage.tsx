import { useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { KeyRound } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import { api, errorMessage, hasAdminPin, setAdminPin } from '@renderer/lib/api'
import { useMe } from '@renderer/lib/queries'
import { cn } from '@renderer/lib/utils'
import { ApprovalsTab } from './ApprovalsTab'
import { MembersTab } from './MembersTab'
import { SettingsTab } from './SettingsTab'
import { ReleasesTab } from './ReleasesTab'
import { ActivityTab, StatusTab } from './StatusTab'
import { HolidaysTab } from './HolidaysTab'
import { TemplatesTab } from './TemplatesTab'
import { LauncherAdminTab } from './LauncherAdminTab'
import { BackupTab } from './BackupTab'

interface AdminStatus {
  pendingJoins: number
}

const TABS = [
  { path: 'approvals', label: '승인 관리' },
  { path: 'members', label: '구성원·PC' },
  { path: 'settings', label: '조직·운영 설정' },
  { path: 'holidays', label: '공휴일' },
  { path: 'templates', label: '기록 양식' },
  { path: 'launcher', label: '공용 런처·보안' },
  { path: 'backup', label: '백업·복구' },
  { path: 'releases', label: '업데이트 배포' },
  { path: 'status', label: '서버 상태' },
  { path: 'activity', label: '활동 기록' }
]

function PinGate({ onOk }: { onOk: () => void }): React.JSX.Element {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const submit = async (): Promise<void> => {
    setAdminPin(pin)
    try {
      await api.post('/api/admin/pin-check')
      onOk()
    } catch (e) {
      setAdminPin('')
      setErr(errorMessage(e))
    }
  }
  return (
    <div className="flex h-full items-center justify-center">
      <Card className="w-80">
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2 font-semibold">
            <KeyRound className="size-4" /> 관리 PIN 입력
          </div>
          <Input
            aria-label="관리 PIN"
            type="password"
            inputMode="numeric"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
            autoFocus
          />
          {err && <p className="text-xs text-urgent">{err}</p>}
          <Button className="w-full" onClick={() => void submit()}>
            확인
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

export function AdminPage(): React.JSX.Element {
  const { data: me } = useMe()
  const [unlocked, setUnlocked] = useState(hasAdminPin())
  const needPin = !!me?.adminPinSet && !unlocked
  const { data: status } = useQuery({
    queryKey: ['admin', 'status'],
    queryFn: () => api.get<AdminStatus>('/api/admin/status'),
    enabled: !needPin,
    refetchInterval: 15000
  })

  if (needPin) return <PinGate onOk={() => setUnlocked(true)} />

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="관리" description="서버 관리자 전용 메뉴입니다." />
      <div className="flex shrink-0 gap-1 border-b border-border px-5">
        {TABS.map((t) => (
          <NavLink
            key={t.path}
            to={`/admin/${t.path}`}
            className={({ isActive }) =>
              cn('-mb-px border-b-2 px-3 py-2 text-sm', isActive ? 'border-primary font-semibold text-primary' : 'border-transparent text-muted-foreground hover:text-foreground')
            }
          >
            {t.label}
            {t.path === 'approvals' && (status?.pendingJoins ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-urgent px-1.5 text-[0.7rem] font-bold text-white">{status?.pendingJoins}</span>
            )}
          </NavLink>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Routes>
          <Route index element={<Navigate to="approvals" replace />} />
          <Route path="approvals" element={<ApprovalsTab />} />
          <Route path="members" element={<MembersTab />} />
          <Route path="settings" element={<SettingsTab />} />
          <Route path="holidays" element={<HolidaysTab />} />
          <Route path="templates" element={<TemplatesTab />} />
          <Route path="launcher" element={<LauncherAdminTab />} />
          <Route path="backup" element={<BackupTab />} />
          <Route path="releases" element={<ReleasesTab />} />
          <Route path="status" element={<StatusTab />} />
          <Route path="activity" element={<ActivityTab />} />
        </Routes>
      </div>
    </div>
  )
}
