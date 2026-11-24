import type { ReactNode, SyntheticEvent } from 'react'
import { useConn } from '@renderer/app/conn-store'
import { openChatWith } from '@renderer/features/chat/dock-store'
import { cn } from '@renderer/lib/utils'

/**
 * A member's name that opens the 1:1 conversation with them in a small messenger window.
 * My own name (or an unknown member) is plain text. It is a span with the link role, not a
 * button, because names also sit inside clickable rows and cards.
 */
export function MemberLink({
  memberId,
  name,
  className,
  children,
  onOpen
}: {
  memberId: string | null | undefined
  name: string
  className?: string
  /** shown instead of the name (e.g. an icon) */
  children?: ReactNode
  /** called after the window was asked for (e.g. to close the dialog the name is in) */
  onOpen?: () => void
}): React.JSX.Element {
  const meId = useConn((s) => s.memberId)
  const label = children ?? name
  if (!memberId || memberId === meId) return <span className={className}>{label}</span>
  const go = (e: SyntheticEvent): void => {
    e.preventDefault()
    e.stopPropagation()
    void openChatWith(memberId)
    onOpen?.()
  }
  return (
    <span
      role="link"
      tabIndex={0}
      title="메신저 열기"
      data-member-link={name}
      className={cn('cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-1 focus-visible:outline-primary', className)}
      onClick={go}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && go(e)}
    >
      {label}
    </span>
  )
}
