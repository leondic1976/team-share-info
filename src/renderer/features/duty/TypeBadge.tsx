import { DUTY_COLORS, dutyGroupOf } from '@shared/schemas/duty'
import { cn } from '@renderer/lib/utils'

/** The reason of an absence in its colour (연가 blue, 출장 orange...), with the time when not all day. */
export function TypeBadge({ type, part, className }: { type: string; part?: string; className?: string }): React.JSX.Element {
  const color = DUTY_COLORS[dutyGroupOf(type)]
  return (
    <span className={cn('inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold leading-none', className)} style={{ color, backgroundColor: `${color}22` }}>
      {type}
      {part && <span className="ml-1 font-normal">{part}</span>}
    </span>
  )
}
