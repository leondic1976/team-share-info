import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Upload, Loader2 } from 'lucide-react'
import { format } from 'date-fns'
import { api, authHeaders, buildUrl, errorMessage, ApiError } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Field } from '@renderer/features/setup/SetupFrame'
import { useSession } from '@renderer/app/session-store'
import type { DeviceDto } from '@shared/schemas/auth'
import { compareVersions } from '@shared/semver'

interface ReleaseDto {
  id: string
  version: string
  notes: string
  fileName: string
  sha512: string
  size: number
  mandatory: boolean
  state: 'published' | 'withdrawn'
  publishedAt: number
}

/** Upload with progress via XHR (fetch has no upload progress). */
function uploadRelease(file: File, meta: { version: string; notes: string; mandatory: boolean }, onProgress: (p: number) => void): Promise<ReleaseDto> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', buildUrl('/api/admin/releases', { version: meta.version, notes: meta.notes, mandatory: meta.mandatory ? '1' : '0', fileName: file.name }))
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText)
        if (xhr.status >= 200 && xhr.status < 300) resolve(json.data)
        else reject(new ApiError(json.error?.code ?? 'HTTP', json.error?.message ?? `업로드 실패 (${xhr.status})`, xhr.status))
      } catch {
        reject(new Error(`업로드 실패 (${xhr.status})`))
      }
    }
    xhr.onerror = () => reject(new Error('서버에 연결할 수 없습니다.'))
    xhr.send(file)
  })
}

export function ReleasesTab(): React.JSX.Element {
  const qc = useQueryClient()
  const app = useSession((s) => s.app)
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [version, setVersion] = useState('')
  const [notes, setNotes] = useState('')
  const [mandatory, setMandatory] = useState(false)
  const [progress, setProgress] = useState<number | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const releases = useQuery({ queryKey: ['admin', 'releases'], queryFn: () => api.get<ReleaseDto[]>('/api/admin/releases') })
  const devices = useQuery({ queryKey: ['admin', 'devices'], queryFn: () => api.get<DeviceDto[]>('/api/admin/devices') })
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/admin/releases/${id}`, body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'releases'] })
  })

  const pick = (f: File | null): void => {
    setFile(f)
    const m = f?.name.match(/(\d+\.\d+\.\d+(?:-[\w.]+)?)/)
    if (m) setVersion(m[1])
  }

  const submit = async (): Promise<void> => {
    if (!file || !version) return
    setMsg(null)
    setProgress(0)
    try {
      const r = await uploadRelease(file, { version, notes, mandatory }, setProgress)
      setMsg({ ok: true, text: `v${r.version}을(를) 배포했습니다. 접속 중인 PC가 자동으로 내려받습니다.` })
      setFile(null)
      setVersion('')
      setNotes('')
      if (fileRef.current) fileRef.current.value = ''
      void qc.invalidateQueries({ queryKey: ['admin', 'releases'] })
    } catch (e) {
      setMsg({ ok: false, text: errorMessage(e) })
    } finally {
      setProgress(null)
    }
  }

  const latest = releases.data?.find((r) => r.state === 'published')?.version
  const versionCount = new Map<string, number>()
  for (const d of devices.data ?? []) if (!d.revokedAt) versionCount.set(d.appVersion ?? '알 수 없음', (versionCount.get(d.appVersion ?? '알 수 없음') ?? 0) + 1)

  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>새 버전 배포</CardTitle>
          <span className="text-xs text-muted-foreground">이 PC 버전 v{app?.version}</span>
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="설치 파일 (TeamHub-Setup-x.y.z.exe)">
            <input ref={fileRef} type="file" accept=".exe" aria-label="설치 파일" className="text-sm" onChange={(e) => pick(e.target.files?.[0] ?? null)} />
          </Field>
          <div className="grid grid-cols-3 gap-3">
            <Field label="버전">
              <Input aria-label="버전" value={version} onChange={(e) => setVersion(e.target.value.trim())} placeholder="1.0.1" />
            </Field>
            <label className="col-span-2 flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" checked={mandatory} onChange={(e) => setMandatory(e.target.checked)} /> 필수 업데이트(보안 패치 등)
            </label>
          </div>
          <Field label="변경 내용">
            <Textarea aria-label="변경 내용" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="flex items-center gap-3">
            <Button onClick={() => void submit()} disabled={!file || !version || progress !== null}>
              {progress !== null ? <Loader2 className="animate-spin" /> : <Upload />} 배포
            </Button>
            {progress !== null && <span className="text-sm">{progress}%</span>}
            {msg && <span className={msg.ok ? 'text-sm text-success' : 'text-sm text-urgent'}>{msg.text}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>팀원 설치 버전</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2 text-sm">
          {[...versionCount.entries()]
            .sort((a, b) => compareVersions(b[0], a[0]))
            .map(([v, n]) => (
              <Badge key={v} variant={v === latest ? 'success' : 'muted'}>
                v{v} · {n}대
              </Badge>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>배포 기록</CardTitle>
        </CardHeader>
        <div className="divide-y divide-border">
          {releases.data?.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">배포한 버전이 없습니다.</p>}
          {releases.data?.map((r) => (
            <div key={r.id} className="flex items-start gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <b>v{r.version}</b>
                  {r.version === latest && <Badge variant="success">현재 배포</Badge>}
                  {r.mandatory && <Badge variant="urgent">필수</Badge>}
                  {r.state === 'withdrawn' && <Badge variant="muted">회수됨</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {format(r.publishedAt, 'yyyy-MM-dd HH:mm')} · {(r.size / 1024 / 1024).toFixed(1)}MB
                  </span>
                </div>
                {r.notes && <p className="mt-1 whitespace-pre-wrap text-muted-foreground">{r.notes}</p>}
              </div>
              <Button size="sm" variant="ghost" onClick={() => patch.mutate({ id: r.id, body: { state: r.state === 'published' ? 'withdrawn' : 'published' } })}>
                {r.state === 'published' ? '배포 회수' : '다시 배포'}
              </Button>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}
