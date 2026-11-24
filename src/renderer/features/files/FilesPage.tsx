import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from 'react-router-dom'
import { format } from 'date-fns'
import { Folder, FolderPlus, Upload, FolderUp, Search, Trash2, Clock, ChevronRight, File as FileIcon, Lock, MoreHorizontal, Pencil, Download, ExternalLink, RotateCcw, Settings2, Home, TriangleAlert } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { ScopePicker, ScopeTags, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { EmptyState, ErrorState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { formatSize } from '@renderer/components/Attachments'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { invoke, onMain } from '@renderer/lib/bridge'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import type { FileDto, FolderDto, FolderView, TrashItemDto } from '@shared/schemas/files'
import type { ScopeInput } from '@shared/schemas/scope'
import { FileDetail } from './FileDetail'
import { cn } from '@renderer/lib/utils'

type Mode = 'browse' | 'recent' | 'search' | 'trash'

function FolderDialog({ parent, edit, onClose }: { parent: FolderDto | null; edit?: FolderDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const isRoot = edit ? !edit.parentId : !parent
  const [name, setName] = useState(edit?.name ?? '')
  const [scope, setScope] = useState<ScopeInput>(
    edit ? { type: edit.scope.type, groupIds: edit.scope.groups.map((g) => g.id), memberIds: edit.scope.members.map((m) => m.id) } : defaultScope(space)
  )
  const [policy, setPolicy] = useState<'all' | 'owner'>(edit?.writePolicy ?? 'all')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () =>
      edit
        ? api.patch(`/api/folders/${edit.id}`, isRoot ? { name, scope, writePolicy: policy } : { name })
        : api.post('/api/folders', { parentId: parent?.id ?? null, name, ...(isRoot ? { scope, writePolicy: policy } : {}) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['files'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '폴더 설정' : isRoot ? '새 최상위 폴더' : '새 폴더'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || (isRoot && !scopeIsValid(scope))}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="폴더 이름">
          <Input aria-label="폴더 이름" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {isRoot ? (
          <>
            <Field label="공개 범위" hint="이 폴더 안의 모든 하위 폴더와 파일에 적용됩니다.">
              <ScopePicker value={scope} onChange={setScope} initial={edit ? scope : undefined} />
            </Field>
            <Field label="올리기 권한">
              <div className="flex gap-2">
                <Button size="sm" variant={policy === 'all' ? 'default' : 'outline'} onClick={() => setPolicy('all')}>
                  볼 수 있는 사람 모두
                </Button>
                <Button size="sm" variant={policy === 'owner' ? 'default' : 'outline'} onClick={() => setPolicy('owner')}>
                  만든 사람·관리자만 (읽기 전용 폴더)
                </Button>
              </div>
            </Field>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">하위 폴더는 최상위 폴더의 공개 범위와 권한을 따릅니다.</p>
        )}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function RowMenu({ items }: { items: { label: string; icon: typeof Pencil; run: () => void; danger?: boolean }[] }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <Button size="icon-sm" variant="ghost" aria-label="더 보기" onClick={() => setOpen(!open)}>
        <MoreHorizontal />
      </Button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-40 mt-1 w-40 rounded-md border border-border bg-card p-1 shadow-lg">
            {items.map((i) => (
              <button
                key={i.label}
                className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted', i.danger && 'text-urgent')}
                onClick={() => {
                  setOpen(false)
                  i.run()
                }}
              >
                <i.icon className="size-4" /> {i.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

export function FilesPage(): React.JSX.Element {
  const { folderId } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [mode, setMode] = useState<Mode>('browse')
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<null | { kind: 'folder'; edit?: FolderDto }>(null)
  const [detail, setDetail] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const [edited, setEdited] = useState<null | { fileId: string; folderId: string; name: string; path: string }>(null)

  const view = useQuery({
    queryKey: ['files', 'view', folderId ?? 'root', space],
    queryFn: () => api.get<FolderView>('/api/files/view', { folderId, groupId: !folderId && space !== 'team' ? space : undefined }),
    enabled: online && mode === 'browse',
    placeholderData: (p) => p
  })
  const list = useQuery({
    queryKey: ['files', mode, q, space],
    queryFn: () => api.get<FileDto[]>('/api/files/search', { q: mode === 'search' ? q : '', recent: mode === 'recent', groupId: space === 'team' ? undefined : space }),
    enabled: online && (mode === 'recent' || (mode === 'search' && q.trim().length > 0))
  })
  const trash = useQuery({ queryKey: ['files', 'trash'], queryFn: () => api.get<TrashItemDto[]>('/api/trash'), enabled: online && mode === 'trash' })

  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setMsg('')
      void qc.invalidateQueries({ queryKey: ['files'] })
    },
    onError: (e) => setMsg(errorMessage(e))
  })

  // A file opened with "바로 열기" was saved in its program: offer a new version (M4-3).
  useEffect(() => onMain('transfer:edited', (e) => setEdited(e)), [])

  const folder = view.data?.folder ?? null
  const canWrite = !!folder?.canWrite

  const uploadPaths = async (paths: string[]): Promise<void> => {
    if (!folder) return setMsg('파일을 올릴 폴더를 먼저 여세요.')
    if (!canWrite) return setMsg('이 폴더에 올릴 권한이 없습니다.')
    if (!paths.length) return
    const n = await invoke('transfer:upload', { paths, folderId: folder.id })
    setMsg(`${n}개 파일을 올리는 중입니다. 오른쪽 아래에서 진행 상황을 볼 수 있습니다.`)
  }

  const openFile = (f: FileDto): void =>
    run.mutate(async () => {
      const r = await invoke('transfer:open', { fileId: f.id, name: f.name, folderId: f.folderId })
      if (!r.ok) throw new Error(r.error ?? '열 수 없습니다.')
    })

  const fileMenu = (f: FileDto) => [
    { label: '바로 열기', icon: ExternalLink, run: () => openFile(f) },
    { label: '내려받기', icon: Download, run: () => void invoke('transfer:download', { fileId: f.id, name: f.name }) },
    { label: '버전·정보', icon: Clock, run: () => setDetail(f.id) },
    {
      label: '이름 바꾸기',
      icon: Pencil,
      run: () => {
        const name = window.prompt('새 이름', f.name)
        if (name && name !== f.name) run.mutate(() => api.patch(`/api/files/${f.id}`, { name }))
      }
    },
    { label: '삭제', icon: Trash2, danger: true, run: () => window.confirm(`'${f.name}'을(를) 휴지통으로 옮길까요?`) && run.mutate(() => api.del(`/api/files/${f.id}`)) }
  ]

  const folderMenu = (f: FolderDto) => [
    { label: '설정', icon: Settings2, run: () => setDialog({ kind: 'folder', edit: f }) },
    { label: '삭제', icon: Trash2, danger: true, run: () => window.confirm(`'${f.name}' 폴더와 안의 내용을 휴지통으로 옮길까요?`) && run.mutate(() => api.del(`/api/folders/${f.id}`)) }
  ]

  const fileRow = (f: FileDto, showPath = false): React.JSX.Element => (
    <tr key={f.id} className="cursor-pointer hover:bg-muted/60" onDoubleClick={() => openFile(f)} onClick={() => setDetail(f.id)} data-testid={`file-row-${f.name}`}>
      <td className="px-4 py-2">
        <span className="flex items-center gap-2">
          <FileIcon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{f.name}</span>
          {f.lockedBy && (
            <span className="flex items-center gap-0.5 text-xs text-important" title={`${f.lockedByName} 편집 중`}>
              <Lock className="size-3" /> {f.lockedByName}
            </span>
          )}
        </span>
        {showPath && f.path && <span className="block pl-6 text-xs text-muted-foreground">{f.path}</span>}
      </td>
      <td className="text-right text-muted-foreground">{formatSize(f.size)}</td>
      <td className="text-center text-muted-foreground">v{f.versionCount}</td>
      <td className="text-muted-foreground">{f.updatedByName ?? f.createdByName}</td>
      <td className="text-muted-foreground">{format(f.updatedAt, 'yyyy-MM-dd HH:mm')}</td>
      <td className="pr-2">
        <RowMenu items={fileMenu(f)} />
      </td>
    </tr>
  )

  const table = (rows: React.ReactNode): React.JSX.Element => (
    <table className="w-full text-sm">
      <thead className="sticky top-0 bg-background text-left text-xs text-muted-foreground">
        <tr>
          <th className="px-4 py-2">이름</th>
          <th className="w-24 text-right">크기</th>
          <th className="w-16 text-center">버전</th>
          <th className="w-28">수정한 사람</th>
          <th className="w-36">수정 시각</th>
          <th className="w-10" />
        </tr>
      </thead>
      <tbody className="divide-y divide-border">{rows}</tbody>
    </table>
  )

  let body: React.ReactNode
  if (!online && !view.data) body = <OfflineState />
  else if (mode === 'trash') {
    body = !trash.data?.length ? (
      <EmptyState icon={Trash2} title="휴지통이 비어 있습니다" description="지운 파일과 폴더는 30일 동안 여기에 남았다가 자동으로 지워집니다." />
    ) : (
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-2">이름</th>
            <th>원래 위치</th>
            <th>지운 사람</th>
            <th>지운 시각</th>
            <th className="w-48" />
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {trash.data.map((t) => (
            <tr key={t.type + t.id}>
              <td className="px-4 py-2">
                <span className="flex items-center gap-2">
                  {t.type === 'folder' ? <Folder className="size-4 text-important" /> : <FileIcon className="size-4 text-muted-foreground" />}
                  {t.name}
                </span>
              </td>
              <td className="text-muted-foreground">{t.location}</td>
              <td className="text-muted-foreground">{t.deletedByName}</td>
              <td className="text-muted-foreground">{format(t.deletedAt, 'M/d HH:mm')}</td>
              <td className="space-x-1 pr-4 text-right">
                <Button size="sm" variant="outline" onClick={() => run.mutate(() => api.post(`/api/trash/${t.type}/${t.id}/restore`))}>
                  <RotateCcw /> 복원
                </Button>
                <Button size="sm" variant="ghost" className="text-urgent" onClick={() => window.confirm('완전히 지웁니다. 되돌릴 수 없습니다.') && run.mutate(() => api.del(`/api/trash/${t.type}/${t.id}`))}>
                  영구 삭제
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  } else if (mode === 'recent' || mode === 'search') {
    body = list.isLoading ? <Loading /> : !list.data?.length ? <EmptyState icon={Search} title={mode === 'search' ? '찾은 파일이 없습니다' : '최근 파일이 없습니다'} /> : table(list.data.map((f) => fileRow(f, true)))
  } else if (view.error) body = <ErrorState error={view.error} onRetry={() => navigate('/files')} />
  else if (view.isLoading || !view.data) body = <Loading />
  else {
    const v = view.data
    body =
      !v.folders.length && !v.files.length ? (
        <EmptyState
          icon={Folder}
          title={folder ? '빈 폴더입니다' : '폴더가 없습니다'}
          description={folder ? (canWrite ? '파일을 이 창에 끌어다 놓거나 [파일 올리기]를 누르세요.' : '이 폴더는 읽기 전용입니다.') : '[새 폴더]로 최상위 폴더를 만들고 공개 범위를 정하세요.'}
        />
      ) : (
        table(
          <>
            {v.folders.map((f) => (
              <tr key={f.id} className="cursor-pointer hover:bg-muted/60" onClick={() => navigate(`/files/${f.id}`)} data-testid={`folder-row-${f.name}`}>
                <td className="px-4 py-2" colSpan={folder ? 1 : 1}>
                  <span className="flex items-center gap-2">
                    <Folder className="size-4 shrink-0 fill-important/20 text-important" />
                    <span className="truncate font-medium">{f.name}</span>
                    {!folder && <ScopeTags scope={f.scope} />}
                    {!folder && f.writePolicy === 'owner' && <span className="text-xs text-muted-foreground">(읽기 전용)</span>}
                  </span>
                </td>
                <td />
                <td />
                <td className="text-muted-foreground">{f.createdByName}</td>
                <td className="text-muted-foreground">{format(f.updatedAt, 'yyyy-MM-dd HH:mm')}</td>
                <td className="pr-2">{f.canManage && <RowMenu items={folderMenu(f)} />}</td>
              </tr>
            ))}
            {v.files.map((f) => fileRow(f))}
          </>
        )
      )
  }

  return (
    <div
      className="relative flex h-full flex-col"
      onDragOver={(e) => {
        if (mode !== 'browse' || !folder) return
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDragOver(false)
        const paths = [...e.dataTransfer.files].map((f) => window.teamhub.pathForFile(f)).filter(Boolean)
        void uploadPaths(paths)
      }}
    >
      <PageHeader
        title="자료실"
        description="같은 이름으로 올리면 새 버전으로 쌓이고, 이전 버전은 언제든 되돌릴 수 있습니다."
        actions={
          <>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input
                aria-label="파일 검색"
                className="w-56 pl-8"
                placeholder="파일 이름 검색"
                value={q}
                onChange={(e) => {
                  setQ(e.target.value)
                  setMode(e.target.value.trim() ? 'search' : 'browse')
                }}
              />
            </div>
            <Button variant={mode === 'recent' ? 'secondary' : 'outline'} onClick={() => setMode(mode === 'recent' ? 'browse' : 'recent')}>
              <Clock /> 최근
            </Button>
            <Button variant={mode === 'trash' ? 'secondary' : 'outline'} onClick={() => setMode(mode === 'trash' ? 'browse' : 'trash')}>
              <Trash2 /> 휴지통
            </Button>
          </>
        }
      />
      {mode === 'browse' && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-5 py-2">
          <nav aria-label="폴더 경로" className="flex min-w-0 flex-1 items-center gap-1 text-sm">
            <button className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => navigate('/files')}>
              <Home className="size-4" /> 자료실
            </button>
            {view.data?.breadcrumb.map((b) => (
              <span key={b.id} className="flex items-center gap-1">
                <ChevronRight className="size-4 text-muted-foreground" />
                <button className="cursor-pointer truncate rounded px-1.5 py-0.5 hover:bg-muted" onClick={() => navigate(`/files/${b.id}`)}>
                  {b.name}
                </button>
              </span>
            ))}
            {folder && <ScopeTags scope={folder.scope} />}
          </nav>
          <Button size="sm" variant="outline" onClick={() => setDialog({ kind: 'folder' })} disabled={!online || (!!folder && !canWrite)}>
            <FolderPlus /> 새 폴더
          </Button>
          <Button size="sm" variant="outline" disabled={!folder || !canWrite} onClick={async () => uploadPaths(await invoke('transfer:pick', { folders: true }))}>
            <FolderUp /> 폴더 올리기
          </Button>
          <Button size="sm" disabled={!folder || !canWrite} onClick={async () => uploadPaths(await invoke('transfer:pick', { folders: false }))}>
            <Upload /> 파일 올리기
          </Button>
        </div>
      )}
      {msg && (
        <p className="border-b border-border px-5 py-1.5 text-xs text-muted-foreground" onClick={() => setMsg('')}>
          {msg}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="files-body">
        {body}
      </div>
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center border-4 border-dashed border-primary bg-primary/10 text-lg font-bold text-primary">
          여기에 놓으면 '{folder?.name}' 폴더에 올립니다
        </div>
      )}
      <p className="shrink-0 border-t border-border px-5 py-1 text-xs text-[var(--notice-fg)]"><TriangleAlert className="mr-1 inline size-3.5 align-[-0.15em]" aria-hidden />중요 보안 내용, 개인정보, 비공개 정보는 올릴 수 없습니다.</p>
      {dialog?.kind === 'folder' && <FolderDialog parent={folder} edit={dialog.edit} onClose={() => setDialog(null)} />}
      {detail && <FileDetail fileId={detail} onClose={() => setDetail(null)} />}
      {edited && (
        <Dialog
          open
          onClose={() => setEdited(null)}
          title="수정된 파일"
          width="max-w-md"
          footer={
            <>
              <Button variant="ghost" onClick={() => setEdited(null)}>
                나중에
              </Button>
              <Button
                onClick={() => {
                  const e = edited
                  setEdited(null)
                  void invoke('transfer:upload', { paths: [e.path], folderId: e.folderId, fileId: e.fileId, note: '바로 열기에서 수정' })
                }}
              >
                새 버전으로 올리기
              </Button>
            </>
          }
        >
          <p className="text-sm">
            <b>{edited.name}</b> 파일이 수정되어 저장되었습니다. 자료실에 새 버전으로 올릴까요?
          </p>
        </Dialog>
      )}
    </div>
  )
}
