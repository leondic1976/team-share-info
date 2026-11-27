import { isClerk, type Role } from '@shared/schemas/auth'
import { DUTY_COLORS, dutyGroupOf } from '@shared/schemas/duty'
import { useMembers } from '@renderer/lib/queries'
import { useAbsentNow } from '@renderer/features/duty/useAbsentNow'
import { cn } from '@renderer/lib/utils'

/**
 * The small marks shown next to a member's name everywhere a name is shown: "서무", and the
 * 사고명 (연가, 출장...) while 근무현황 has them away today. Pass the member's role/isOwner when the
 * caller has them; otherwise the member is looked up by id in the members list. `noAbsence`
 * leaves the 사고명 out where the screen already shows it (근무현황 itself, absence events).
 */
export function RoleMark({
  memberId,
  role,
  isOwner,
  className,
  noAbsence
}: {
  memberId?: string | null
  role?: Role | null
  isOwner?: boolean
  className?: string
  noAbsence?: boolean
}): React.JSX.Element | null {
  const { data } = useMembers()
  const known = role !== undefined && role !== null
  const m = known ? { role, isOwner } : memberId ? data?.find((x) => x.id === memberId) : undefined
  const clerk = isClerk(m)
  const away = noAbsence ? null : <AbsenceMark memberId={memberId} className={className} />
  if (!clerk) return away
  return (
    <>
      <span
        data-role-mark="서무"
        title="서무"
        className={cn(
          'ml-1 inline-flex shrink-0 items-center rounded bg-primary/10 px-1 py-px align-middle text-[0.65rem] font-medium leading-none text-primary',
          className
        )}
      >
        서무
      </span>
      {away}
    </>
  )
}

/** The 사고명 badge (연가 blue, 출장 orange... as in 근무현황) while the member is away today. */
export function AbsenceMark({ memberId, className }: { memberId?: string | null; className?: string }): React.JSX.Element | null {
  const away = useAbsentNow()
  const a = memberId ? away.get(memberId) : undefined
  if (!a) return null
  return (
    <>
      {a.types.map((t) => {
        const color = DUTY_COLORS[dutyGroupOf(t)]
        return (
          <span
            key={t}
            data-absence-mark={t}
            title={a.title}
            className={cn('ml-1 inline-flex shrink-0 items-center rounded px-1 py-px align-middle text-[0.65rem] font-semibold leading-none', className)}
            style={{ color, backgroundColor: `${color}22` }}
          >
            {t}
          </span>
        )
      })}
    </>
  )
}
