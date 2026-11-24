import { useEffect, useState } from 'react'
import { format } from 'date-fns'
import { ArrowLeft, FolderOpen, Loader2 } from 'lucide-react'
import type { IpcRes } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { invoke } from '@renderer/lib/bridge'
import { Field, SetupFrame } from './SetupFrame'

/**
 * Move the server to this PC from a backup folder (6.16 서버 이전). Members keep their
 * approvals; they only need the new server address (or find it automatically).
 */
export function ImportServer({ onBack, onDone }: { onBack: () => void; onDone: () => void }): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [dataDir, setDataDir] = useState('')
  const [info, setInfo] = useState<IpcRes<'server:inspectBackup'> | null>(null)
  const [adminId, setAdminId] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<IpcRes<'server:importBackup'> | null>(null)
  useEffect(() => {
    void invoke('server:networkInfo').then((n) => setDataDir(n.suggestedDataDir))
  }, [])
  const inspect = async (d: string): Promise<void> => {
    setDir(d)
    setInfo(null)
    if (!d.trim()) return
    const r = await invoke('server:inspectBackup', { dir: d.trim() })
    setInfo(r)
    setAdminId(r.admins?.[0]?.id ?? '')
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    const r = await invoke('server:importBackup', { dir: dir.trim(), dataDir: dataDir.trim(), adminId })
    setResult(r)
    setBusy(false)
  }

  if (result?.ok)
    return (
      <SetupFrame title="서버를 옮겨 왔습니다" subtitle="이 PC가 새 서버가 되었습니다.">
        <div className="space-y-3 text-sm" data-testid="import-done">
          <p>팀원들의 TeamHub는 같은 네트워크에서 새 서버를 자동으로 찾습니다. 찾지 못하면 팀원에게 아래 주소를 알려 주세요(설정 → 서버 연결 → 서버 주소 고치고 적용).</p>
          {result.addresses?.map((a) => (
            <p key={a} className="font-mono font-semibold" data-testid="server-address">
              {a}
            </p>
          ))}
          <p className="text-muted-foreground">예전 서버 PC는 끄거나 TeamHub를 접속 모드로 바꾸세요. 두 PC가 동시에 서버로 켜져 있으면 팀원이 헷갈릴 수 있습니다.</p>
          <Button onClick={onDone}>시작하기</Button>
        </div>
      </SetupFrame>
    )

  return (
    <SetupFrame title="기존 서버 옮겨 오기" subtitle="예전 서버 PC에서 만든 백업으로 이 PC를 서버로 만듭니다. 모든 공지·일정·자료·구성원·승인 정보가 그대로 옮겨집니다.">
      <div className="space-y-4">
        <Field label="백업 폴더" hint='예전 서버의 "관리 → 백업·복구"에서 만든 "TeamHub-날짜" 폴더(USB 등으로 복사해 온 것)를 고르세요. 같은 위치에 blobs 폴더가 함께 있어야 합니다.'>
          <div className="flex gap-2">
            <Input aria-label="백업 폴더" value={dir} onChange={(e) => setDir(e.target.value)} onBlur={() => void inspect(dir)} placeholder="D:\TeamHub백업\TeamHub-20261112-123000" />
            <Button variant="outline" onClick={() => void invoke('server:pickFolder', { title: 'TeamHub 백업 폴더 고르기' }).then((p) => (p ? inspect(p) : undefined))}>
              <FolderOpen /> 찾아보기
            </Button>
          </div>
        </Field>
        {info && !info.ok && <p className="text-sm text-urgent">{info.error}</p>}
        {info?.ok && (
          <div className="rounded-md border border-border p-3 text-sm" data-testid="backup-info">
            <p>
              <b>{info.orgName}</b> {info.teamName} · 백업 시각 {info.createdAt ? format(info.createdAt, 'yyyy-MM-dd HH:mm') : ''}
            </p>
          </div>
        )}
        {info?.ok && (
          <Field label="이 PC를 쓸 관리자" hint="이 PC는 고른 관리자로 로그인되고, 그 사람이 최종관리자(서버 PC)가 됩니다.">
            <Select aria-label="관리자" value={adminId} onChange={(e) => setAdminId(e.target.value)}>
              {info.admins?.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="이 PC의 서버 데이터 폴더">
          <Input aria-label="서버 데이터 폴더" value={dataDir} onChange={(e) => setDataDir(e.target.value)} />
        </Field>
        {result && !result.ok && <p className="text-sm text-urgent">{result.error}</p>}
        <div className="flex justify-between">
          <Button variant="ghost" onClick={onBack}>
            <ArrowLeft /> 뒤로
          </Button>
          <Button disabled={!info?.ok || !adminId || !dataDir.trim() || busy} onClick={() => void run()}>
            {busy && <Loader2 className="animate-spin" />} 옮겨 오기
          </Button>
        </div>
      </div>
    </SetupFrame>
  )
}
