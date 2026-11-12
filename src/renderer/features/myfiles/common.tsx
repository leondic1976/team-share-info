import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { File, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Folder, Music, Presentation, Settings2 } from 'lucide-react'
import { categoryOf, type FileCategory } from '@shared/fm'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'

const ICONS: Record<FileCategory, typeof File> = {
  folder: Folder,
  doc: FileText,
  sheet: FileSpreadsheet,
  slide: Presentation,
  pdf: FileText,
  image: FileImage,
  video: FileVideo,
  audio: Music,
  archive: FileArchive,
  exe: Settings2,
  text: FileText,
  other: File
}
const COLORS: Partial<Record<FileCategory, string>> = { folder: 'text-amber-500', doc: 'text-sky-600', sheet: 'text-green-600', slide: 'text-orange-500', pdf: 'text-red-600', image: 'text-purple-500' }

export function FileIcon({ name, dir, className }: { name: string; dir: boolean; className?: string }): React.JSX.Element {
  const c = categoryOf(name, dir)
  const I = ICONS[c]
  return <I className={cn('size-4 shrink-0', COLORS[c] ?? 'text-muted-foreground', className)} aria-hidden />
}

export const fmtSize = (n: number): string => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

export const useTags = () => useQuery({ queryKey: ['local', 'tags'], queryFn: () => invoke('org:tags'), networkMode: 'always' })
export const useCollections = () => useQuery({ queryKey: ['local', 'collections'], queryFn: () => invoke('org:collections'), networkMode: 'always' })

export function TagChips({ tags, colors }: { tags: string[]; colors: Record<string, string> }): React.JSX.Element | null {
  if (!tags.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t} className="rounded-full px-1.5 text-[10px] text-white" style={{ background: colors[t] ?? '#64748b' }}>
          {t}
        </span>
      ))}
    </span>
  )
}

/** Set the tags of one item, or add one tag to many. */
export function TagDialog({ paths, onClose }: { paths: string[]; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const tags = useTags()
  const [sel, setSel] = useState<string[]>([])
  const [text, setText] = useState('')
  const single = paths.length === 1
  useEffect(() => {
    if (!paths.length) return
    setText('')
    if (single) void invoke('org:tagsOf', { paths }).then((r) => setSel(r[paths[0]] ?? []))
    else setSel([])
  }, [paths, single])
  const save = async (): Promise<void> => {
    const all = [...new Set([...sel, ...text.split(',').map((t) => t.trim()).filter(Boolean)])]
    if (single) await invoke('org:setTags', { path: paths[0], tags: all })
    else for (const t of all) await invoke('org:addTag', { paths, tag: t })
    void qc.invalidateQueries({ queryKey: ['local'] })
    onClose()
  }
  return (
    <Dialog
      open={paths.length > 0}
      onClose={onClose}
      title={single ? '태그' : `${paths.length}개 항목에 태그 추가`}
      footer={<Button onClick={() => void save()}>저장</Button>}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(tags.data ?? []).map((t) => (
            <button
              key={t.name}
              className={cn('cursor-pointer rounded-full border px-2 py-0.5 text-xs', sel.includes(t.name) ? 'border-transparent text-white' : 'border-border')}
              style={sel.includes(t.name) ? { background: t.color } : undefined}
              aria-pressed={sel.includes(t.name)}
              onClick={() => setSel(sel.includes(t.name) ? sel.filter((x) => x !== t.name) : [...sel, t.name])}
            >
              {t.name}
            </button>
          ))}
        </div>
        <Input aria-label="새 태그" placeholder="새 태그 (쉼표로 여러 개)" value={text} onChange={(e) => setText(e.target.value)} />
        <p className="text-xs text-muted-foreground">파일은 옮기지 않고, 이 PC에 태그 정보만 저장합니다.</p>
      </div>
    </Dialog>
  )
}

/** Put items into a collection (virtual folder). */
export function CollectionPickDialog({ paths, onClose }: { paths: string[]; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const cols = useCollections()
  const [name, setName] = useState('')
  const [msg, setMsg] = useState('')
  useEffect(() => setMsg(''), [paths])
  const add = async (id: string): Promise<void> => {
    const n = await invoke('org:addToCollection', { id, paths })
    void qc.invalidateQueries({ queryKey: ['local', 'collections'] })
    setMsg(`${n}개를 넣었습니다.`)
  }
  const label = (id: string | null): string => {
    const parts: string[] = []
    let cur = cols.data?.find((c) => c.id === id)
    for (let i = 0; cur && i < 20; i++) {
      parts.unshift(cur.name)
      cur = cols.data?.find((c) => c.id === cur!.parentId)
    }
    return parts.join(' / ')
  }
  return (
    <Dialog open={paths.length > 0} onClose={onClose} title="가상 폴더에 넣기">
      <div className="space-y-2">
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {(cols.data ?? []).map((c) => (
            <button key={c.id} className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted" onClick={() => void add(c.id)}>
              <Folder className="size-4 text-primary" /> {label(c.id)} <span className="ml-auto text-xs text-muted-foreground">{c.count}</span>
            </button>
          ))}
          {!cols.data?.length && <p className="text-sm text-muted-foreground">가상 폴더가 없습니다. 아래에서 새로 만드세요.</p>}
        </div>
        <div className="flex gap-2 border-t border-border pt-2">
          <Input aria-label="새 가상 폴더 이름" placeholder="새 가상 폴더 이름" value={name} onChange={(e) => setName(e.target.value)} />
          <Button
            disabled={!name.trim()}
            onClick={() =>
              void invoke('org:saveCollection', { name: name.trim() }).then(async (id) => {
                setName('')
                await add(id)
              })
            }
          >
            만들고 넣기
          </Button>
        </div>
        {msg && (
          <p className="text-sm text-primary" role="status">
            {msg}
          </p>
        )}
      </div>
    </Dialog>
  )
}

/** Common actions for a selection of files/folders. */
export function useFileActions(notify: (s: string) => void) {
  const [tagPaths, setTagPaths] = useState<string[]>([])
  const [colPaths, setColPaths] = useState<string[]>([])
  const open = async (path: string): Promise<void> => {
    const r = await invoke('fm:open', { path })
    if (!r.ok) notify(r.error ?? '열지 못했습니다.')
  }
  const copyPath = (paths: string[]): void => void invoke('clipboard:write', { text: paths.join('\r\n') }).then(() => notify('경로를 복사했습니다.'))
  const dialogs = (
    <>
      <TagDialog paths={tagPaths} onClose={() => setTagPaths([])} />
      <CollectionPickDialog paths={colPaths} onClose={() => setColPaths([])} />
    </>
  )
  return { open, reveal: (p: string) => void invoke('fm:reveal', { path: p }), copyPath, tag: setTagPaths, collect: setColPaths, dialogs }
}
