import { useEffect } from 'react'
import { useEditor, EditorContent, type Editor as TipTap } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Image from '@tiptap/extension-image'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Placeholder } from '@tiptap/extensions'
import { Bold, Heading2, Italic, List, ListChecks, ListOrdered, Quote, Redo2, Strikethrough, Table, Underline, Undo2 } from 'lucide-react'
import { cn } from './ui'

/** Rich text editor of the module (the same editor and toolbar as the host program). */
export function Editor({ value, onChange, placeholder, minHeight = 140, ariaLabel = '본문' }: { value: string; onChange: (html: string) => void; placeholder?: string; minHeight?: number; ariaLabel?: string }): React.JSX.Element {
  const editor = useEditor({
    extensions: [StarterKit.configure({ link: { openOnClick: false } }), TaskList, TaskItem.configure({ nested: true }), TableKit.configure({ table: { resizable: false } }), Image.configure({ allowBase64: true }), Placeholder.configure({ placeholder: placeholder ?? '내용을 입력하세요' })],
    content: value,
    editorProps: {
      attributes: { class: 'rich outline-none', 'aria-label': ariaLabel, role: 'textbox', 'aria-multiline': 'true' },
      handlePaste: (view, event) => {
        const file = [...(event.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
        if (!file) return false
        if (file.size > 1024 * 1024) {
          window.alert('붙여넣을 이미지는 1MB 이하여야 합니다. 큰 이미지는 첨부 파일로 올리세요.')
          return true
        }
        const reader = new FileReader()
        reader.onload = () => {
          const node = view.state.schema.nodes.image?.create({ src: String(reader.result) })
          if (node) view.dispatch(view.state.tr.replaceSelectionWith(node))
        }
        reader.readAsDataURL(file)
        return true
      }
    },
    onUpdate: ({ editor: e }) => onChange(e.isEmpty ? '' : e.getHTML())
  })
  useEffect(() => {
    if (editor && value === '' && !editor.isEmpty) editor.commands.clearContent()
  }, [editor, value])
  return (
    <div className="rounded-md border border-input bg-background focus-within:outline-2 focus-within:outline-primary">
      {editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} className="px-3 py-2" style={{ minHeight }} />
    </div>
  )
}

function Toolbar({ editor }: { editor: TipTap }): React.JSX.Element {
  const btn = (label: string, Icon: typeof Bold, active: boolean, run: () => void): React.JSX.Element => (
    <button type="button" aria-label={label} title={label} onMouseDown={(e) => e.preventDefault()} onClick={run} className={cn('cursor-pointer rounded p-1.5 hover:bg-muted', active && 'bg-primary/10 text-primary')}>
      <Icon className="size-4" />
    </button>
  )
  const c = (): ReturnType<TipTap['chain']> => editor.chain().focus()
  return (
    <div className="flex flex-wrap gap-0.5 border-b border-border px-1.5 py-1">
      {btn('굵게', Bold, editor.isActive('bold'), () => c().toggleBold().run())}
      {btn('기울임', Italic, editor.isActive('italic'), () => c().toggleItalic().run())}
      {btn('밑줄', Underline, editor.isActive('underline'), () => c().toggleUnderline().run())}
      {btn('취소선', Strikethrough, editor.isActive('strike'), () => c().toggleStrike().run())}
      <span className="mx-1 w-px bg-border" />
      {btn('소제목', Heading2, editor.isActive('heading', { level: 2 }), () => c().toggleHeading({ level: 2 }).run())}
      {btn('글머리 목록', List, editor.isActive('bulletList'), () => c().toggleBulletList().run())}
      {btn('번호 목록', ListOrdered, editor.isActive('orderedList'), () => c().toggleOrderedList().run())}
      {btn('체크리스트', ListChecks, editor.isActive('taskList'), () => c().toggleTaskList().run())}
      {btn('인용', Quote, editor.isActive('blockquote'), () => c().toggleBlockquote().run())}
      {btn('표 넣기', Table, editor.isActive('table'), () => c().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}
      <span className="mx-1 w-px bg-border" />
      {btn('되돌리기', Undo2, false, () => c().undo().run())}
      {btn('다시 실행', Redo2, false, () => c().redo().run())}
    </div>
  )
}

/** Read-only rendering of HTML the server cleaned. */
export function RichView({ html, className }: { html: string; className?: string }): React.JSX.Element {
  return <div className={cn('rich selectable', className)} dangerouslySetInnerHTML={{ __html: html }} />
}
