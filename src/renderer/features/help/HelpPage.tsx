import { useMemo, useState } from 'react'
import { marked } from 'marked'
import { Search } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Input } from '@renderer/components/ui/input'
import { cn } from '@renderer/lib/utils'

/** The in-app manual shows docs/manual/*.md as-is (13.0 rule 11). */
const files = import.meta.glob('../../../../docs/manual/*.md', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

interface Chapter {
  id: string
  title: string
  md: string
}

const CHAPTERS: Chapter[] = Object.entries(files)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, md]) => ({
    id: path.split('/').pop()!.replace('.md', ''),
    title: (/^#\s+(.+)$/m.exec(md)?.[1] ?? path).trim(),
    md
  }))

export function HelpPage(): React.JSX.Element {
  const [current, setCurrent] = useState(CHAPTERS[0]?.id ?? '')
  const [q, setQ] = useState('')
  const chapter = CHAPTERS.find((c) => c.id === current) ?? CHAPTERS[0]
  const html = useMemo(() => (chapter ? (marked.parse(chapter.md, { async: false }) as string) : ''), [chapter])
  const matches = q.trim() ? CHAPTERS.filter((c) => c.md.toLowerCase().includes(q.trim().toLowerCase())) : CHAPTERS

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="도움말" description="TeamHub 사용 설명서 (F1)" />
      <div className="flex min-h-0 flex-1">
        <aside className="w-56 shrink-0 space-y-2 overflow-y-auto border-r border-border p-3">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input aria-label="설명서 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="설명서 검색" />
          </div>
          <nav aria-label="설명서 목차" className="space-y-0.5">
            {matches.map((c) => (
              <button
                key={c.id}
                onClick={() => setCurrent(c.id)}
                className={cn(
                  'block w-full cursor-pointer rounded px-2.5 py-1.5 text-left text-sm',
                  c.id === chapter?.id ? 'bg-primary/10 font-semibold text-primary' : 'hover:bg-muted'
                )}
              >
                {c.title}
              </button>
            ))}
          </nav>
        </aside>
        <article className="manual selectable min-w-0 flex-1 overflow-y-auto px-8 py-6" data-testid="manual" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  )
}

export const MANUAL_CHAPTERS = CHAPTERS
