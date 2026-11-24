import { useEffect, useMemo, useRef, useState } from 'react'
import { EditorContent, Mark, Node, mergeAttributes, useEditor, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { TableKit } from '@tiptap/extension-table'
import Image from '@tiptap/extension-image'
import { Placeholder } from '@tiptap/extensions'
import { Details, DetailsContent, DetailsSummary } from '@tiptap/extension-details'
import { FileText, Plus } from 'lucide-react'
import { NoteIcon } from './NoteIcon'
import type { NoteTreeItem } from '@shared/notes'
import { cn } from '@renderer/lib/utils'

/** Link to another note page: <a data-note-id> (kept apart from web links). */
const NoteLink = Mark.create({
  name: 'noteLink',
  inclusive: false,
  priority: 1001,
  addAttributes() {
    return { id: { default: null, parseHTML: (el) => el.getAttribute('data-note-id'), renderHTML: (a) => ({ 'data-note-id': a.id as string, href: `#/notes/${a.id as string}` }) } }
  },
  parseHTML() {
    return [{ tag: 'a[data-note-id]', priority: 1001 }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['a', mergeAttributes(HTMLAttributes, { class: 'note-link' }), 0]
  }
})

/** Callout box: a highlighted block with a light-bulb mark drawn by CSS (styles.css). */
const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-callout': '', class: 'callout' }), 0]
  }
})

interface Cmd {
  key: string
  label: string
  hint: string
  run: (e: Editor) => void
}

