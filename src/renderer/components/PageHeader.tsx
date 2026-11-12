import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-3">
      <div className="min-w-0">
        <h1 className="truncate text-lg font-bold">{title}</h1>
        {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="ml-auto flex items-center gap-2">{actions}</div>
    </div>
  )
}
