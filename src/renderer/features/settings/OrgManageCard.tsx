import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useLocation, useNavigate } from 'react-router-dom'
import { Building2, ChevronDown, ChevronUp, KeyRound, Network, Pencil, Plus, Trash2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input, Select, Textarea } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { Field } from '@renderer/features/setup/SetupFrame'
import { useDepartments } from '@renderer/features/org/useOrgData'
import { api, errorMessage, hasAdminPin, setAdminPin } from '@renderer/lib/api'
import { useMe, useMembers, useOrgDisplay } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { displayName, type MemberDto } from '@shared/schemas/auth'
import type { DepartmentDto } from '@shared/schemas/org'
import { buildOrgTree, flattenOrg, subtreeIds, type OrgNode } from '@shared/org'

type Node = OrgNode<MemberDto>
type Editing = { edit: DepartmentDto } | { parentId: string | null }

const indent = (depth: number): string => '  '.repeat(depth)

function DeptDialog({ state, depts, members, onClose, onSaved }: { state: Editing; depts: Node[]; members: MemberDto[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const edit = 'edit' in state ? state.edit : null
  const [f, setF] = useState({
    name: edit?.name ?? '',
    parentId: edit ? (edit.parentId ?? '') : ('parentId' in state ? (state.parentId ?? '') : ''),
    headId: edit?.headId ?? '',
    phone: edit?.phone ?? '',
    location: edit?.location ?? '',
    duties: edit?.duties ?? ''
  })
  const [err, setErr] = useState('')
  const set = (k: keyof typeof f, v: string): void => setF((p) => ({ ...p, [k]: v }))
  // a department cannot be put under itself or under one of its own
  const below = useMemo(() => (edit ? subtreeIds(depts.map((n) => n.dept), edit.id) : new Set<string>()), [edit, depts])
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name.trim(), parentId: f.parentId || null, headId: f.headId || null, phone: f.phone, location: f.location, duties: f.duties }
      return edit ? api.patch(`/api/admin/departments/${edit.id}`, body) : api.post('/api/admin/departments', body)
    },
    onSuccess: () => {
      onSaved()
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  // people of the department first: the head is usually one of them
  const candidates = [...members].sort((a, b) => Number(b.deptId === edit?.id) - Number(a.deptId === edit?.id) || a.name.localeCompare(b.name, 'ko'))
  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '부서 수정' : '부서 추가'}
      footer={
        <Button onClick={() => save.mutate()} disabled={!f.name.trim() || save.isPending}>
          저장
        </Button>
      }
    >
      <div className="space-y-3" data-testid="dept-dialog">
        <div className="grid grid-cols-2 gap-3">
          <Field label="부서 이름">
            <Input aria-label="부서 이름" value={f.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="상위 부서">
            <Select aria-label="상위 부서" value={f.parentId} onChange={(e) => set('parentId', e.target.value)}>
              <option value="">(최상위)</option>
              {depts
                .filter((n) => !below.has(n.dept.id))
                .map((n) => (
                  <option key={n.dept.id} value={n.dept.id}>
                    {indent(n.depth)}
                    {n.dept.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Field label="부서장" hint="조직도에서 부서 맨 앞에 강조해 표시됩니다.">
            <Select aria-label="부서장" value={f.headId} onChange={(e) => set('headId', e.target.value)}>
              <option value="">(없음)</option>
              {candidates.map((m) => (
                <option key={m.id} value={m.id}>
                  {displayName(m)}
                  {m.title ? ` · ${m.title}` : ''}
                  {m.deptName ? ` (${m.deptName})` : ''}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="대표 전화·내선">
            <Input aria-label="대표 전화·내선" value={f.phone} maxLength={40} onChange={(e) => set('phone', e.target.value)} placeholder="예: 02-123-4567, 내선 1200" />
          </Field>
          <Field label="위치">
            <Input aria-label="위치" value={f.location} maxLength={60} onChange={(e) => set('location', e.target.value)} placeholder="예: 본관 2층" />
          </Field>
        </div>
        <Field label="담당 업무" hint="부서가 맡은 일을 간단히 적습니다. 조직도의 부서 칸에 표시됩니다.">
          <Textarea aria-label="부서 담당 업무" value={f.duties} maxLength={500} onChange={(e) => set('duties', e.target.value)} />
        </Field>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

/**
 * 설정 → 조직 관리: the department tree and who belongs where. Shown only on the server PC
 * (the 최종관리자); the server refuses these changes to everybody else.
 */
export function OrgManageCard(): React.JSX.Element | null {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()
  const online = useConn((s) => s.state === 'online')
  const { data: me } = useMe()
  const members = useMembers()
  const depts = useDepartments()
  const org = useOrgDisplay()
  const ref = useRef<HTMLDivElement>(null)
  const [dialog, setDialog] = useState<Editing | null>(null)
  const [err, setErr] = useState('')
  const [pin, setPin] = useState('')
  const [unlocked, setUnlocked] = useState(hasAdminPin())

  const owner = me?.isOwner === true
  const focus = (location.state as { focus?: string } | null)?.focus === 'org'
  useEffect(() => {
    if (owner && focus) ref.current?.scrollIntoView({ block: 'start' })
  }, [owner, focus])

  const people = useMemo(() => members.data ?? [], [members.data])
  const tree = useMemo(() => buildOrgTree(depts.data ?? [], people), [depts.data, people])
  const flat = useMemo(() => flattenOrg(tree.roots), [tree])

  const done = {
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['members'] })
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
    onError: (e: unknown) => setErr(errorMessage(e))
  }
  const delDept = useMutation({ mutationFn: (id: string) => api.del(`/api/admin/departments/${id}`), ...done })
  const orderDepts = useMutation({ mutationFn: (body: { parentId: string | null; ids: string[] }) => api.put('/api/admin/departments/order', body), ...done })
  const patchMember = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/admin/org/members/${id}`, body), ...done })
  const orderMembers = useMutation({ mutationFn: (body: { deptId: string | null; ids: string[] }) => api.put('/api/admin/org/members/order', body), ...done })

  if (!owner) return null

  const needPin = !!me?.adminPinSet && !unlocked
  const checkPin = async (): Promise<void> => {
    setAdminPin(pin)
    try {
      await api.post('/api/admin/pin-check')
      setErr('')
      setUnlocked(true)
    } catch (e) {
      setAdminPin('')
      setErr(errorMessage(e))
    }
  }

  const siblingsOf = (n: Node): Node[] => (n.dept.parentId ? (flat.find((x) => x.dept.id === n.dept.parentId)?.children ?? tree.roots) : tree.roots)
  const moveDept = (n: Node, step: -1 | 1): void => {
    const ids = siblingsOf(n).map((x) => x.dept.id)
    const i = ids.indexOf(n.dept.id)
    const j = i + step
    if (i < 0 || j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    orderDepts.mutate({ parentId: n.dept.parentId ?? null, ids })
  }
  const moveMember = (list: MemberDto[], deptId: string | null, i: number, step: -1 | 1): void => {
    const ids = list.map((m) => m.id)
    const j = i + step
    if (j < 0 || j >= ids.length) return
    ;[ids[i], ids[j]] = [ids[j], ids[i]]
    orderMembers.mutate({ deptId, ids })
  }
  const removeDept = (n: Node): void => {
    if (n.members.length) return setErr(`${n.dept.name}에 소속 구성원이 있어 지울 수 없습니다. 먼저 아래 "구성원 배치"에서 구성원의 부서를 바꾸세요.`)
    const note = n.children.length ? ' 하위 부서는 지워지지 않고 한 단계 위로 올라갑니다.' : ''
    if (window.confirm(`${n.dept.name} 부서를 지울까요?${note}`)) delDept.mutate(n.dept.id)
  }

  const groups: { key: string; deptId: string | null; name: string; headId: string | null; list: MemberDto[] }[] = [
    ...flat.filter((n) => n.members.length).map((n) => ({ key: n.dept.id, deptId: n.dept.id, name: `${indent(n.depth)}${n.dept.name}`, headId: n.dept.headId ?? null, list: n.members })),
    ...(tree.unassigned.length ? [{ key: 'none', deptId: null, name: '부서 미지정', headId: null, list: tree.unassigned }] : [])
  ]

  return (
    <div ref={ref}>
    <Card data-testid="org-manage-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Network className="size-4" /> 조직 관리 <Badge variant="important">최종관리자(서버 PC) 전용</Badge>
        </CardTitle>
        <Button size="sm" variant="ghost" onClick={() => navigate('/org')}>
          조직도 보기
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">부서와 구성원 배치를 정합니다. 바꾸면 모든 팀원의 조직도·주소록에 바로 반영됩니다. 이 설정은 서버 PC에서만 보이고, 다른 PC에서는 바꿀 수 없습니다.</p>
        {err && <p className="text-sm text-urgent">{err}</p>}
        {!online ? (
          <p className="text-sm text-muted-foreground">서버가 실행 중일 때 바꿀 수 있습니다.</p>
        ) : needPin ? (
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-muted-foreground" />
            <span className="text-sm">관리 PIN을 입력하세요.</span>
            <Input aria-label="관리 PIN" type="password" inputMode="numeric" className="w-36" value={pin} onChange={(e) => setPin(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void checkPin()} />
            <Button size="sm" onClick={() => void checkPin()}>
              확인
            </Button>
          </div>
        ) : (
          <>
            <section className="space-y-1.5">
              <div className="text-sm font-medium">맨 위 (기관·팀 이름)</div>
              <div className="flex items-center gap-3 rounded-md border border-border px-3 py-2 text-sm">
                <Building2 className="size-4 shrink-0 text-primary" />
                <span className="min-w-0 flex-1 truncate">{[org.orgName, org.teamName].filter(Boolean).join(' · ') || '(이름 없음)'}</span>
                <Button size="sm" variant="outline" onClick={() => navigate('/admin/settings')}>
                  이름 바꾸기
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">조직도 맨 위 칸에 표시됩니다. 관리 → 조직·운영 설정의 조직 정보에서 바꿉니다.</p>
            </section>

            <section className="space-y-1.5">
              <div className="flex items-center gap-2">
                <div className="text-sm font-medium">부서 ({flat.length})</div>
                <Button size="sm" className="ml-auto" onClick={() => setDialog({ parentId: null })}>
                  <Plus /> 부서 추가
                </Button>
              </div>
              {flat.length === 0 ? (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-center text-sm text-muted-foreground">부서가 없습니다. 부서 추가를 눌러 만드세요.</p>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {flat.map((n) => {
                    const sib = siblingsOf(n)
                    const i = sib.findIndex((x) => x.dept.id === n.dept.id)
                    return (
                      <div key={n.dept.id} className="flex items-center gap-1 px-2 py-1 text-sm" data-testid={`org-dept-row-${n.dept.name}`}>
                        <Button size="icon-sm" variant="ghost" aria-label={`${n.dept.name} 위로`} disabled={i <= 0} onClick={() => moveDept(n, -1)}>
                          <ChevronUp />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`${n.dept.name} 아래로`} disabled={i < 0 || i >= sib.length - 1} onClick={() => moveDept(n, 1)}>
                          <ChevronDown />
                        </Button>
                        <span className="min-w-0 flex-1 truncate" style={{ paddingLeft: `${n.depth * 1.25}rem` }}>
                          {n.depth > 0 && <span className="text-muted-foreground">└ </span>}
                          <b>{n.dept.name}</b>
                          <span className="ml-2 text-xs text-muted-foreground">
                            {[n.head && `부서장 ${n.head.name}`, n.dept.phone, n.dept.location, `${n.members.length}명${n.total !== n.members.length ? ` (하위 포함 ${n.total}명)` : ''}`].filter(Boolean).join(' · ')}
                          </span>
                        </span>
                        <Button size="sm" variant="ghost" aria-label={`${n.dept.name} 아래에 부서 추가`} title="이 부서 아래에 부서를 추가합니다" onClick={() => setDialog({ parentId: n.dept.id })}>
                          <Plus /> 하위
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`${n.dept.name} 수정`} onClick={() => setDialog({ edit: n.dept })}>
                          <Pencil />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`${n.dept.name} 삭제`} onClick={() => removeDept(n)}>
                          <Trash2 />
                        </Button>
                      </div>
                    )
                  })}
                </div>
              )}
              <p className="text-xs text-muted-foreground">▲▼로 같은 상위 부서 안에서 순서를 바꿉니다. 부서장·대표 전화·위치·담당 업무·상위 부서는 ✏(수정)에서 정합니다.</p>
            </section>

            <section className="space-y-1.5">
              <div className="text-sm font-medium">구성원 배치 ({people.length}명)</div>
              <div className="space-y-2">
                {groups.map((g) => (
                  <div key={g.key} className="rounded-md border border-border">
                    <div className="border-b border-border bg-muted px-3 py-1 text-xs font-semibold">
                      {g.name} <span className="font-normal text-muted-foreground">{g.list.length}명</span>
                    </div>
                    <div className="divide-y divide-border">
                      {g.list.map((m, i) => (
                        <div key={m.id} className="flex items-center gap-1 px-2 py-1 text-sm" data-testid={`org-member-row-${m.name}`}>
                          <Button size="icon-sm" variant="ghost" aria-label={`${m.name} 위로`} disabled={i === 0 || m.id === g.headId || g.list[i - 1]?.id === g.headId} onClick={() => moveMember(g.list, g.deptId, i, -1)}>
                            <ChevronUp />
                          </Button>
                          <Button size="icon-sm" variant="ghost" aria-label={`${m.name} 아래로`} disabled={i === g.list.length - 1 || m.id === g.headId} onClick={() => moveMember(g.list, g.deptId, i, 1)}>
                            <ChevronDown />
                          </Button>
                          <span className="flex w-36 shrink-0 items-center gap-1 truncate">
                            {displayName(m)}
                            {m.id === g.headId && <Badge>부서장</Badge>}
                          </span>
                          <Select aria-label={`${m.name} 부서`} className="h-8 min-w-0 flex-1" value={m.deptId && flat.some((n) => n.dept.id === m.deptId) ? m.deptId : ''} onChange={(e) => patchMember.mutate({ id: m.id, body: { deptId: e.target.value || null } })}>
                            <option value="">부서 미지정</option>
                            {flat.map((n) => (
                              <option key={n.dept.id} value={n.dept.id}>
                                {indent(n.depth)}
                                {n.dept.name}
                              </option>
                            ))}
                          </Select>
                          <Input
                            key={`t:${m.title ?? ''}`}
                            aria-label={`${m.name} 직위`}
                            className="h-8 w-28 shrink-0"
                            placeholder="직위"
                            maxLength={40}
                            defaultValue={m.title ?? ''}
                            onBlur={(e) => e.target.value.trim() !== (m.title ?? '') && patchMember.mutate({ id: m.id, body: { title: e.target.value.trim() || null } })}
                          />
                          <Input
                            key={`r:${m.rank ?? ''}`}
                            aria-label={`${m.name} 직급`}
                            className="h-8 w-24 shrink-0"
                            placeholder="직급"
                            maxLength={40}
                            defaultValue={m.rank ?? ''}
                            onBlur={(e) => e.target.value.trim() !== (m.rank ?? '') && patchMember.mutate({ id: m.id, body: { rank: e.target.value.trim() || null } })}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                칸마다 부서 · 직위(예: 팀장) · 직급(예: 6급)입니다. 직위·직급은 입력하고 칸 밖을 누르면 저장됩니다. 조직도에는 부서장이 맨 앞에, 나머지는 여기서 ▲▼로 정한 순서대로 나옵니다. 여기서 정한 부서·직위는 그 팀원이 스스로 바꿀 수 없게 됩니다.
              </p>
            </section>
          </>
        )}
      </CardContent>
      {dialog && <DeptDialog state={dialog} depts={flat} members={people} onClose={() => setDialog(null)} onSaved={done.onSuccess} />}
    </Card>
    </div>
  )
}
