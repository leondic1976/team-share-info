import { useNavigate } from 'react-router-dom'
import { useMe, useOrgDisplay } from '@renderer/lib/queries'
import { useSpace } from './space-store'

/**
 * Top bar: "기관 · 팀명 › 그룹명". The group shown is the current space (sidebar
 * switcher); in the team space it is left out. Clicking the group opens Groups.
 */
export function OrgBadge(): React.JSX.Element | null {
  const navigate = useNavigate()
  const { orgName, teamName } = useOrgDisplay()
  const { data: me } = useMe()
  const space = useSpace((s) => s.space)
  const group = me?.groups.find((g) => g.id === space)
  if (!teamName && !orgName) return null
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-l border-border pl-3 text-sm" data-testid="org-badge">
      {orgName && <span className="hidden truncate text-muted-foreground lg:inline">{orgName}</span>}
      {orgName && teamName && <span className="hidden text-muted-foreground lg:inline">·</span>}
      <span className="truncate font-semibold" data-testid="team-name">
        {teamName}
      </span>
      {group && (
        <>
          <span className="text-muted-foreground">›</span>
          <button className="flex min-w-0 cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 hover:bg-muted" title="그룹 보기" onClick={() => navigate('/groups')} data-testid="group-name">
            <span className="size-2.5 shrink-0 rounded-full" style={{ background: group.color }} aria-hidden />
            <span className="truncate font-semibold">{group.name}</span>
          </button>
        </>
      )}
    </div>
  )
}
