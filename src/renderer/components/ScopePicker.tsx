import { useMemo, useState } from 'react'
import { Users, UsersRound, User, Search, X } from 'lucide-react'
import type { ScopeInput } from '@shared/schemas/scope'
import { displayName } from '@shared/schemas/auth'
import { useMe, useMembers } from '@renderer/lib/queries'
import { Input } from './ui/input'
import { cn } from '@renderer/lib/utils'
import { affiliationText } from '@shared/org'
import { RoleMark } from './RoleMark'
import { PresenceDot, PRESENCE_LABEL } from './PresenceDot'
import { byPresence } from '@shared/presence'
import { matchesHangul } from '@shared/hangul'

export function defaultScope(space: string): ScopeInput {
  return space === 'team' ? { type: 'team', groupIds: [], memberIds: [] } : { type: 'group', groupIds: [space], memberIds: [] }
}

export function scopeIsValid(s: ScopeInput): boolean {
  if (s.type === 'group') return s.groupIds.length > 0
  if (s.type === 'members') return s.memberIds.length > 0
  return true
}

/** Choose who can see a shared item (6.2 ③): team / my groups / selected people. */
export function ScopePicker({ value, onChange, initial }: { value: ScopeInput; onChange: (s: ScopeInput) => void; initial?: ScopeInput }): React.JSX.Element {
  const { data: me } = useMe()
  const groups = me?.groups ?? []
  const opts: { type: ScopeInput['type']; label: string; icon: typeof Users }[] = [
    { type: 'team', label: '팀 전체', icon: Users },
    { type: 'group', label: '그룹', icon: UsersRound },
    { type: 'members', label: '지정한 사람', icon: User }
  ]
  // Widening the audience (group/members -> team) asks for confirmation (12장 위험 대응).
  const choose = (type: ScopeInput['type']): void => {
    const base = initial ?? value
    if (type === 'team' && base.type !== 'team' && !window.confirm('공개 범위를 팀 전체로 넓힙니다. 계속할까요?')) return
    onChange({ ...value, type })
  }
  return (
    <div className="space-y-2" data-testid="scope-picker">
      <div className="flex gap-1.5" role="radiogroup" aria-label="공개 범위">
        {opts.map((o) => (
          <button
            key={o.type}
            type="button"
            role="radio"
            aria-checked={value.type === o.type}
            onClick={() => choose(o.type)}
            className={cn(
              'flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm',
              value.type === o.type ? 'border-primary bg-primary/10 font-semibold text-primary' : 'border-border hover:bg-muted'
            )}
          >
            <o.icon className="size-4" /> {o.label}
          </button>
        ))}
      </div>
      {value.type === 'group' &&
        (groups.length ? (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => {
              const on = value.groupIds.includes(g.id)
              return (
                <label key={g.id} className={cn('flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-sm', on ? 'border-transparent text-white' : 'border-border')} style={on ? { background: g.color } : undefined}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={on}
                    aria-label={`그룹 ${g.name}`}
                    onChange={() => onChange({ ...value, groupIds: on ? value.groupIds.filter((x) => x !== g.id) : [...value.groupIds, g.id] })}
                  />
                  {!on && <span className="size-2 rounded-full" style={{ background: g.color }} />}
                  {g.name}
                </label>
              )
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">속한 그룹이 없습니다. 그룹 메뉴에서 그룹을 만들거나 가입하세요.</p>
        ))}
      {value.type === 'members' && <MemberPicker value={value.memberIds} onChange={(ids) => onChange({ ...value, memberIds: ids })} excludeSelf />}
    </div>
  )
}

/**
 * `presence`: show each person's state (dot + label, as on 홈 팀원 현황) and list the ones here
 * first, as the messenger's pickers do (새 대화, 쪽지 쓰기, 대화 상대 추가).
 */
export function MemberPicker({
  value,
  onChange,
  excludeSelf,
  selectAll,
  presence
}: {
  value: string[]
  onChange: (ids: string[]) => void
  excludeSelf?: boolean
  selectAll?: boolean
  presence?: boolean
}): React.JSX.Element {
  const { data: members } = useMembers()
  const { data: me } = useMe()
  const [q, setQ] = useState('')
  const list = useMemo(() => {
    const shown = (members ?? [])
      .filter((m) => !excludeSelf || m.id !== me?.id)
      .filter((m) => matchesHangul(`${m.name} ${m.nickname ?? ''} ${affiliationText(m)}`, q))
    return presence ? [...shown].sort(byPresence) : shown
  }, [members, me, q, excludeSelf, presence])
  const selected = (members ?? []).filter((m) => value.includes(m.id))
  return (
    <div className="space-y-1.5">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {selected.map((m) => (
            <span key={m.id} className="flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
              {presence && <PresenceDot presence={m.presence} className="size-2" />}
              {displayName(m)}
              <RoleMark memberId={m.id} role={m.role} isOwner={m.isOwner} className="-ml-0.5" />
              <button type="button" aria-label={`${m.name} 빼기`} className="cursor-pointer" onClick={() => onChange(value.filter((x) => x !== m.id))}>
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
        <Input className="pl-8" aria-label="구성원 검색" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·부서 검색" />
      </div>
      <div className="max-h-40 overflow-y-auto rounded-md border border-border">
        {selectAll && list.length > 0 && (
          <label className="sticky top-0 flex cursor-pointer items-center gap-2 border-b border-border bg-background px-2.5 py-1.5 text-sm font-medium hover:bg-muted">
            <input
              type="checkbox"
              aria-label="전체 선택"
              checked={list.every((m) => value.includes(m.id))}
              onChange={(e) => {
                // acts on the members shown (after the search), keeps the others as they are
                const shown = new Set(list.map((m) => m.id))
                const rest = value.filter((x) => !shown.has(x))
                onChange(e.target.checked ? [...rest, ...shown] : rest)
              }}
            />
            전체 선택
            <span className="text-xs font-normal text-muted-foreground">
              {q.trim() ? '검색된 ' : ''}
              {list.length}명
            </span>
          </label>
        )}
        {list.map((m) => (
          <label key={m.id} className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 text-sm hover:bg-muted">
            <input type="checkbox" checked={value.includes(m.id)} onChange={(e) => onChange(e.target.checked ? [...value, m.id] : value.filter((x) => x !== m.id))} aria-label={m.name} />
            {presence && <PresenceDot presence={m.presence} />}
            <span>
              {displayName(m)}
              <RoleMark memberId={m.id} role={m.role} isOwner={m.isOwner} />
            </span>
            <span className="text-xs text-muted-foreground" title={affiliationText(m) || undefined}>
              {m.deptName}
            </span>
            {presence && (
              <span className="ml-auto shrink-0 text-xs text-muted-foreground" data-testid={`picker-presence-${m.name}`} data-presence={m.presence}>
                {PRESENCE_LABEL[m.presence]}
              </span>
            )}
          </label>
        ))}
        {list.length === 0 && <p className="px-2.5 py-2 text-xs text-muted-foreground">구성원이 없습니다.</p>}
      </div>
    </div>
  )
}

/** Small chips describing an item's audience, with group color tags (6.2 ④). */
export function ScopeTags({ scope }: { scope: { type: string; groups: { id: string; name: string; color: string }[]; members: { id?: string; name: string }[] } }): React.JSX.Element {
  // names as "본명(필명)", from the members list (the scope itself carries real names)
  const { data: all } = useMembers()
  const nameOf = (m: { id?: string; name: string }): string => {
    const full = m.id ? all?.find((x) => x.id === m.id) : undefined
    return full ? displayName(full) : m.name
  }
  if (scope.type === 'team') return <span className="text-xs text-muted-foreground">팀 전체</span>
  if (scope.type === 'group')
    return (
      <span className="flex flex-wrap gap-1">
        {scope.groups.map((g) => (
          <span key={g.id} className="rounded px-1.5 py-0.5 text-[0.7rem] font-medium text-white" style={{ background: g.color }}>
            {g.name}
          </span>
        ))}
      </span>
    )
  return (
    <span className="text-xs text-muted-foreground" title={scope.members.map(nameOf).join(', ')}>
      지정 {scope.members.length}명
    </span>
  )
}
