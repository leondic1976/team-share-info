import { ShieldCheck } from 'lucide-react'
import { useMe } from '@renderer/lib/queries'

/**
 * Two admin tiers: the 최종관리자 is the server PC itself, every other admin is a 서무.
 * Data storage and critical settings are the 최종관리자's; the server refuses them to a 서무
 * (403 OWNER_ONLY), so the screens hide or disable those controls. A server older than the
 * two tiers says nothing about it: every admin can do everything there.
 */
export function useIsOwner(): boolean {
  const { data: me } = useMe()
  return me?.isOwner !== false
}

export function OwnerOnlyNote({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p className="flex items-start gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground" data-testid="owner-only-note">
      <ShieldCheck className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}
