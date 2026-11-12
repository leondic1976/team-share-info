import { useRef, useState } from 'react'
import { Paperclip, X, Loader2, Download } from 'lucide-react'
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
  const [err, setErr] = useState('')
  if (!items.length) return null
  return (
    <div className="space-y-1">
      {items.map((a) => (
        <button
          key={a.id}
          className="flex w-full cursor-pointer items-center gap-2 rounded border border-border px-2.5 py-1.5 text-left text-sm hover:bg-muted"
          onClick={() => downloadAuthed(`/api/attachments/${a.id}`, a.name).catch((e) => setErr(errorMessage(e)))}
        >
          <Download className="size-4 text-primary" /> {a.name}
          <span className="ml-auto text-xs text-muted-foreground">{formatSize(a.size)}</span>
        </button>
      ))}
      {err && <p className="text-xs text-urgent">{err}</p>}
    </div>
  )
}
