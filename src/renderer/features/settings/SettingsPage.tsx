import { useEffect, useState } from 'react'
import { Download, Upload, Lock, Monitor, Sun, Moon, MessageSquarePlus, ExternalLink } from 'lucide-react'
import { DOWNLOAD_SITE } from '@shared/constants'
import { Input } from '@renderer/components/ui/input'
import { PageHeader } from '@renderer/components/PageHeader'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { usePrefs, type Theme } from '@renderer/app/prefs-store'
import { useSession } from '@renderer/app/session-store'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { UpdateCard } from './UpdateCard'
import { MenuCard } from './MenuCard'
import { StorageCard } from './StorageCard'
import { WallpaperCard } from './WallpaperCard'
import { LockCard } from './LockCard'
import { SharedPcCard } from './SharedPcCard'
import { OrgManageCard } from './OrgManageCard'
import { ProfileTab } from '@renderer/features/directory/DirectoryPage'
import { useConn } from '@renderer/app/conn-store'
import type { ReactNode } from 'react'

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center gap-4 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

const THEMES: { value: Theme; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '밝게', icon: Sun },
  { value: 'dark', label: '어둡게', icon: Moon },
  { value: 'system', label: '시스템', icon: Monitor }
]

export function SettingsPage({ extra }: { extra?: ReactNode }): React.JSX.Element {
  const prefs = usePrefs()
  const app = useSession((s) => s.app)
  const [autostart, setAutostartState] = useState(false)
  const [msg, setMsg] = useState('')
  const hasAccount = useConn((s) => !!s.memberId)

  useEffect(() => {
    void invoke('app:getAutostart').then(setAutostartState)
  }, [])

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="설정" description="이 PC에서만 적용되는 설정입니다." />
      <div className="flex-1 space-y-4 overflow-y-auto p-5">
        {hasAccount && (
          <section data-testid="my-profile">
            <h2 className="mb-1.5 text-sm font-semibold">내 정보</h2>
            <p className="mb-2 text-xs text-muted-foreground">팀원에게 보이는 내 정보입니다. 서버에 저장되며, 서버 PC(최종관리자)가 정해 둔 항목은 여기서 바꿀 수 없습니다.</p>
            <ProfileTab />
          </section>
        )}
        <Card>
          <CardHeader>
            <CardTitle>화면</CardTitle>
          </CardHeader>
          <CardContent className="divide-y divide-border py-1">
            <Row label="테마">
              <div className="flex gap-1" role="radiogroup" aria-label="테마">
                {THEMES.map((t) => (
                  <Button
                    key={t.value}
                    size="sm"
                    variant={prefs.theme === t.value ? 'default' : 'outline'}
                    role="radio"
                    aria-checked={prefs.theme === t.value}
                    onClick={() => prefs.update({ theme: t.value })}
                  >
                    <t.icon /> {t.label}
                  </Button>
                ))}
              </div>
            </Row>
            <Row label="글자 크기" hint="13~18px">
              <div className="flex items-center gap-2">
                <Button size="icon-sm" variant="outline" aria-label="글자 작게" onClick={() => prefs.update({ fontSize: prefs.fontSize - 1 })}>
                  가-
                </Button>
                <span className="w-10 text-center text-sm tabular-nums" data-testid="font-size">
                  {prefs.fontSize}px
                </span>
                <Button size="icon-sm" variant="outline" aria-label="글자 크게" onClick={() => prefs.update({ fontSize: prefs.fontSize + 1 })}>
                  가+
                </Button>
              </div>
            </Row>
          </CardContent>
        </Card>

        <WallpaperCard />

        <Card>
          <CardHeader>
            <CardTitle>시작</CardTitle>
          </CardHeader>
          <CardContent className="py-1">
            <Row
              label="Windows 시작 시 자동 실행"
              hint={app?.isPackaged ? '트레이에 최소화된 상태로 시작합니다.' : '개발 실행에서는 사용할 수 없습니다.'}
            >
              <Switch
                checked={autostart}
                disabled={!app?.isPackaged}
                label="Windows 시작 시 자동 실행"
                onCheckedChange={async (v) => setAutostartState(await invoke('app:setAutostart', { enabled: v }))}
              />
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>알림</CardTitle>
          </CardHeader>
          <CardContent className="py-1">
            <Row label="방해 금지 시간" hint="이 시간에는 중요·일반 알림을 띄우지 않습니다. 긴급 알림은 항상 표시됩니다.">
              <div className="flex items-center gap-2">
                <Input aria-label="방해 금지 시작" type="time" className="w-28" value={prefs.dndStart} onChange={(e) => prefs.update({ dndStart: e.target.value })} disabled={!prefs.dndEnabled} />
                ~
                <Input aria-label="방해 금지 끝" type="time" className="w-28" value={prefs.dndEnd} onChange={(e) => prefs.update({ dndEnd: e.target.value })} disabled={!prefs.dndEnabled} />
                <Switch checked={prefs.dndEnabled} label="방해 금지 사용" onCheckedChange={(v) => prefs.update({ dndEnabled: v })} />
              </div>
            </Row>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-1.5">
              <Lock className="size-4 text-personal" /> 개인 데이터 (내 PC에만 저장)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              개인 일정·할 일·다이어리·메모·알람 등은 이 PC에만 저장되며 서버로 보내지 않습니다. PC를 바꿀 때는 내보내기 후 새
              PC에서 가져오세요.
            </p>
            <div className="selectable rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="local-db-path">
              {app?.localDbPath}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  const r = await invoke('local:export')
                  setMsg(r.ok ? `내보냈습니다: ${r.path}` : r.error ? `실패: ${r.error}` : '')
                }}
              >
                <Download /> 내보내기
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  const r = await invoke('local:import')
                  if (r.error) setMsg(`실패: ${r.error}`)
                }}
              >
                <Upload /> 가져오기
              </Button>
            </div>
            {msg && <p className={cn('text-xs', msg.startsWith('실패') ? 'text-urgent' : 'text-success')}>{msg}</p>}
          </CardContent>
        </Card>

        <LockCard />

        <SharedPcCard />

        <StorageCard kind="local" />

        {extra}

        <OrgManageCard />

        <MenuCard />

        <UpdateCard />

        <Card>
          <CardHeader>
            <CardTitle>프로그램 정보</CardTitle>
          </CardHeader>
          <CardContent className="selectable grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <span className="text-muted-foreground">버전</span>
            <span>{app?.version}</span>
            <span className="text-muted-foreground">PC 이름</span>
            <span>{app?.pcName}</span>
            <span className="text-muted-foreground">Windows 계정</span>
            <span>{app?.winUser}</span>
            <span className="text-muted-foreground">데이터 폴더</span>
            <span className="break-all">{app?.userDataPath}</span>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>기능요청 및 오류신고</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              필요한 기능이나 잘못 동작하는 부분을 개발자에게 알려 주세요. 새 창에서 글을 쓰면 공개 게시판에 등록되고, 처리 상황은 게시판에서 볼 수 있습니다. 서버용 PC와 일반용(팀원) PC 모두에서 보낼 수 있고, 인터넷이 안 되는 PC에서는 팀의 서버 PC를 거쳐 보냅니다.
            </p>
            <div className="flex gap-2">
              <Button onClick={() => void invoke('feedback:open')} data-testid="feedback-open">
                <MessageSquarePlus /> 기능요청 및 오류신고
              </Button>
              <Button variant="outline" onClick={() => void invoke('app:openExternal', { url: `${DOWNLOAD_SITE}feedback.html` })}>
                <ExternalLink /> 게시판 보기
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
