import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Megaphone, Paperclip, Pencil, Pin, Plus, Trash2, Upload, X } from 'lucide-react'
import type { CmdFile, CmdMaterial, CmdNotice } from '../shared/types'
import { useAct, useMaterials, useNotices } from './data'
import { useHost } from './host'
import { when } from './model'
import { Editor, RichView } from './rich'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, EmptyState, Field, Input, Textarea, cn } from './ui'

const size = (n: number): string => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`)

/** Uploads files through the host and lists them. */
export function FilePicker({ files, onChange, multiple = true }: { files: CmdFile[]; onChange: (f: CmdFile[]) => void; multiple?: boolean }): React.JSX.Element {
  const host = useHost()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const pick = async (list: FileList | null): Promise<void> => {
    if (!list?.length) return
    setBusy(true)
    setErr('')
    try {
      const up: CmdFile[] = []
      for (const f of [...list]) up.push(await host.upload(f))
      onChange(multiple ? [...files, ...up] : up.slice(0, 1))
    } catch (e) {
      setErr(host.errorMessage(e))
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {files.map((f) => (
          <span key={f.id} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-xs">
            <Paperclip className="size-3" /> {f.name} <span className="text-muted-foreground">{size(f.size)}</span>
            <button type="button" className="cursor-pointer" aria-label={`${f.name} 빼기`} onClick={() => onChange(files.filter((x) => x.id !== f.id))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>
          <Upload /> {busy ? '올리는 중…' : multiple ? '파일 첨부' : files.length ? '파일 바꾸기' : '파일 고르기'}
        </Button>
        <input ref={input} type="file" className="hidden" multiple={multiple} aria-label="첨부할 파일" onChange={(e) => void pick(e.target.files)} />
      </div>
      {err && <p className="text-xs text-urgent">{err}</p>}
    </div>
  )
}

export function FileList({ files }: { files: CmdFile[] }): React.JSX.Element | null {
  const host = useHost()
  if (!files.length) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {files.map((f) => (
        <Button key={f.id} size="sm" variant="outline" onClick={() => host.download(f.id, f.name)} title="내려받기">
          <Download /> {f.name} <span className="text-muted-foreground">{size(f.size)}</span>
        </Button>
      ))}
    </div>
  )
}

/** 공지: training schedules and guidance written by those in charge. */
export function Notices({ manager }: { manager: boolean }): React.JSX.Element {
  const host = useHost()
  const q = useNotices()
  const [openId, setOpenId] = useState<string | null>(null)
  const [edit, setEdit] = useState<Partial<CmdNotice> | null>(null)
  const act = useAct()
  const list = q.data ?? []
  const cur = list.find((n) => n.id === openId) ?? list[0] ?? null
  useEffect(() => {
    if (cur && !cur.read) void host.api.post(`/api/command/notices/${cur.id}/read`).catch(() => undefined)
  }, [cur, host])
  return (
    <div className="flex min-h-0 gap-4" data-testid="cmd-notices">
      <div className="w-80 shrink-0 space-y-2">
        {manager && (
          <Button size="sm" className="w-full" onClick={() => setEdit({ title: '', bodyHtml: '', pinned: false, attachments: [] })}>
            <Plus /> 공지 쓰기
          </Button>
        )}
        {list.map((n) => (
          <button key={n.id} type="button" onClick={() => setOpenId(n.id)} className={cn('block w-full cursor-pointer rounded-md border border-border px-3 py-2 text-left hover:bg-muted', cur?.id === n.id && 'border-primary bg-primary/5')} data-testid="cmd-notice-item">
            <span className="flex items-center gap-1.5">
              {n.pinned && <Pin className="size-3.5 text-primary" />}
              <span className={cn('truncate text-sm', !n.read ? 'font-bold' : 'font-medium')}>{n.title}</span>
              {!n.read && <span className="ml-auto size-2 shrink-0 rounded-full bg-urgent" aria-label="읽지 않음" />}
            </span>
            <span className="text-xs text-muted-foreground">
              {n.createdByName} · {when(n.createdAt)}
            </span>
          </button>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {cur ? (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{cur.title}</CardTitle>
              <span className="text-xs text-muted-foreground">
                {cur.createdByName} · {when(cur.createdAt)}
              </span>
              {manager && (
                <span className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEdit(cur)}>
                    <Pencil /> 고치기
                  </Button>
                  <Button size="sm" variant="ghost" className="text-urgent" onClick={() => window.confirm('이 공지를 지울까요?') && void act.run(() => host.api.del(`/api/command/notices/${cur.id}`))}>
                    <Trash2 /> 삭제
                  </Button>
                </span>
              )}
            </CardHeader>
            <CardContent className="space-y-3">
              <RichView html={cur.bodyHtml} />
              <FileList files={cur.attachments} />
            </CardContent>
          </Card>
        ) : (
          <EmptyState icon={Megaphone} title="공지가 없습니다" description="훈련 일정·안내는 지휘대담당이 여기에 올립니다." />
        )}
      </div>
      <NoticeDialog value={edit} onClose={() => setEdit(null)} />
    </div>
  )
}

function NoticeDialog({ value, onClose }: { value: Partial<CmdNotice> | null; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [f, setF] = useState<{ title: string; bodyHtml: string; pinned: boolean; files: CmdFile[] }>({ title: '', bodyHtml: '', pinned: false, files: [] })
  useEffect(() => {
    if (value) setF({ title: value.title ?? '', bodyHtml: value.bodyHtml ?? '', pinned: !!value.pinned, files: value.attachments ?? [] })
  }, [value])
  const save = (): void =>
    void act.run(
      () => {
        const body = { title: f.title, bodyHtml: f.bodyHtml, pinned: f.pinned, attachmentIds: f.files.map((x) => x.id) }
        return value?.id ? host.api.patch(`/api/command/notices/${value.id}`, body) : host.api.post('/api/command/notices', body)
      },
      () => onClose()
    )
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={value?.id ? '공지 고치기' : '공지 쓰기'}
      width="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!f.title.trim() || act.busy} onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="제목">
          <Input value={f.title} maxLength={150} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="공지 제목" />
        </Field>
        <Editor value={f.bodyHtml} onChange={(h) => setF((p) => ({ ...p, bodyHtml: h }))} ariaLabel="공지 본문" />
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> 맨 위에 고정
        </label>
        <FilePicker files={f.files} onChange={(files) => setF({ ...f, files })} />
        {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      </div>
    </Dialog>
  )
}

/** 자료: operating material (files), grouped by category. */
export function Materials({ manager }: { manager: boolean }): React.JSX.Element {
  const host = useHost()
  const q = useMaterials()
  const act = useAct()
  const [edit, setEdit] = useState<Partial<CmdMaterial> | null>(null)
  const list = q.data ?? []
  const cats = [...new Set(list.map((x) => x.category))]
  return (
    <div className="space-y-4" data-testid="cmd-materials">
      {manager && (
        <Button size="sm" onClick={() => setEdit({ category: '', title: '', description: '', file: null })}>
          <Plus /> 자료 올리기
        </Button>
      )}
      {!list.length && <EmptyState icon={FileText} title="자료가 없습니다" description="운용에 필요한 매뉴얼·서식·도면 등을 지휘대담당이 올립니다." />}
      {cats.map((c) => (
        <Card key={c || '_'}>
          <CardHeader>
            <CardTitle>{c || '분류 없음'}</CardTitle>
            <Badge>{list.filter((x) => x.category === c).length}건</Badge>
          </CardHeader>
          <div className="divide-y divide-border">
            {list
              .filter((x) => x.category === c)
              .map((x) => (
                <div key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" data-testid="cmd-material">
                  <FileText className="size-4 text-muted-foreground" />
                  <b>{x.title}</b>
                  {x.description && <span className="text-muted-foreground">{x.description}</span>}
                  <span className="ml-auto flex items-center gap-1">
                    {x.file && (
                      <Button size="sm" variant="outline" onClick={() => host.download(x.file!.id, x.file!.name)}>
                        <Download /> {x.file.name}
                      </Button>
                    )}
                    {manager && (
                      <>
                        <Button size="icon-sm" variant="ghost" aria-label="고치기" onClick={() => setEdit(x)}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="삭제" onClick={() => window.confirm('이 자료를 지울까요?') && void act.run(() => host.api.del(`/api/command/materials/${x.id}`))}>
                          <Trash2 />
                        </Button>
                      </>
                    )}
                  </span>
                </div>
              ))}
          </div>
        </Card>
      ))}
      <MaterialDialog value={edit} cats={cats.filter(Boolean)} onClose={() => setEdit(null)} />
    </div>
  )
}

function MaterialDialog({ value, cats, onClose }: { value: Partial<CmdMaterial> | null; cats: string[]; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [f, setF] = useState({ category: '', title: '', description: '', files: [] as CmdFile[] })
  useEffect(() => {
    if (value) setF({ category: value.category ?? '', title: value.title ?? '', description: value.description ?? '', files: value.file ? [value.file] : [] })
  }, [value])
  const save = (): void =>
    void act.run(
      () => {
        const body = { category: f.category, title: f.title, description: f.description, attachmentId: f.files[0]?.id ?? null }
        return value?.id ? host.api.patch(`/api/command/materials/${value.id}`, body) : host.api.post('/api/command/materials', body)
      },
      () => onClose()
    )
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={value?.id ? '자료 고치기' : '자료 올리기'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!f.title.trim() || act.busy} onClick={save}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="분류 (선택)" hint="예: 매뉴얼, 서식, 도면">
          <Input value={f.category} list="cmd-cats" maxLength={40} onChange={(e) => setF({ ...f, category: e.target.value })} aria-label="자료 분류" />
          <datalist id="cmd-cats">
            {cats.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </Field>
        <Field label="제목">
          <Input value={f.title} maxLength={150} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="자료 제목" />
        </Field>
        <Field label="설명 (선택)">
          <Textarea rows={3} value={f.description} maxLength={1000} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <FilePicker files={f.files} multiple={false} onChange={(files) => setF({ ...f, files })} />
        {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      </div>
    </Dialog>
  )
}
