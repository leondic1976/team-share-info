import type { Presence } from '@shared/schemas/auth'
import { cn } from '@renderer/lib/utils'

export const PRESENCE_LABEL: Record<Presence, string> = {
  online: '온라인',
  away: '자리비움',
  absent: '부재',
  offline: '오프라인'
}

const COLOR: Record<Presence, string> = {
  online: 'bg-success',
  away: 'bg-important',
  absent: 'bg-personal',
  offline: 'bg-muted-foreground/40'
}

export function PresenceDot({ presence, className }: { presence: Presence; className?: string }): React.JSX.Element {
  return <span className={cn('inline-block size-2.5 shrink-0 rounded-full', COLOR[presence], className)} title={PRESENCE_LABEL[presence]} aria-label={PRESENCE_LABEL[presence]} />
}
