import { useEffect, useRef, useState } from 'react'
import { useEditor, EditorContent } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { ExternalLink, ListChecks, Pin, PinOff, Save, X } from 'lucide-react'
import { MEMO_COLORS, type MemoColor, type MemoDto } from '@shared/schemas/tools'
import { invoke, onMain } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'

const drag = { WebkitAppRegion: 'drag' } as React.CSSProperties
const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

function useLiteEditor(initial: string, placeholder: string, onChange: (html: string) => void) {
  return useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }), Placeholder.configure({ placeholder })],
    content: initial,
    editorProps: { attributes: { class: 'rich outline-none min-h-full', 'aria-label': '메모 내용', role: 'textbox', 'aria-multiline': 'true' } },
    onUpdate: ({ editor }) => onChange(editor.isEmpty ? '' : editor.getHTML())
  })
}

/** Desktop sticky note window (#/popup/sticky/:id). Saves while typing. */
export function StickyWindow({ id }: { id: string }): React.JSX.Element {
  const [memo, setMemo] = useState<MemoDto | null>(null)
  useEffect(() => {
    void invoke('local:memos.get', { id }).then(setMemo)
  }, [id])
  if (!memo) return <div className="h-full bg-yellow-100" />
  return <Sticky memo={memo} />
}

function Sticky({ memo: initial }: { memo: MemoDto }): React.JSX.Element {
  const [memo, setMemo] = useState(initial)
  const [saved, setSaved] = useState(true)
  const timer = useRef<number | null>(null)
  const latest = useRef(initial)
  latest.current = memo

  const save = (patch: Partial<MemoDto>): void => {
    const next = { ...latest.current, ...patch }
    setMemo(next)
    setSaved(false)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => {
      void invoke('local:memos.save', { id: next.id, body: next.body, color: next.color, pinned: next.pinned, tags: next.tags }).then(() => setSaved(true))
    }, 400)
  }
  const editor = useLiteEditor(initial.body, '메모를 입력하세요', (body) => save({ body }))

  // Edits made in the main window (color, body) show up here.
  useEffect(
    () =>
      onMain('memos:changed', ({ id }) => {
        if (id !== initial.id) return
        void invoke('local:memos.get', { id }).then((m) => {
          if (!m) return
          setMemo((cur) => ({ ...cur, color: m.color, alwaysOnTop: m.alwaysOnTop, tags: m.tags, pinned: m.pinned }))
          if (editor && !editor.isFocused && m.body !== editor.getHTML() && m.body !== latest.current.body) {
            editor.commands.setContent(m.body)
            latest.current = { ...latest.current, body: m.body }
          }
        })
      }),
    [initial.id, editor]
  )

  const flush = async (): Promise<void> => {
    if (timer.current) window.clearTimeout(timer.current)
    const m = latest.current
    await invoke('local:memos.save', { id: m.id, body: m.body, color: m.color, pinned: m.pinned, tags: m.tags })
  }

  return (
    <div className="flex h-full flex-col text-slate-900" style={{ background: MEMO_COLORS[memo.color] }} data-testid="sticky-window">
      <div className="flex shrink-0 items-center gap-1 px-1.5 py-1" style={drag}>
        <div className="flex gap-0.5" style={noDrag}>
          {(Object.keys(MEMO_COLORS) as MemoColor[]).map((c) => (
            <button key={c} aria-label={`색상 ${c}`} className={cn('size-3.5 cursor-pointer rounded-full border border-black/20', memo.color === c && 'ring-1 ring-slate-700')} style={{ background: MEMO_COLORS[c] }} onClick={() => save({ color: c })} />
          ))}
        </div>
        <span className="ml-1 flex-1 text-[10px] text-slate-500">{saved ? '' : '저장 중…'}</span>
        <div className="flex" style={noDrag}>
          <button className="cursor-pointer rounded p-1 hover:bg-black/10" aria-label="체크리스트" title="체크리스트" onClick={() => editor?.chain().focus().toggleTaskList().run()}>
            <ListChecks className="size-3.5" />
          </button>
          <button
            className="cursor-pointer rounded p-1 hover:bg-black/10"
            aria-label={memo.alwaysOnTop ? '항상 위 끄기' : '항상 위'}
            title={memo.alwaysOnTop ? '항상 위 끄기' : '항상 위'}
            onClick={() => {
              setMemo({ ...memo, alwaysOnTop: !memo.alwaysOnTop })
              void invoke('memo:onTop', { id: memo.id, on: !memo.alwaysOnTop })
            }}
          >
            {memo.alwaysOnTop ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <button className="cursor-pointer rounded p-1 hover:bg-black/10" aria-label="TeamHub에서 열기" title="TeamHub에서 열기" onClick={() => void flush().then(() => invoke('window:showMain', { path: '/memos' }))}>
            <ExternalLink className="size-3.5" />
          </button>
          <button className="cursor-pointer rounded p-1 hover:bg-black/10" aria-label="바탕화면에서 떼기" title="바탕화면에서 떼기 (메모는 남습니다)" onClick={() => void flush().then(() => invoke('memo:sticky', { id: memo.id, on: false }))}>
            <X className="size-3.5" />
          </button>
        </div>
      </div>
      <EditorContent editor={editor} className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 text-sm" />
    </div>
  )
}

/** Quick memo window (Ctrl+Alt+M): type, save, done. */
export function QuickMemo(): React.JSX.Element {
  const [body, setBody] = useState('')
  const [sticky, setSticky] = useState(false)
  const editor = useLiteEditor('', '빠르게 적어 두세요. Ctrl+Enter로 저장', setBody)
  useEffect(() => {
    editor?.commands.focus()
  }, [editor])

  const save = async (): Promise<void> => {
    if (!body) return void invoke('memo:closeWindow')
    const id = await invoke('local:memos.save', { body, color: 'yellow', tags: [] })
    if (sticky) await invoke('memo:sticky', { id, on: true })
    await invoke('memo:closeWindow')
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') void invoke('memo:closeWindow')
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className="flex h-full flex-col bg-background" data-testid="quick-memo">
      <div className="min-h-0 flex-1 overflow-y-auto p-3 text-sm" style={{ background: MEMO_COLORS.yellow }}>
        <EditorContent editor={editor} className="h-full text-slate-900" />
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-sm">
        <label className="flex cursor-pointer items-center gap-1.5">
          <input type="checkbox" checked={sticky} onChange={(e) => setSticky(e.target.checked)} /> 바탕화면에 붙이기
        </label>
        <button className="ml-auto cursor-pointer rounded-md px-3 py-1.5 hover:bg-muted" onClick={() => void invoke('memo:closeWindow')}>
          취소
        </button>
        <button className="flex cursor-pointer items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-primary-foreground" onClick={() => void save()}>
          <Save className="size-4" /> 저장
        </button>
      </div>
    </div>
  )
}
