/**
 * The building blocks of the command screens. They use the same classes (and so the same look,
 * light and dark) as the host's components, without importing them, so the module can stand on
 * its own.
 */
import { forwardRef, useCallback, useEffect, useRef, useState, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react'
import { createPortal } from 'react-dom'
import { twMerge } from 'tailwind-merge'
import { X, type LucideIcon } from 'lucide-react'

/** Class names with later Tailwind classes winning over earlier ones (as in the host). */
export const cn = (...c: (string | false | null | undefined)[]): string => twMerge(c.filter(Boolean).join(' '))

type Variant = 'default' | 'destructive' | 'outline' | 'secondary' | 'ghost'
type Size = 'default' | 'sm' | 'lg' | 'icon' | 'icon-sm'
const VARIANT: Record<Variant, string> = {
  default: 'bg-primary text-primary-foreground hover:bg-primary/90',
  destructive: 'bg-urgent text-white hover:bg-urgent/90',
  outline: 'border border-input bg-background hover:bg-muted',
  secondary: 'bg-muted text-foreground hover:bg-muted/70',
  ghost: 'hover:bg-muted'
}
const SIZE: Record<Size, string> = { default: 'h-9 px-3.5', sm: 'h-8 px-2.5 text-xs', lg: 'h-10 px-5', icon: 'h-9 w-9', 'icon-sm': 'h-8 w-8' }

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }>(({ className, variant = 'default', size = 'default', type, ...p }, ref) => (
  <button
    ref={ref}
    type={type ?? 'button'}
    className={cn('inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0', VARIANT[variant], SIZE[size], className)}
    {...p}
  />
))
Button.displayName = 'Button'

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn('h-9 w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground disabled:opacity-50', className)} {...p} />
))
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn('min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:opacity-50', className)} {...p} />
))
Textarea.displayName = 'Textarea'

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...p }, ref) => (
  <select ref={ref} className={cn('h-9 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50', className)} {...p} />
))
Select.displayName = 'Select'

export function Field({ label, hint, children, className }: { label: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }): React.JSX.Element {
  return (
    <label className={cn('block space-y-1', className)}>
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  )
}

export function Card({ className, ...p }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('rounded-lg border border-border bg-card', className)} {...p} />
}
export function CardHeader({ className, ...p }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3', className)} {...p} />
}
export function CardTitle({ className, ...p }: HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return <h3 className={cn('text-sm font-semibold', className)} {...p} />
}
export function CardContent({ className, ...p }: HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('p-4', className)} {...p} />
}

export function Badge({ tone = 'muted', className, ...p }: HTMLAttributes<HTMLSpanElement> & { tone?: 'muted' | 'primary' | 'urgent' | 'important' | 'success' | 'drill' }): React.JSX.Element {
  const t = {
    muted: 'bg-muted text-muted-foreground',
    primary: 'bg-primary/10 text-primary',
    urgent: 'bg-urgent/10 text-urgent',
    important: 'bg-important/15 text-important',
    success: 'bg-success/15 text-success',
    drill: 'bg-orange-500/15 text-orange-600 dark:text-orange-400'
  }[tone]
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[0.7rem] font-semibold whitespace-nowrap [&_svg]:size-3', t, className)} {...p} />
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
      <div className="min-w-0">
        <h1 className="th-title truncate text-xl">{title}</h1>
        {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  )
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: LucideIcon; title: string; description?: string; action?: ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-48 w-full min-w-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center" data-testid="empty-state">
      {Icon && <Icon className="size-10 text-muted-foreground/60" aria-hidden />}
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function EmptyNote({ children }: { children: ReactNode }): React.JSX.Element {
  return <p className="px-2 py-6 text-center text-sm text-muted-foreground">{children}</p>
}

/** Modal dialog on the document body (outside any drag region), Esc and backdrop close it. */
export function Dialog({ open, onClose, title, children, footer, width = 'max-w-xl' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; width?: string }): React.JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    ref.current?.querySelector<HTMLElement>('input, textarea, select, [contenteditable="true"]')?.focus()
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="no-drag fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} className={cn('flex max-h-[90vh] w-full flex-col rounded-xl bg-card shadow-xl', width)}>
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <h2 className="flex-1 text-base font-bold">{title}</h2>
          <button className="cursor-pointer rounded p-1 hover:bg-muted" onClick={onClose} aria-label="닫기">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}

/**
 * Asks for a short text in a dialog of the app (Electron has no window.prompt):
 * `const { ask, dialog } = useAsk()`, render `{dialog}`, then `const v = await ask('이름', 'A조')`.
 */
export function useAsk(): { ask: (title: string, initial?: string, placeholder?: string) => Promise<string | null>; dialog: React.JSX.Element | null } {
  const [q, setQ] = useState<{ title: string; value: string; placeholder?: string; done: (v: string | null) => void } | null>(null)
  const ask = useCallback((title: string, initial = '', placeholder?: string) => new Promise<string | null>((done) => setQ({ title, value: initial, placeholder, done })), [])
  const finish = (v: string | null): void => {
    q?.done(v === null ? null : v.trim() || null)
    setQ(null)
  }
  const dialog = q ? (
    <Dialog
      open
      onClose={() => finish(null)}
      title={q.title}
      width="max-w-md"
      footer={
        <>
          <Button variant="outline" onClick={() => finish(null)}>
            취소
          </Button>
          <Button disabled={!q.value.trim()} onClick={() => finish(q.value)} data-testid="ask-ok">
            확인
          </Button>
        </>
      }
    >
      <Input value={q.value} maxLength={100} placeholder={q.placeholder} aria-label={q.title} onChange={(e) => setQ({ ...q, value: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && q.value.trim() && finish(q.value)} data-testid="ask-input" />
    </Dialog>
  ) : null
  return { ask, dialog }
}

/** A row of tabs (the look of the host's page tabs). */
export function Tabs<T extends string>({ value, onChange, items, className }: { value: T; onChange: (v: T) => void; items: { key: T; label: string; icon?: LucideIcon; badge?: number; hidden?: boolean }[]; className?: string }): React.JSX.Element {
  return (
    <div className={cn('flex shrink-0 flex-wrap gap-1', className)} role="tablist">
      {items
        .filter((t) => !t.hidden)
        .map((t) => (
          <Button key={t.key} role="tab" aria-selected={value === t.key} size="sm" variant={value === t.key ? 'default' : 'ghost'} onClick={() => onChange(t.key)} data-tab={t.key}>
            {t.icon && <t.icon />} {t.label}
            {!!t.badge && <span className="ml-0.5 rounded-full bg-urgent px-1.5 text-[0.65rem] font-bold leading-4 text-white">{t.badge}</span>}
          </Button>
        ))}
    </div>
  )
}

/** "직위 성명" */
export const titled = (p: { name: string; title?: string; mark?: string } | undefined | null): string => (p ? `${p.title ? `${p.title} ` : ''}${p.name}${p.mark ? ` (${p.mark})` : ''}` : '(알 수 없음)')
