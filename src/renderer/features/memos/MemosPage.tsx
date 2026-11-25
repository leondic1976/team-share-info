import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  AlarmClock,
  CalendarPlus,
  Camera,
  ClipboardList,
  Copy,
  Lock,
  NotebookPen,
  Pin,
  Plus,
  Search,
  StickyNote,
  Trash2,
  Zap,
  Quote
} from 'lucide-react'
import { MEMO_COLORS, type MemoDto, type SnippetDto } from '@shared/schemas/tools'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Label, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Editor } from '@renderer/components/Editor'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState, EmptyNote } from '@renderer/components/EmptyState'
import { invoke } from '@renderer/lib/bridge'
import { startOfDay, DAY, ymd } from '@renderer/lib/dates'
import { cn } from '@renderer/lib/utils'
import { ColorPicker } from './ColorPicker'
import { memoTitle, useClipboard, useMemos, useSnippets } from './tools-api'

/** Personal memo list + editor (6.12 ①). Stored only on this PC. */
function MemoTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [tag, setTag] = useState('')
  const memos = useMemos(q)
  const [selId, setSelId] = useState<string | null>(null)
  const list = (memos.data ?? []).filter((m) => !tag || m.tags.includes(tag))
  const allTags = useMemo(() => [...new Set((memos.data ?? []).flatMap((m) => m.tags))].sort(), [memos.data])
  const sel = (memos.data ?? []).find((m) => m.id === selId) ?? null

  const create = async (): Promise<void> => {
    const id = await invoke('local:memos.save', { body: '', color: 'yellow', tags: tag ? [tag] : [] })
    setSelId(id)
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex w-80 shrink-0 flex-col border-r border-border">
        <div className="space-y-2 border-b border-border p-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-8" aria-label="메모 검색" placeholder="메모 검색" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Button size="icon" aria-label="새 메모" title="새 메모" onClick={() => void create()}>
              <Plus />
            </Button>
          </div>
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {['', ...allTags].map((t) => (
                <button key={t || 'all'} className={cn('cursor-pointer rounded-full border border-border px-2 py-0.5 text-xs', tag === t && 'border-primary bg-primary/10 text-primary')} onClick={() => setTag(t)}>
                  {t ? `#${t}` : '전체'}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="memo-list">
          {!list.length && <EmptyNote>메모가 없습니다.</EmptyNote>}
          {list.map((m) => (
            <button
              key={m.id}
              onClick={() => setSelId(m.id)}
              className={cn('block w-full cursor-pointer rounded-md border border-black/5 p-2.5 text-left text-sm text-slate-900 shadow-sm', selId === m.id && 'ring-2 ring-primary')}
              style={{ background: MEMO_COLORS[m.color] }}
              data-testid="memo-item"
            >
              <div className="flex items-center gap-1">
                {m.pinned && <Pin className="size-3" aria-label="고정" />}
                {m.sticky && <StickyNote className="size-3" aria-label="바탕화면에 붙임" />}
                <span className="truncate font-semibold">{memoTitle(m.body) || '(빈 메모)'}</span>
              </div>
              <div className="mt-1 flex items-center gap-1 text-xs text-slate-600">
                {m.tags.map((t) => (
                  <span key={t}>#{t}</span>
                ))}
                <span className="ml-auto">{format(m.updatedAt, 'M/d HH:mm')}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
      <div className="min-w-0 flex-1 overflow-y-auto p-5">
        {sel ? (
          <MemoEditor key={sel.id} memo={sel} notify={notify} onDeleted={() => setSelId(null)} onAlarm={(title) => navigate('/alarms', { state: { newAlarm: { title } } })} />
        ) : (
          <EmptyState icon={StickyNote} title="메모를 고르거나 새로 만드세요" description="메모는 이 PC에만 저장됩니다. Ctrl+Alt+M을 누르면 어느 화면에서든 빠른 메모 창이 열립니다." />
        )}
      </div>
    </div>
  )
}

function MemoEditor({ memo, notify, onDeleted, onAlarm }: { memo: MemoDto; notify: (s: string) => void; onDeleted: () => void; onAlarm: (title: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const [body, setBody] = useState(memo.body)
  const [color, setColor] = useState(memo.color)
  const [pinned, setPinned] = useState(memo.pinned)
  const [tags, setTags] = useState(memo.tags.join(', '))
  const [saved, setSaved] = useState('')
  const timer = useRef<number | null>(null)
  const first = useRef(true)

  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (timer.current) window.clearTimeout(timer.current)
    setSaved('저장 중…')
    timer.current = window.setTimeout(() => {
      const t = tags.split(',').map((s) => s.trim().replace(/^#/, '')).filter(Boolean).slice(0, 10)
      void invoke('local:memos.save', { id: memo.id, body, color, pinned, tags: t }).then(() => {
        setSaved('저장됨')
        void qc.invalidateQueries({ queryKey: ['local', 'memos'] })
      })
    }, 500)
    return () => {
      if (timer.current) window.clearTimeout(timer.current)
    }
  }, [body, color, pinned, tags, memo.id, qc])

  const title = memoTitle(body) || '메모'
  const toEvent = async (): Promise<void> => {
    const s = startOfDay(Date.now())
    await invoke('local:events.save', { title, bodyHtml: body, startAt: s, endAt: s + DAY, allDay: true })
    notify('오늘 날짜에 개인 일정으로 추가했습니다.')
  }
  const toDiary = async (): Promise<void> => {
    const date = ymd()
    const cur = await invoke('local:diary.get', { date })
    await invoke('local:diary.save', { date, bodyHtml: `${cur?.bodyHtml ?? ''}${body}`, tags: cur?.tags ?? [] })
    notify('오늘 다이어리에 옮겼습니다.')
  }
  const del = async (): Promise<void> => {
    if (!confirmDialog('이 메모를 지울까요?')) return
    await invoke('local:memos.delete', { id: memo.id })
    onDeleted()
  }

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ColorPicker value={color} onChange={setColor} />
        <Button size="sm" variant={pinned ? 'default' : 'outline'} onClick={() => setPinned(!pinned)}>
          <Pin /> {pinned ? '고정됨' : '고정'}
        </Button>
        <Button size="sm" variant={memo.sticky ? 'default' : 'outline'} onClick={() => void invoke('memo:sticky', { id: memo.id, on: !memo.sticky })}>
          <StickyNote /> {memo.sticky ? '바탕화면에서 떼기' : '바탕화면에 붙이기'}
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">{saved}</span>
        <Button size="icon-sm" variant="ghost" aria-label="메모 삭제" onClick={() => void del()}>
          <Trash2 />
        </Button>
      </div>
      <Editor value={body} onChange={setBody} minHeight={280} ariaLabel="메모 내용" placeholder="메모를 입력하세요. 체크리스트·표·이미지 붙여넣기를 쓸 수 있습니다." />
      <div className="flex items-center gap-2">
        <Label htmlFor="memo-tags" className="shrink-0">
          태그
        </Label>
        <Input id="memo-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="쉼표로 구분 (예: 전화, 회의)" />
      </div>
      <div className="flex flex-wrap gap-2 border-t border-border pt-3">
        <span className="self-center text-xs text-muted-foreground">이 메모를</span>
        <Button size="sm" variant="outline" onClick={() => void toEvent()}>
          <CalendarPlus /> 일정으로
        </Button>
        <Button size="sm" variant="outline" onClick={() => onAlarm(title)}>
          <AlarmClock /> 알람으로
        </Button>
        <Button size="sm" variant="outline" onClick={() => void toDiary()}>
          <NotebookPen /> 다이어리로
        </Button>
      </div>
    </div>
  )
}

/** Snippets (6.12 ③): frequently used phrases, copied with one click. */
function SnippetTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const snippets = useSnippets()
  const [edit, setEdit] = useState<Partial<SnippetDto> | null>(null)
  const groups = [...new Set((snippets.data ?? []).map((s) => s.groupName))]
  const refresh = (): void => void qc.invalidateQueries({ queryKey: ['local', 'snippets'] })
  const copy = async (s: SnippetDto): Promise<void> => {
    await invoke('clipboard:write', { text: s.body })
    await invoke('local:snippets.use', { id: s.id })
    notify(`"${s.title}"을(를) 복사했습니다. 붙여넣을 곳에서 Ctrl+V를 누르세요.`)
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <div className="mb-3 flex items-center">
        <p className="text-sm text-muted-foreground">자주 쓰는 문구를 저장해 두고 누르면 복사됩니다.</p>
        <Button className="ml-auto" size="sm" onClick={() => setEdit({ title: '', body: '', groupName: '' })}>
          <Plus /> 상용구 추가
        </Button>
      </div>
      {!snippets.data?.length && <EmptyState icon={Quote} title="상용구가 없습니다" description="인사말·안내 문구·결재 문안·주소처럼 자주 쓰는 문구를 추가하세요." />}
      {groups.map((g) => (
        <div key={g || '_'} className="mb-4">
          {g && <h3 className="mb-1.5 text-sm font-semibold">{g}</h3>}
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {(snippets.data ?? [])
              .filter((s) => s.groupName === g)
              .map((s) => (
                <Card key={s.id} data-testid="snippet">
                  <CardContent className="space-y-1.5 p-3">
                    <div className="flex items-center gap-1">
                      <span className="truncate font-semibold">{s.title}</span>
                      <Button size="sm" className="ml-auto" onClick={() => void copy(s)}>
                        <Copy /> 복사
                      </Button>
                    </div>
                    <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{s.body}</p>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEdit(s)}>
                        고치기
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          if (confirmDialog('이 상용구를 지울까요?')) void invoke('local:snippets.delete', { id: s.id }).then(refresh)
                        }}
                      >
                        지우기
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
        </div>
      ))}
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? '상용구 고치기' : '상용구 추가'}
        footer={
          <Button
            disabled={!edit?.title?.trim() || !edit?.body?.trim()}
            onClick={() => {
              if (!edit) return
              void invoke('local:snippets.save', { id: edit.id, title: edit.title ?? '', body: edit.body ?? '', groupName: edit.groupName ?? '' }).then(() => {
                refresh()
                setEdit(null)
              })
            }}
          >
            저장
          </Button>
        }
      >
        <div className="space-y-2">
          <Label htmlFor="sn-title">이름</Label>
          <Input id="sn-title" maxLength={60} value={edit?.title ?? ''} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
          <Label htmlFor="sn-group">분류 (선택)</Label>
          <Input id="sn-group" maxLength={30} list="sn-groups" value={edit?.groupName ?? ''} onChange={(e) => setEdit({ ...edit, groupName: e.target.value })} />
          <datalist id="sn-groups">
            {groups.filter(Boolean).map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
          <Label htmlFor="sn-body">문구</Label>
          <Textarea id="sn-body" rows={6} value={edit?.body ?? ''} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
        </div>
      </Dialog>
    </div>
  )
}

/** Clipboard history (6.12 ③): off by default; kept only on this PC. */
function ClipboardTab({ notify }: { notify: (s: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const items = useClipboard()
  const settings = useQuery({ queryKey: ['local', 'clipboard-settings'], queryFn: () => invoke('clipboard:getSettings'), networkMode: 'always' })
  const s = settings.data ?? { enabled: false, clearOnExit: false }
  const set = async (patch: Partial<typeof s>): Promise<void> => {
    await invoke('clipboard:setSettings', { ...s, ...patch })
    void qc.invalidateQueries({ queryKey: ['local', 'clipboard-settings'] })
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-5">
      <Card className="mb-4">
        <CardContent className="flex flex-wrap items-center gap-4 p-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={s.enabled} onCheckedChange={(v) => void set({ enabled: v })} label="클립보드 기록 사용" />
            클립보드 기록 사용
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={s.clearOnExit} onCheckedChange={(v) => void set({ clearOnExit: v })} label="프로그램 종료 시 기록 삭제" />
            프로그램 종료 시 기록 삭제
          </label>
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            onClick={() => {
              if (confirmDialog('클립보드 기록을 모두 지울까요?')) void invoke('local:clipboard.delete', { id: null })
            }}
          >
            <Trash2 /> 모두 지우기
          </Button>
        </CardContent>
      </Card>
      <p className="mb-3 text-xs text-muted-foreground">
        <Lock className="mr-1 inline size-3" />
        최근 복사한 글·이미지 100개를 이 PC에만 보관합니다. 비밀번호 등을 복사할 때는 기록을 꺼 두세요.
      </p>
      {!items.data?.length ? (
        <EmptyState icon={ClipboardList} title={s.enabled ? '아직 기록이 없습니다' : '클립보드 기록이 꺼져 있습니다'} />
      ) : (
        <div className="space-y-1.5" data-testid="clipboard-list">
          {items.data.map((c) => (
            <div key={c.id} className="flex items-center gap-2 rounded-md border border-border p-2 text-sm">
              {c.kind === 'image' ? <img src={c.body} alt="복사한 이미지" className="max-h-20 rounded" /> : <span className="line-clamp-2 flex-1 whitespace-pre-wrap break-all">{c.body}</span>}
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{format(c.at, 'M/d HH:mm')}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void invoke('clipboard:write', c.kind === 'image' ? { dataUrl: c.body } : { text: c.body }).then(() => notify('복사했습니다. 붙여넣을 곳에서 Ctrl+V를 누르세요.'))}
              >
                <Copy /> 복사
              </Button>
              <Button size="icon-sm" variant="ghost" aria-label="기록 삭제" onClick={() => void invoke('local:clipboard.delete', { id: c.id })}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

type Tab = 'memo' | 'snippet' | 'clipboard'

export function MemosPage(): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('memo')
  const [msg, setMsg] = useState('')
  const timer = useRef<number | null>(null)
  const notify = (s: string): void => {
    setMsg(s)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(''), 3500)
  }
  const tabs: { key: Tab; label: string; icon: typeof StickyNote }[] = [
    { key: 'memo', label: '내 메모', icon: Lock },
    { key: 'snippet', label: '상용구', icon: Quote },
    { key: 'clipboard', label: '클립보드 기록', icon: ClipboardList }
  ]
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="메모"
        description="내 메모·상용구·클립보드 기록은 이 PC에만 저장됩니다. 팀원에게 남기는 공유 메모는 메신저에 있습니다."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void invoke('memo:quick')} title="Ctrl+Alt+M">
              <Zap /> 빠른 메모
            </Button>
            <Button size="sm" variant="outline" onClick={() => void invoke('capture:start')}>
              <Camera /> 화면 캡처
            </Button>
          </>
        }
      />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2" role="tablist">
        {tabs.map((t) => (
          <Button key={t.key} role="tab" aria-selected={tab === t.key} size="sm" variant={tab === t.key ? 'default' : 'ghost'} onClick={() => setTab(t.key)}>
            <t.icon /> {t.label}
          </Button>
        ))}
        {msg && (
          <span className="ml-auto self-center text-sm text-primary" role="status">
            {msg}
          </span>
        )}
      </div>
      {tab === 'memo' && <MemoTab notify={notify} />}
      {tab === 'snippet' && <SnippetTab notify={notify} />}
      {tab === 'clipboard' && <ClipboardTab notify={notify} />}
    </div>
  )
}

