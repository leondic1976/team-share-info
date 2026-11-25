import { isClerk, type Role } from '@shared/schemas/auth'
import { useMembers } from '@renderer/lib/queries'
import { cn } from '@renderer/lib/utils'

/**
 * The small "서무" mark shown next to a member's name everywhere a name is shown.
 * Pass the member's role/isOwner when the caller has them; otherwise the member is looked up
 * by id in the members list. Renders nothing for anyone who is not a 서무.
 */
export function RoleMark({
  memberId,
  role,
  isOwner,
  className
}: {
  memberId?: string | null
  role?: Role | null
  isOwner?: boolean
  className?: string
}): React.JSX.Element | null {
  const { data } = useMembers()
  const known = role !== undefined && role !== null
  const m = known ? { role, isOwner } : memberId ? data?.find((x) => x.id === memberId) : undefined
  if (!isClerk(m)) return null
  return (
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
  )
}
