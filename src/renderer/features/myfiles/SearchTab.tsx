import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { FolderInput, FolderOpen, FolderPlus, Loader2, RefreshCw, Save, Search, Tag, Trash2, X } from 'lucide-react'
import { CATEGORY_LABEL, type FileCategory, type SearchHit } from '@shared/fm'
import type { SmartQuery } from '@shared/organize'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { invoke, onMain } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { FileIcon, TagChips, fmtSize, useFileActions, useTags } from './common'

const SIZES = [
  { v: '', label: '크기 전체' },
  { v: '1048576', label: '1MB 이상' },
  { v: '10485760', label: '10MB 이상' },
  { v: '104857600', label: '100MB 이상' },
  { v: '1073741824', label: '1GB 이상' }
]
const DATES = [
  { v: '', label: '날짜 전체' },
  { v: '1', label: '오늘' },
  { v: '7', label: '최근 7일' },
  { v: '30', label: '최근 30일' },
  { v: '365', label: '최근 1년' },
  { v: '-180', label: '6개월 넘은 것' }
]

export function HitList({ hits, notify, selectable = true }: { hits: SearchHit[]; notify: (s: string) => void; selectable?: boolean }): React.JSX.Element {
  const act = useFileActions(notify)
  const tags = useTags()
  const colors = useMemo(() => Object.fromEntries((tags.data ?? []).map((t) => [t.name, t.color])), [tags.data])
  const tagMap = useQuery({ queryKey: ['local', 'hit-tags', hits.map((h) => h.path).join('|').slice(0, 2000), hits.length], queryFn: () => invoke('org:tagsOf', { paths: hits.map((h) => h.path) }), enabled: hits.length > 0, networkMode: 'always' })
  const [sel, setSel] = useState<Set<string>>(new Set())
  useEffect(() => setSel(new Set()), [hits])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {selectable && sel.size > 0 && (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-1">
          <span className="text-xs text-muted-foreground">{sel.size}개 선택</span>
          <Button size="sm" variant="ghost" onClick={() => act.tag([...sel])}>
            <Tag /> 태그
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act.collect([...sel])}>
            <FolderInput /> 가상 폴더에
          </Button>
          <Button size="sm" variant="ghost" onClick={() => act.copyPath([...sel])}>
            경로 복사
          </Button>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="search-hits">
        {hits.map((h) => (
          <div
            key={h.path}
            className={cn('group flex items-center gap-2 border-b border-border/50 px-3 py-1 text-sm hover:bg-muted', sel.has(h.path) && 'bg-primary/10')}
            onClick={(e) => {
              if (!selectable) return
              const n = new Set(e.ctrlKey ? sel : [])
              if (sel.has(h.path) && e.ctrlKey) n.delete(h.path)
              else n.add(h.path)
              setSel(n)
            }}
            onDoubleClick={() => void act.open(h.path)}
            data-testid="search-hit"
          >
            <FileIcon name={h.name} dir={h.isDir} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className="truncate font-medium">{h.name}</span>
                <TagChips tags={tagMap.data?.[h.path] ?? []} colors={colors} />
              </span>
              <span className="block truncate text-xs text-muted-foreground">{h.dir}</span>
            </span>
            <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{h.isDir ? '' : fmtSize(h.size)}</span>
            <span className="w-32 shrink-0 text-right text-xs text-muted-foreground">{format(h.mtime, 'yyyy-MM-dd HH:mm')}</span>
            <Button size="icon-sm" variant="ghost" className="invisible group-hover:visible" aria-label="폴더 열기" title="폴더 열기" onClick={(e) => (e.stopPropagation(), act.reveal(h.path))}>
              <FolderOpen />
            </Button>
          </div>
        ))}
      </div>
      {act.dialogs}
    </div>
  )
}

