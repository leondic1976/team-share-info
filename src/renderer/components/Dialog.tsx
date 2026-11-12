import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'

/** Minimal modal dialog: Esc and backdrop click close it; focus moves inside. */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 'max-w-xl'
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
}): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    const first = ref.current?.querySelector<HTMLElement>('input, textarea, select, [contenteditable="true"], button:not([data-close])')
    first?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={cn('flex max-h-[90vh] w-full flex-col rounded-xl bg-card shadow-xl', width)}>
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <h2 className="flex-1 text-base font-bold">{title}</h2>
          <button data-close className="cursor-pointer rounded p-1 hover:bg-muted" onClick={onClose} aria-label="닫기">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  )
}

export function confirmDialog(message: string): boolean {
  return window.confirm(message)
}
