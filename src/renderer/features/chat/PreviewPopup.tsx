import { useCallback, useEffect, useState } from 'react'
import { format } from 'date-fns'
import { MessageSquare, X } from 'lucide-react'
import type { PreviewItem } from '@shared/ipc'
import { invoke, onMain } from '@renderer/lib/bridge'

/**
 * The cards near the tray for new messages (#/popup/preview, src/main/preview.ts). Clicking a
 * card opens the conversation; X closes it. The window is transparent: only the cards show.
 */
export function PreviewPopup(): React.JSX.Element {
  const [items, setItems] = useState<PreviewItem[]>([])
  const load = useCallback(() => void invoke('preview:list').then(setItems), [])
  useEffect(() => {
    document.documentElement.style.background = 'transparent'
    document.body.style.background = 'transparent'
    load()
    return onMain('preview:changed', load)
  }, [load])

  return (
    <div className="flex h-screen flex-col justify-end gap-2 p-2" data-testid="message-preview">
      {items.length > 1 && (
        <button type="button" className="self-end cursor-pointer rounded-full bg-card/95 px-2.5 py-0.5 text-[0.7rem] text-muted-foreground shadow hover:text-foreground" onClick={() => void invoke('preview:dismiss', { key: null })}>
          모두 닫기
        </button>
      )}
      {items.map((it) => (
        <div
          key={it.key}
          role="button"
          tabIndex={0}
          className="group relative flex h-[76px] shrink-0 cursor-pointer gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5 text-card-foreground shadow-lg hover:border-primary/60"
          onClick={() => void invoke('preview:open', { key: it.key })}
          onKeyDown={(e) => e.key === 'Enter' && void invoke('preview:open', { key: it.key })}
          title="눌러서 대화 열기"
          data-testid="preview-card"
        >
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            <MessageSquare className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 pr-5">
              <b className="truncate text-sm">{it.title}</b>
              {it.count > 1 && <span className="shrink-0 rounded-full bg-urgent px-1.5 text-[0.65rem] font-bold leading-4 text-white">{it.count}</span>}
              <span className="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">{format(it.at, 'HH:mm')}</span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground break-all">{it.body}</p>
          </div>
          <button
            type="button"
            className="absolute right-1.5 top-1.5 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="닫기"
            title="닫기"
            onClick={(e) => {
              e.stopPropagation()
              void invoke('preview:dismiss', { key: it.key })
            }}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