/** Everything-style instant file name search (6.18 ②). */
export function SearchTab({ notify, under, clearUnder }: { notify: (s: string) => void; under: string | null; clearUnder: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [q, setQ] = useState('')
  const [cat, setCat] = useState<FileCategory | ''>('')
  const [size, setSize] = useState('')
  const [days, setDays] = useState('')
  const [roots, setRoots] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const rootsQ = useQuery({ queryKey: ['local', 'fsx-roots'], queryFn: () => invoke('fsx:roots'), networkMode: 'always', refetchInterval: (d) => (d.state.data?.some((r) => r.scanning) ? 1500 : false) })
  useEffect(() => onMain('fsindex:changed', () => void qc.invalidateQueries({ queryKey: ['local', 'fsx'] }).then(() => qc.invalidateQueries({ queryKey: ['local', 'fsx-roots'] }))), [qc])
  const query = (): SmartQuery => ({
    q,
    category: cat || undefined,
    minSize: size ? Number(size) : undefined,
    modifiedWithinDays: days && Number(days) > 0 ? Number(days) : undefined,
    olderThanDays: days && Number(days) < 0 ? -Number(days) : undefined,
    under: under ?? undefined
  })
  const sq = query()
  const active = !!(q.trim() || cat || size || days || under)
  const hits = useQuery({
    queryKey: ['local', 'fsx', JSON.stringify(sq)],
    queryFn: () =>
      invoke('fsx:search', {
        q: sq.q,
        category: sq.category,
        minSize: sq.minSize,
        under: sq.under,
        modifiedAfter: sq.modifiedWithinDays ? Date.now() - sq.modifiedWithinDays * 86400000 : undefined,
        modifiedBefore: sq.olderThanDays ? Date.now() - sq.olderThanDays * 86400000 : undefined,
        limit: 500
      }),
    enabled: active,
    networkMode: 'always',
    placeholderData: (p) => p
  })
  const total = (rootsQ.data ?? []).reduce((s, r) => s + r.fileCount, 0)
  const scanning = rootsQ.data?.some((r) => r.scanning)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 space-y-2 border-b border-border p-3">
        <div className="relative">
          <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
          <Input autoFocus aria-label="파일 이름 검색" className="h-10 pl-9 text-base" placeholder="파일·폴더 이름 일부 (띄어 쓰면 모두 포함, *.hwp 처럼 별표 사용)" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select aria-label="종류" className="w-32" value={cat} onChange={(e) => setCat(e.target.value as FileCategory | '')}>
            <option value="">종류 전체</option>
            {(Object.keys(CATEGORY_LABEL) as FileCategory[]).map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </Select>
          <Select aria-label="크기" className="w-32" value={size} onChange={(e) => setSize(e.target.value)}>
            {SIZES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </Select>
          <Select aria-label="수정일" className="w-36" value={days} onChange={(e) => setDays(e.target.value)}>
            {DATES.map((s) => (
              <option key={s.v} value={s.v}>
                {s.label}
              </option>
            ))}
          </Select>
          {under && (
            <span className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              폴더: {under}
              <button className="cursor-pointer" aria-label="폴더 조건 빼기" onClick={clearUnder}>
                <X className="size-3" />
              </button>
            </span>
          )}
          <Button size="sm" variant="ghost" disabled={!active} onClick={() => setSaveOpen(true)}>
            <Save /> 스마트 폴더로 저장
          </Button>
          <button className="ml-auto flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground" onClick={() => setRoots(true)} data-testid="index-status">
            {scanning && <Loader2 className="size-3.5 animate-spin" />}
            {scanning ? '색인 중…' : '색인'} {total.toLocaleString()}개 · 색인 폴더 {rootsQ.data?.length ?? 0}곳
          </button>
        </div>
      </div>
      {!active ? (
        <div className="p-6 text-sm text-muted-foreground">
          <p>이름을 입력하는 즉시 이 PC의 색인 폴더에서 찾습니다. 단축키 Ctrl+Alt+F로 어디서든 이 화면을 엽니다.</p>
          <p className="mt-1">더블클릭: 열기 · 폴더 단추: 들어 있는 폴더 열기 · Ctrl+클릭: 여러 개 선택 후 태그·가상 폴더에 넣기</p>
        </div>
      ) : (
        <>
          <p className="shrink-0 px-3 py-1 text-xs text-muted-foreground">{hits.data?.length === 500 ? '500개 이상 (조건을 더 좁히세요)' : `${hits.data?.length ?? 0}개`}</p>
          <HitList hits={hits.data ?? []} notify={notify} />
        </>
      )}
      <Dialog open={roots} onClose={() => setRoots(false)} title="색인할 폴더" width="max-w-2xl">
        <div className="space-y-2">
          {(rootsQ.data ?? []).map((r) => (
            <div key={r.path} className="flex items-center gap-2 rounded border border-border px-3 py-2 text-sm" data-testid="index-root">
              <FileIcon name="" dir />
              <span className="min-w-0 flex-1 truncate">{r.path}</span>
              <span className="shrink-0 text-xs text-muted-foreground">
                {r.scanning ? '색인 중… ' : ''}
                {r.fileCount.toLocaleString()}개{r.lastScanAt && !r.scanning ? ` · ${format(r.lastScanAt, 'M/d HH:mm')}` : ''}
              </span>
              <Button size="icon-sm" variant="ghost" aria-label="다시 색인" onClick={() => void invoke('fsx:rescan', { path: r.path }).then(() => rootsQ.refetch())}>
                <RefreshCw />
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="색인에서 빼기" onClick={() => confirmDialog('이 폴더를 색인에서 뺄까요? (파일은 지우지 않습니다)') && void invoke('fsx:removeRoot', { path: r.path }).then(() => rootsQ.refetch())}>
                <Trash2 />
              </Button>
            </div>
          ))}
          <Button
            variant="outline"
            onClick={async () => {
              const p = await invoke('server:pickFolder', { title: '색인할 폴더 또는 드라이브 고르기' })
              if (p) {
                await invoke('fsx:addRoot', { path: p })
                void rootsQ.refetch()
              }
            }}
          >
            <FolderPlus /> 폴더·드라이브 추가
          </Button>
          <p className="text-xs text-muted-foreground">파일 내용이 아니라 이름만 색인합니다. Windows·Program Files·AppData 등 시스템 폴더는 건너뜁니다. 폴더가 바뀌면 자동으로 반영되고 6시간마다 다시 검사합니다.</p>
        </div>
      </Dialog>
      <Dialog
        open={saveOpen}
        onClose={() => setSaveOpen(false)}
        title="스마트 폴더로 저장"
        footer={
          <Button
            disabled={!saveName.trim()}
            onClick={() =>
              void invoke('org:saveSmart', { name: saveName.trim(), query: query() }).then(() => {
                setSaveOpen(false)
                setSaveName('')
                notify('스마트 폴더를 저장했습니다. 태그·가상 폴더 탭에서 봅니다.')
                void qc.invalidateQueries({ queryKey: ['local', 'smart'] })
              })
            }
          >
            저장
          </Button>
        }
      >
        <Input aria-label="스마트 폴더 이름" placeholder="예: 이번 주 한글 문서" value={saveName} onChange={(e) => setSaveName(e.target.value)} />
      </Dialog>
    </div>
  )
}
