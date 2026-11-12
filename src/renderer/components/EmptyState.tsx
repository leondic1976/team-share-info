import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { Loader2, AlertCircle, WifiOff } from 'lucide-react'

export function EmptyState({
  icon: Icon,
  title,
  description,
  action
}: {
  icon?: LucideIcon
  title: string
  description?: string
  action?: ReactNode
}): React.JSX.Element {
  return (
    <div className="flex h-full min-h-48 flex-col items-center justify-center gap-2 p-8 text-center">
      {Icon && <Icon className="size-10 text-muted-foreground/60" aria-hidden />}
      <p className="text-base font-semibold">{title}</p>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  )
}

export function Loading({ label = '불러오는 중…' }: { label?: string }): React.JSX.Element {
  return (
    <div className="flex h-full min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  )
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }): React.JSX.Element {
  const msg = error instanceof Error ? error.message : String(error)
  return (
    <EmptyState
      icon={AlertCircle}
      title="문제가 발생했습니다"
      description={msg}
      action={
        onRetry && (
          <button className="text-sm text-primary underline" onClick={onRetry}>
            다시 시도
          </button>
        )
      }
    />
  )
}

export function OfflineState(): React.JSX.Element {
  return (
    <EmptyState
      icon={WifiOff}
      title="서버에 연결되어 있지 않습니다"
      description="서버 PC가 켜져 있는지 확인하세요. 연결되면 자동으로 다시 불러옵니다."
    />
  )
}
