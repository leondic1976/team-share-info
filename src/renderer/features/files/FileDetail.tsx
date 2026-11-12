import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Download, RotateCcw, ExternalLink, Lock, Unlock, History } from 'lucide-react'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { formatSize } from '@renderer/components/Attachments'
import { api, authHeaders, buildUrl, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { useMe } from '@renderer/lib/queries'
import type { FileDto, FileVersionDto } from '@shared/schemas/files'
import { FavoriteStar } from '@renderer/features/memos/widgets'

const IMG = /\.(png|jpe?g|gif|bmp|webp|svg)$/i
const TXT = /\.(txt|csv|log|md|json|xml|ini)$/i
const PDF = /\.pdf$/i

export function canPreview(name: string): boolean {
  return IMG.test(name) || TXT.test(name) || PDF.test(name)
}

/** Preview images, PDFs and small text files (M4-4). */
function Preview({ file }: { file: FileDto }): React.JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    if (!canPreview(file.name)) return
    if (file.size > 30 * 1024 * 1024) {
      setErr('파일이 커서 미리보기를 하지 않습니다. 내려받아 여세요.')
      return
    }
    let revoke: string | null = null
    void fetch(buildUrl(`/api/files/${file.id}/download`, { inline: '1' }), { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error('미리보기를 불러오지 못했습니다.')
        if (TXT.test(file.name)) setText((await r.text()).slice(0, 200_000))
        else {
          const type = PDF.test(file.name) ? 'application/pdf' : file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/*'
          revoke = URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }))
          setUrl(revoke)
        }
      })
      .catch((e) => setErr(errorMessage(e)))
    return () => {
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [file])
  if (!canPreview(file.name)) return null
  if (err) return <p className="text-sm text-muted-foreground">{err}</p>
  if (text !== null) return <pre className="selectable max-h-80 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">{text}</pre>
  if (!url) return <p className="text-sm text-muted-foreground">미리보기를 불러오는 중…</p>
  if (PDF.test(file.name)) return <iframe title="PDF 미리보기" src={url} className="h-[60vh] w-full rounded border border-border" />
  return <img src={url} alt={file.name} className="max-h-[50vh] rounded border border-border object-contain" />
}

export function FileDetail({ fileId, onClose }: { fileId: string; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [msg, setMsg] = useState('')
  const q = useQuery({
    queryKey: ['files', 'detail', fileId],
    queryFn: () => api.get<{ file: FileDto; path: string; versions: FileVersionDto[]; canWrite: boolean; canDelete: boolean }>(`/api/files/${fileId}`)
  })
  const history = useQuery({
    queryKey: ['files', 'downloads', fileId],
    queryFn: () => api.get<{ name: string; at: number; version_no: number }[]>(`/api/files/${fileId}/downloads`),
    enabled: !!q.data?.canDelete,
    retry: false
  })
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setMsg('')
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
    onError: (e) => setMsg(errorMessage(e))
  })
  const d = q.data
  if (!d) return <Dialog open onClose={onClose} title="파일 정보">{q.error ? <p className="text-sm text-urgent">{errorMessage(q.error)}</p> : <p className="text-sm">불러오는 중…</p>}</Dialog>
  const f = d.file
  const lockedByOther = !!f.lockedBy && f.lockedBy !== me?.id
  return (
    <Dialog open onClose={onClose} title={f.name} width="max-w-3xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <FavoriteStar itemType="file" itemId={f.id} title={f.name} route={`/files/${f.folderId}`} />
          <span>{d.path}</span>·<span>{formatSize(f.size)}</span>·<span>v{f.versionCount}</span>·<span>올린 사람 {f.createdByName}</span>
          {f.lockedBy && (
            <Badge variant="important">
              <Lock className="size-3" /> {f.lockedByName} 편집 중
            </Badge>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() =>
              run.mutate(async () => {
                const r = await invoke('transfer:open', { fileId: f.id, name: f.name, folderId: f.folderId })
                if (!r.ok) throw new Error(r.error ?? '열 수 없습니다.')
                setMsg('연결된 프로그램으로 열었습니다. 저장하면 새 버전으로 올릴지 묻습니다.')
              })
            }
          >
            <ExternalLink /> 바로 열기
          </Button>
          <Button variant="outline" onClick={() => void invoke('transfer:download', { fileId: f.id, name: f.name })}>
            <Download /> 내려받기
          </Button>
          {d.canWrite &&
            (f.lockedBy === me?.id ? (
              <Button variant="outline" onClick={() => run.mutate(() => api.del(`/api/files/${f.id}/lock`))}>
                <Unlock /> 편집 잠금 풀기
              </Button>
            ) : (
              !f.lockedBy && (
                <Button variant="outline" onClick={() => run.mutate(() => api.post(`/api/files/${f.id}/lock`))} title="다른 사람이 동시에 고치지 못하게 표시합니다">
                  <Lock /> 편집 잠금
                </Button>
              )
            ))}
          {lockedByOther && (d.canDelete || me?.role === 'admin') && (
            <Button variant="outline" onClick={() => window.confirm('다른 사람의 편집 잠금을 강제로 풀까요?') && run.mutate(() => api.del(`/api/files/${f.id}/lock`))}>
              <Unlock /> 잠금 강제 해제
            </Button>
          )}
        </div>
        {msg && <p className="text-sm text-muted-foreground">{msg}</p>}
        <Preview file={f} />
        <div>
          <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
            <History className="size-4" /> 버전
          </h3>
          <div className="divide-y divide-border rounded-md border border-border">
            {d.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-3 py-1.5 text-sm" data-testid={`version-${v.versionNo}`}>
                <b className="w-10">v{v.versionNo}</b>
                <span className="text-muted-foreground">{format(v.createdAt, 'yyyy-MM-dd HH:mm')}</span>
                <span>{v.createdByName}</span>
                <span className="text-muted-foreground">{formatSize(v.size)}</span>
                <span className="truncate text-xs text-muted-foreground">{v.note}</span>
                <span className="ml-auto flex gap-1">
                  {v.id === f.currentVersionId ? (
                    <Badge variant="success">현재</Badge>
                  ) : (
                    d.canWrite &&
                    !lockedByOther && (
                      <Button size="sm" variant="ghost" onClick={() => window.confirm(`v${v.versionNo}을(를) 현재 버전으로 되돌릴까요? (새 버전으로 등록됩니다)`) && run.mutate(() => api.post(`/api/files/${f.id}/restore-version`, { versionId: v.id }))}>
                        <RotateCcw /> 이 버전으로 복원
                      </Button>
                    )
                  )}
                  <Button size="icon-sm" variant="ghost" aria-label={`v${v.versionNo} 내려받기`} onClick={() => void invoke('transfer:download', { fileId: f.id, name: f.name.replace(/(\.[^.]+)?$/, `_v${v.versionNo}$1`), versionId: v.id })}>
                    <Download />
                  </Button>
                </span>
              </div>
            ))}
          </div>
        </div>
        {history.data && (
          <div>
            <h3 className="mb-1.5 text-sm font-semibold">내려받기 기록</h3>
            {history.data.length ? (
              <div className="max-h-40 overflow-y-auto text-xs">
                {history.data.map((h, i) => (
                  <div key={i} className="flex gap-3 py-0.5">
                    <span className="text-muted-foreground">{format(h.at, 'M/d HH:mm')}</span>
                    <span>{h.name}</span>
                    <span className="text-muted-foreground">v{h.version_no}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">아직 내려받은 사람이 없습니다.</p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
