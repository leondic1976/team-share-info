import { useRef, useState } from 'react'
import { Paperclip, X, Loader2, Download, ExternalLink, FileText } from 'lucide-react'
import type { AttachSaveResult } from '@shared/ipc'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { authHeaders, buildUrl, ApiError, errorMessage } from '@renderer/lib/api'
import { Button } from './ui/button'

export interface Att {
  id: string
  name: string
  size: number
}

export function formatSize(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`
  return `${(n / 1024 ** 3).toFixed(2)}GB`
}

/** Upload one file to /api/attachments (raw body) with progress. */
export function uploadAttachment(file: File, onProgress?: (p: number) => void): Promise<Att> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', buildUrl('/api/attachments', { name: file.name, size: file.size }))
    for (const [k, v] of Object.entries(authHeaders())) xhr.setRequestHeader(k, v)
    xhr.setRequestHeader('Content-Type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100))
    xhr.onload = () => {
      try {
        const j = JSON.parse(xhr.responseText)
        if (xhr.status < 300) resolve(j.data)
        else reject(new ApiError(j.error?.code ?? 'HTTP', j.error?.message ?? '업로드 실패', xhr.status))
      } catch {
        reject(new Error('업로드 실패'))
      }
    }
    xhr.onerror = () => reject(new Error('서버에 연결할 수 없습니다.'))
    xhr.send(file)
  })
}

/** Download an authenticated file and save it via the browser download flow. */
export async function downloadAuthed(path: string, name: string): Promise<void> {
  const res = await fetch(buildUrl(path), { headers: authHeaders() })
  if (!res.ok) throw new Error('내려받기에 실패했습니다.')
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

/**
 * One attached file: 저장 (pick where it goes) and 열기 (fetch and open at once). After
 * either, the line says where it went and offers 열기 / 폴더 열기 for the saved copy.
 */
export function FileChip({ id, name, size, className }: { id: string; name: string; size: number; className?: string }): React.JSX.Element {
  const [busy, setBusy] = useState<'' | 'save' | 'open'>('')
  const [done, setDone] = useState<AttachSaveResult | null>(null)
  const [err, setErr] = useState('')
  const run = async (open: boolean): Promise<void> => {
    if (busy) return
    setBusy(open ? 'open' : 'save')
    setErr('')
    try {
      const r = await invoke('attach:save', { id, name, open })
      if (r.canceled) return
      if (!r.ok) return setErr(r.error ?? '내려받지 못했습니다.')
      setDone(r)
      if (r.error) setErr(r.error)
    } catch (e) {
      setErr(errorMessage(e))
    } finally {
      setBusy('')
    }
  }
  const openSaved = async (): Promise<void> => {
    if (!done?.token) return
    const r = await invoke('attach:open', { token: done.token })
    setErr(r.ok ? '' : (r.error ?? '열지 못했습니다.'))
  }
  return (
    <div className={cn('rounded-lg border border-border bg-card text-left text-sm', className)} data-testid="file-chip">
      <div className="flex items-center gap-2 px-3 py-2">
        <FileText className="size-4 shrink-0 text-primary" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">{formatSize(size)}</span>
        <button className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50" disabled={!!busy} onClick={() => void run(false)} title="저장할 위치를 골라 내려받습니다">
          {busy === 'save' ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} 저장
        </button>
        <button className="flex shrink-0 cursor-pointer items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50" disabled={!!busy} onClick={() => void run(true)} title="내려받아 바로 엽니다">
          {busy === 'open' ? <Loader2 className="size-3.5 animate-spin" /> : <ExternalLink className="size-3.5" />} 열기
        </button>
      </div>
      {done?.ok && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="file-chip-done">
          <span className="min-w-0 flex-1 truncate" title={[done.dir, done.name].join('\\')}>
            {done.blocked ? '저장함(실행 파일이라 바로 열지 않음)' : done.opened ? '저장하고 열었습니다' : '저장했습니다'} · {done.dir}
          </span>
          {!done.blocked && (
            <button className="cursor-pointer font-medium text-primary hover:underline" onClick={() => void openSaved()}>
              열기
            </button>
          )}
          <button className="cursor-pointer font-medium text-primary hover:underline" onClick={() => done.token && void invoke('attach:reveal', { token: done.token })}>
            폴더 열기
          </button>
        </div>
      )}
      {err && <p className="border-t border-border px-3 py-1 text-xs text-urgent">{err}</p>}
    </div>
  )
}

export function AttachmentInput({ value, onChange }: { value: Att[]; onChange: (a: Att[]) => void }): React.JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const add = async (files: FileList | null): Promise<void> => {
    if (!files) return
    setErr('')
    const out = [...value]
    for (const f of [...files]) {
      try {
        setBusy(`${f.name} 0%`)
        out.push(await uploadAttachment(f, (p) => setBusy(`${f.name} ${p}%`)))
        onChange([...out])
      } catch (e) {
        setErr(errorMessage(e))
      }
    }
    setBusy(null)
    if (ref.current) ref.current.value = ''
  }
  return (
    <div
      className="space-y-1.5"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        void add(e.dataTransfer.files)
      }}
    >
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" onClick={() => ref.current?.click()} disabled={!!busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Paperclip />} 파일 첨부
        </Button>
        <span className="text-xs text-muted-foreground">{busy ?? '여기에 파일을 끌어다 놓아도 됩니다.'}</span>
        <input ref={ref} type="file" multiple className="hidden" aria-label="첨부 파일 선택" onChange={(e) => void add(e.target.files)} />
      </div>
      {value.map((a) => (
        <div key={a.id} className="flex items-center gap-2 rounded bg-muted px-2 py-1 text-sm">
          <Paperclip className="size-3.5" /> {a.name} <span className="text-xs text-muted-foreground">{formatSize(a.size)}</span>
          <button type="button" className="ml-auto cursor-pointer" aria-label={`${a.name} 빼기`} onClick={() => onChange(value.filter((x) => x.id !== a.id))}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
      {err && <p className="text-xs text-urgent">{err}</p>}
    </div>
  )
}

export function AttachmentList({ items }: { items: Att[] }): React.JSX.Element | null {
  if (!items.length) return null
  return (
    <div className="space-y-1">
      {items.map((a) => (
        <FileChip key={a.id} id={a.id} name={a.name} size={a.size} />
      ))}
    </div>
  )
}
