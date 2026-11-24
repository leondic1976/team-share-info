import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ListOrdered, Network } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { useMembers } from '@renderer/lib/queries'
import { useDepartments } from '@renderer/features/org/useOrgData'
import { displayName } from '@shared/schemas/auth'
import { Button } from '@renderer/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { useMe } from '@renderer/lib/queries'

/**
 * Departments used to be managed here. They now live in one place, 설정 → 조직 관리, which
 * only the server PC (최종관리자) has; this card only points there.
 */
export function DepartmentsCard(): React.JSX.Element {
  const navigate = useNavigate()
  const { data: me } = useMe()
  return (
    <Card data-testid="departments-moved">
      <CardHeader>
        <CardTitle>부서 (조직도)</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-center gap-3 text-sm">
        <p className="min-w-0 flex-1 text-muted-foreground">
          부서 추가·삭제, 부서장, 구성원 배치(부서·직위·직급)는 <b className="text-foreground">설정 → 조직 관리</b>에서 합니다. 최종관리자(서버 PC)만 할 수 있습니다.
        </p>
        <Button size="sm" variant="outline" onClick={() => navigate('/org')}>
          <Network /> 조직도 보기
        </Button>
        {me?.isOwner === true && (
          <Button size="sm" onClick={() => navigate('/settings', { state: { focus: 'org' } })}>
            조직 관리 열기
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * 관리 → 구성원: the order of the people within each department. The 최종관리자 and every 서무
 * may set it; 근무현황, 주소록, 조직도 and every other list of members follow it.
 */
export function MemberOrderCard(): React.JSX.Element {
  const qc = useQueryClient()
  const { data: members } = useMembers()
  const { data: depts } = useDepartments()
  const [open, setOpen] = useState<string>('')
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: (v: { deptId: string | null; ids: string[] }) => api.put('/api/admin/org/members/order', v),
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['members'] })
      void qc.invalidateQueries({ queryKey: ['events'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const active = (members ?? []).filter((m) => m.status === 'active')
  // departments in tree order, then the people without one
  const rows: { id: string | null; name: string; depth: number }[] = []
  const walk = (parent: string | null, depth: number): void => {
    for (const d of (depts ?? []).filter((x) => (x.parentId ?? null) === parent).sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))) {
      rows.push({ id: d.id, name: d.name, depth })
      walk(d.id, depth + 1)
    }
  }
  walk(null, 0)
  const known = new Set(rows.map((r) => r.id))
  if (active.some((m) => !m.deptId || !known.has(m.deptId))) rows.push({ id: null, name: '부서 미지정', depth: 0 })
  const of = (id: string | null): typeof active => active.filter((m) => (id === null ? !m.deptId || !known.has(m.deptId) : m.deptId === id))
  const move = (deptId: string | null, list: typeof active, i: number, by: number): void => {
    const ids = list.map((m) => m.id)
    const j = i + by
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    save.mutate({ deptId, ids })
  }
  return (
    <Card data-testid="member-order">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ListOrdered className="size-4" /> 부서별 구성원 순서
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">부서를 눌러 펼친 뒤 ▲▼로 순서를 정합니다. 근무현황·주소록·조직도 등 구성원이 나오는 모든 화면이 이 순서를 따릅니다. 최종관리자와 서무가 정할 수 있습니다.</p>
        {rows.map((r) => {
          const list = of(r.id)
          const key = r.id ?? '-'
          return (
            <div key={key} className="rounded-md border border-border" style={{ marginLeft: r.depth * 14 }}>
              <button className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-medium hover:bg-muted" aria-expanded={open === key} onClick={() => setOpen(open === key ? '' : key)}>
                {r.name}
                <span className="text-xs font-normal text-muted-foreground">{list.length}명</span>
                <span className="ml-auto truncate text-xs font-normal text-muted-foreground">{open === key ? '접기' : list.map((m) => m.name).join(' · ')}</span>
              </button>
              {open === key && (
                <ol className="divide-y divide-border border-t border-border">
                  {list.map((m, i) => (
                    <li key={m.id} className="flex items-center gap-2 px-3 py-1" data-testid={`order-row-${m.name}`}>
                      <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">
                        {displayName(m)} <span className="text-xs text-muted-foreground">{m.title}</span>
                      </span>
                      <Button size="icon-sm" variant="ghost" aria-label={`${m.name} 위로`} disabled={i === 0 || save.isPending} onClick={() => move(r.id, list, i, -1)}>
                        <ArrowUp />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`${m.name} 아래로`} disabled={i === list.length - 1 || save.isPending} onClick={() => move(r.id, list, i, 1)}>
                        <ArrowDown />
                      </Button>
                    </li>
                  ))}
                  {!list.length && <li className="px-3 py-1.5 text-xs text-muted-foreground">구성원이 없습니다</li>}
                </ol>
              )}
            </div>
          )
        })}
        {err && <p className="text-urgent">{err}</p>}
      </CardContent>
    </Card>
  )
}