function commands(pickImage: () => void, newSub: () => void, openLink: () => void): Cmd[] {
  const c = (e: Editor) => e.chain().focus()
  return [
    { key: 'h1', label: '제목 1', hint: '#', run: (e) => c(e).toggleHeading({ level: 1 }).run() },
    { key: 'h2', label: '제목 2', hint: '##', run: (e) => c(e).toggleHeading({ level: 2 }).run() },
    { key: 'h3', label: '제목 3', hint: '###', run: (e) => c(e).toggleHeading({ level: 3 }).run() },
    { key: 'text', label: '본문', hint: '', run: (e) => c(e).setParagraph().run() },
    { key: 'bullet', label: '글머리 목록', hint: '-', run: (e) => c(e).toggleBulletList().run() },
    { key: 'number', label: '번호 목록', hint: '1.', run: (e) => c(e).toggleOrderedList().run() },
    { key: 'todo', label: '체크리스트', hint: '[]', run: (e) => c(e).toggleTaskList().run() },
    { key: 'toggle', label: '토글', hint: '', run: (e) => c(e).setDetails().run() },
    { key: 'quote', label: '인용', hint: '>', run: (e) => c(e).toggleBlockquote().run() },
    { key: 'callout', label: '콜아웃', hint: '', run: (e) => c(e).wrapIn('callout').run() },
    { key: 'code', label: '코드', hint: '```', run: (e) => c(e).toggleCodeBlock().run() },
    { key: 'divider', label: '구분선', hint: '---', run: (e) => c(e).setHorizontalRule().run() },
    { key: 'table', label: '표', hint: '', run: (e) => c(e).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
    { key: 'image', label: '이미지', hint: '', run: () => pickImage() },
    { key: 'link', label: '페이지 연결', hint: '[[', run: () => openLink() },
    { key: 'page', label: '하위 페이지', hint: '', run: () => newSub() }
  ]
}

interface Menu {
  type: 'slash' | 'link'
  query: string
  from: number
  to: number
  x: number
  y: number
}

/**
 * Block editor for note pages: `/` command menu, `[[` page links, toggles, callouts,
 * Markdown shortcuts (StarterKit input rules). Value is HTML.
 */
export function NoteEditor({
  value,
  onChange,
  pages,
  onOpenPage,
  onCreatePage
}: {
  value: string
  onChange: (html: string) => void
  pages: NoteTreeItem[]
  onOpenPage: (id: string) => void
  onCreatePage: (title: string) => Promise<string>
}): React.JSX.Element {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [idx, setIdx] = useState(0)
  const fileRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<{ menu: Menu | null; idx: number; items: number }>({ menu: null, idx: 0, items: 0 })
  const editorRef = useRef<Editor | null>(null)

  const insertLink = async (id: string | null, title: string): Promise<void> => {
    const e = editorRef.current
    const m = menuRef.current.menu
    if (!e || !m) return
    const target = id ?? (await onCreatePage(title || '새 페이지'))
    const t = id ? (pages.find((p) => p.id === id)?.title ?? title) : title || '새 페이지'
    e.chain()
      .focus()
      .deleteRange({ from: m.from, to: m.to })
      .insertContent([
        { type: 'text', text: t || '제목 없음', marks: [{ type: 'noteLink', attrs: { id: target } }] },
        { type: 'text', text: ' ' }
      ])
      .run()
    setMenu(null)
  }

  const cmdList = useMemo(
    () =>
      commands(
        () => fileRef.current?.click(),
        () => {
          const m = menuRef.current.menu
          setMenu(m ? { ...m, type: 'link', query: '' } : null)
          void insertLink(null, '새 페이지')
        },
        () => {
          const e = editorRef.current
          if (e) e.chain().focus().insertContent('[[').run()
        }
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pages]
  )

  const items = useMemo(() => {
    if (!menu) return []
    const q = menu.query.toLowerCase()
    if (menu.type === 'slash') return cmdList.filter((c) => !q || c.label.toLowerCase().includes(q) || c.key.includes(q))
    return pages.filter((p) => !p.isTemplate && (p.title || '제목 없음').toLowerCase().includes(q)).slice(0, 8)
  }, [menu, cmdList, pages])
  menuRef.current = { menu, idx, items: menu?.type === 'link' ? items.length + 1 : items.length }

  const choose = (i: number): void => {
    const e = editorRef.current
    const m = menuRef.current.menu
    if (!e || !m) return
    if (m.type === 'slash') {
      const c = (items as Cmd[])[i]
      if (!c) return
      e.chain().focus().deleteRange({ from: m.from, to: m.to }).run()
      setMenu(null)
      c.run(e)
    } else {
      const p = (items as NoteTreeItem[])[i]
      void insertLink(p ? p.id : null, p ? p.title : m.query)
    }
  }
  const chooseRef = useRef(choose)
  chooseRef.current = choose

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: { openOnClick: false } }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TableKit.configure({ table: { resizable: false } }),
      Image.configure({ allowBase64: true }),
      Details.configure({ persist: true, HTMLAttributes: { class: 'details' } }),
      DetailsSummary,
      DetailsContent,
      Callout,
      NoteLink,
      Placeholder.configure({ placeholder: ({ node }) => (node.type.name === 'paragraph' ? '내용을 입력하거나 / 를 눌러 블록을 고르세요. [[ 로 다른 페이지 연결' : '') })
    ],
    content: value,
    editorProps: {
      attributes: { class: 'rich note-body outline-none', 'aria-label': '페이지 내용', role: 'textbox', 'aria-multiline': 'true' },
      handleKeyDown: (_v, ev) => {
        const r = menuRef.current
        if (!r.menu) return false
        if (ev.key === 'ArrowDown') {
          setIdx((i) => Math.min(r.items - 1, i + 1))
          return true
        }
        if (ev.key === 'ArrowUp') {
          setIdx((i) => Math.max(0, i - 1))
          return true
        }
        if (ev.key === 'Enter') {
          chooseRef.current(r.idx)
          return true
        }
        if (ev.key === 'Escape') {
          setMenu(null)
          return true
        }
        return false
      },
      handleClick: (_v, _pos, ev) => {
        const a = (ev.target as HTMLElement).closest('a[data-note-id]')
        if (a) {
          ev.preventDefault()
          onOpenPage(a.getAttribute('data-note-id')!)
          return true
        }
        return false
      },
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
        if (!file || file.size > 2 * 1024 * 1024) return false
        const reader = new FileReader()
        reader.onload = () => {
          const node = view.state.schema.nodes.image?.create({ src: String(reader.result) })
          if (node) view.dispatch(view.state.tr.replaceSelectionWith(node))
        }
        reader.readAsDataURL(file)
        return true
      }
    },
    onUpdate: ({ editor: e }) => {
      onChange(e.isEmpty ? '' : e.getHTML())
      detect(e)
    },
    onSelectionUpdate: ({ editor: e }) => detect(e)
  })
  editorRef.current = editor

  function detect(e: Editor): void {
    const { $from, empty } = e.state.selection
    if (!empty || e.isActive('codeBlock')) return setMenu(null)
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼')
    const slash = /(?:^|\s)\/([^\s/]{0,15})$/.exec(before)
    const link = /\[\[([^\]\n]{0,40})$/.exec(before)
    const m = link ? { type: 'link' as const, q: link[1], len: link[0].length } : slash ? { type: 'slash' as const, q: slash[1], len: slash[1].length + 1 } : null
    if (!m) return setMenu(null)
    const coords = e.view.coordsAtPos($from.pos)
    setMenu((cur) => {
      if (!cur || cur.query !== m.q || cur.type !== m.type) setIdx(0)
      return { type: m.type, query: m.q, from: $from.pos - m.len, to: $from.pos, x: coords.left, y: coords.bottom }
    })
  }

  useEffect(() => {
    if (editor && value !== editor.getHTML() && !editor.isFocused) editor.commands.setContent(value || '')
  }, [editor, value])

  return (
    <div
      className="relative"
      data-testid="note-editor"
      onClickCapture={(ev) => {
        const a = (ev.target as HTMLElement).closest('a[data-note-id]')
        if (!a) return
        ev.preventDefault()
        ev.stopPropagation()
        onOpenPage(a.getAttribute('data-note-id')!)
      }}
    >
      <EditorContent editor={editor} className="min-h-64" />
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        hidden
        onChange={(ev) => {
          const f = ev.target.files?.[0]
          ev.target.value = ''
          if (!f || !editor) return
          if (f.size > 2 * 1024 * 1024) return window.alert('2MB 이하 이미지만 넣을 수 있습니다.')
          const r = new FileReader()
          r.onload = () => editor.chain().focus().setImage({ src: String(r.result) }).run()
          r.readAsDataURL(f)
        }}
      />
      {menu && (items.length > 0 || menu.type === 'link') && (
        <div className="fixed z-50 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-card p-1 shadow-xl" style={{ left: Math.min(menu.x, window.innerWidth - 270), top: Math.min(menu.y + 4, window.innerHeight - 300) }} role="listbox" aria-label={menu.type === 'slash' ? '블록 메뉴' : '페이지 연결'} data-testid="note-menu">
          {menu.type === 'slash'
            ? (items as Cmd[]).map((c, i) => (
                <button key={c.key} role="option" aria-selected={i === idx} className={cn('flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5 text-left text-sm', i === idx ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')} onMouseDown={(e) => (e.preventDefault(), choose(i))} onMouseEnter={() => setIdx(i)}>
                  {c.label}
                  <span className="text-xs opacity-60">{c.hint}</span>
                </button>
              ))
            : [
                ...(items as NoteTreeItem[]).map((p, i) => (
                  <button key={p.id} role="option" aria-selected={i === idx} className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm', i === idx ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')} onMouseDown={(e) => (e.preventDefault(), choose(i))} onMouseEnter={() => setIdx(i)}>
                    <span>{p.icon ? <NoteIcon value={p.icon} /> : <FileText className="size-4" />}</span> <span className="truncate">{p.title || '제목 없음'}</span>
                  </button>
                )),
                <button
                  key="new"
                  role="option"
                  aria-selected={idx === items.length}
                  className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-sm', idx === items.length ? 'bg-primary text-primary-foreground' : 'hover:bg-muted')}
                  onMouseDown={(e) => (e.preventDefault(), choose(items.length))}
                  onMouseEnter={() => setIdx(items.length)}
                >
                  <Plus className="size-4" /> 새 페이지 "{menu.query || '새 페이지'}"
                </button>
              ]}
        </div>
      )}
    </div>
  )
}
