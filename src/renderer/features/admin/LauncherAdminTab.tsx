import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Folder, Globe, Plus, Trash2, Upload } from 'lucide-react'
import type { TeamLauncherDto, TeamLauncherKind } from '@shared/schemas/launcher'
import type { SecurityProgramDto } from '@shared/schemas/sysutil'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { confirmDialog } from '@renderer/components/Dialog'
import { uploadAttachment } from '@renderer/components/Attachments'
import { Field } from '@renderer/features/setup/SetupFrame'

const KIND_LABEL: Record<TeamLauncherKind, string> = { url: '업무 사이트', path: '공용 폴더·문서', template: '양식 파일' }
const ICON = { url: Globe, path: Folder, template: FileText }

/** Admin: team launcher items distributed to everyone (6.13 팀 공용 런처·양식함). */
export function LauncherAdminTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [kind, setKind] = useState<TeamLauncherKind>('url')
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [group, setGroup] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['launcher', 'team'], queryFn: () => api.get<TeamLauncherDto[]>('/api/launcher') })
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['launcher'] })
  const add = useMutation({
    mutationFn: async () => {
      let attachmentId: string | undefined
      if (kind === 'template') {
        if (!file) throw new Error('양식 파일을 고르세요.')
        attachmentId = (await uploadAttachment(file)).id
      }
      return api.post('/api/admin/launcher', { kind, name, target, groupName: group, attachmentId })
    },
    onSuccess: () => {
      setName('')
      setTarget('')
      setFile(null)
      setErr('')
      refresh()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/admin/launcher/${id}`), onSuccess: refresh })
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>공용 런처 항목 추가</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="종류">
            <Select aria-label="공용 항목 종류" value={kind} onChange={(e) => setKind(e.target.value as TeamLauncherKind)}>
              {Object.entries(KIND_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="이름">
            <Input aria-label="공용 항목 이름" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 전자결재, 공용 자료 폴더, 출장 신청서" />
          </Field>
          {kind === 'template' ? (
            <Field label="양식 파일" hint="한글·엑셀 등 문서 파일. 팀원이 누르면 사본을 만들어 엽니다.">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <Upload className="size-4" />
                <input type="file" aria-label="양식 파일" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </label>
            </Field>
          ) : (
            <Field label={kind === 'url' ? '주소' : '경로'} hint={kind === 'url' ? 'http:// 또는 https:// 로 시작' : '공유 폴더(\\\\서버\\폴더) 또는 문서 경로. 실행 파일은 등록할 수 없습니다.'}>
              <Input aria-label="공용 항목 대상" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={kind === 'url' ? 'https://' : '\\\\FILESERVER\\공용'} />
            </Field>
          )}
          <Field label="분류 (선택)">
            <Input aria-label="공용 항목 분류" maxLength={30} value={group} onChange={(e) => setGroup(e.target.value)} placeholder="예: 업무 사이트, 양식" />
          </Field>
          {err && <p className="text-sm text-urgent">{err}</p>}
          <Button disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>
            <Plus /> 추가
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>등록된 항목 ({q.data?.length ?? 0})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-2">
          {q.data?.map((i) => {
            const Icon = ICON[i.kind]
            return (
              <div key={i.id} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted">
                <Icon className="size-4 shrink-0 text-muted-foreground" />
                <span className="font-medium">{i.name}</span>
                <span className="truncate text-xs text-muted-foreground">{i.kind === 'template' ? i.fileName : i.target}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{i.groupName}</span>
                <Button size="icon-sm" variant="ghost" aria-label={`${i.name} 삭제`} onClick={() => confirmDialog(`"${i.name}"을(를) 지울까요?`) && del.mutate(i.id)}>
                  <Trash2 />
                </Button>
              </div>
            )
          })}
        </CardContent>
      </Card>
      <SecurityProgramsCard />
    </div>
  )
}

/** Admin: security programs every PC should run (6.14 ② 기관 지정 보안프로그램). */
function SecurityProgramsCard(): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [procs, setProcs] = useState('')
  const [svcs, setSvcs] = useState('')
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['security-programs'], queryFn: () => api.get<SecurityProgramDto[]>('/api/security-programs') })
  const split = (s: string): string[] =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  const add = useMutation({
    mutationFn: () => api.post('/api/admin/security-programs', { name, processNames: split(procs), serviceNames: split(svcs) }),
    onSuccess: () => {
      setName('')
      setProcs('')
      setSvcs('')
      setErr('')
      void qc.invalidateQueries({ queryKey: ['security-programs'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/admin/security-programs/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['security-programs'] }) })
  return (
    <Card>
      <CardHeader>
        <CardTitle>보안 점검 지정 프로그램</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">팀원의 보안 점검에서 설치·실행 여부를 확인할 프로그램입니다. 점검 결과는 각자 PC에만 남고 관리자에게 오지 않습니다.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          <Input aria-label="보안프로그램 이름" placeholder="이름 (예: 문서보안)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input aria-label="프로세스 이름" placeholder="프로세스 (예: agent.exe)" value={procs} onChange={(e) => setProcs(e.target.value)} />
          <Input aria-label="서비스 이름" placeholder="서비스 (쉼표로 구분)" value={svcs} onChange={(e) => setSvcs(e.target.value)} />
        </div>
        {err && <p className="text-sm text-urgent">{err}</p>}
        <Button size="sm" disabled={!name.trim() || add.isPending} onClick={() => add.mutate()}>
          <Plus /> 추가
        </Button>
        <div className="space-y-1">
          {q.data?.map((p) => (
            <div key={p.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
              <span className="font-medium">{p.name}</span>
              <span className="truncate text-xs text-muted-foreground">{[...p.processNames, ...p.serviceNames.map((s) => `서비스:${s}`)].join(', ')}</span>
              <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`${p.name} 삭제`} onClick={() => del.mutate(p.id)}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
