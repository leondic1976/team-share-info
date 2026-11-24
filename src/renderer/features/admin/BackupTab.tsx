import { EmptyNote } from '@renderer/components/EmptyState'
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { DatabaseBackup, FolderOpen, Loader2, RotateCcw } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { fmtSize } from '@renderer/features/myfiles/common'
import { StorageCard } from '@renderer/features/settings/StorageCard'

interface BackupList {
  root: string
  state: { lastAt: number | null; lastPath: string | null; lastError: string | null }
  backups: { name: string; path: string; createdAt: number; version: string; dbBytes: number; fileCount: number; fileBytes: number }[]
}

/** Admin: backups, back up now, restore, and how to move the server (6.16). */
export function BackupTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [msg, setMsg] = useState('')
  const q = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => api.get<BackupList>('/api/admin/backups') })
  const run = useMutation({
    mutationFn: () => api.post<{ name: string }>('/api/admin/backups'),
    onSuccess: (r) => {
      setMsg(`백업했습니다: ${r.name}`)
      void qc.invalidateQueries({ queryKey: ['admin', 'backups'] })
    },
    onError: (e) => setMsg(errorMessage(e))
  })
  const restore = useMutation({
    mutationFn: (name: string) => api.post('/api/admin/backups/restore', { name }),
    onSuccess: () => setMsg('복구를 위해 서버를 다시 시작합니다. 잠시 뒤 자동으로 다시 연결됩니다.'),
    onError: (e) => setMsg(errorMessage(e))
  })
  const d = q.data
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>백업</CardTitle>
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? <Loader2 className="animate-spin" /> : <DatabaseBackup />} 지금 백업
          </Button>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          <p>
            위치: <span className="font-mono">{d?.root}</span>
            {d?.root && (
              <Button size="sm" variant="ghost" onClick={() => void invoke('fm:reveal', { path: d.backups[0]?.path ?? d.root })}>
                <FolderOpen /> 폴더 열기
              </Button>
            )}
          </p>
          <p className="text-muted-foreground">
            마지막 백업: {d?.state.lastAt ? format(d.state.lastAt, 'yyyy-MM-dd HH:mm') : '없음'}
            {d?.state.lastError && <span className="ml-2 text-urgent">오류: {d.state.lastError}</span>}
          </p>
          <p className="text-xs text-muted-foreground">매일 정한 시각에 자동으로 백업합니다(위치·시각·보관 개수는 조직·운영 설정의 백업 항목). 다른 드라이브나 USB를 위치로 정하면 서버 PC가 고장 나도 되살릴 수 있습니다.</p>
          {msg && (
            <p className="text-primary" role="status">
              {msg}
            </p>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>백업 목록</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 p-2" data-testid="backup-list">
          {!d?.backups.length && <EmptyNote>아직 백업이 없습니다.</EmptyNote>}
          {d?.backups.map((b) => (
            <div key={b.name} className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted" data-testid="backup-item">
              <span className="w-36 shrink-0">{format(b.createdAt, 'yyyy-MM-dd HH:mm')}</span>
              <span className="text-xs text-muted-foreground">
                DB {fmtSize(b.dbBytes)} · 파일 {b.fileCount}개 {fmtSize(b.fileBytes)} · v{b.version}
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                onClick={() => {
                  if (window.confirm(`${format(b.createdAt, 'yyyy-MM-dd HH:mm')} 백업으로 되돌릴까요? 그 뒤에 올라온 내용은 사라집니다(지금 상태는 따로 보관됩니다). 서버가 잠시 다시 시작합니다.`)) restore.mutate(b.name)
                }}
              >
                <RotateCcw /> 이 백업으로 복구
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
      {/* only on the server PC itself */}
      <StorageCard kind="server" />
      <Card>
        <CardHeader>
          <CardTitle>서버 PC 바꾸기 (서버 이전)</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1 text-sm">
          <p>1. 여기서 지금 백업을 누릅니다.</p>
          <p>2. 백업 위치의 TeamHub-날짜 폴더와 blobs 폴더를 함께 새 PC로 복사합니다(같은 폴더 안에 두기).</p>
          <p>3. 새 PC에 TeamHub를 설치하고 첫 화면에서 기존 서버의 백업으로 이 PC를 서버로 만들기를 고릅니다.</p>
          <p>4. 예전 서버 PC는 끄거나 접속 모드로 바꿉니다. 팀원은 다시 승인받을 필요가 없습니다.</p>
        </CardContent>
      </Card>
    </div>
  )
}
