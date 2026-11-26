import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Pencil, Plus, Trash2, UserCheck, Undo2 } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { useMembers } from '@renderer/lib/queries'
import { useDepartments } from '@renderer/features/org/useOrgData'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Input, Select } from '@renderer/components/ui/input'
import { Card, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Dialog } from '@renderer/components/Dialog'
import { Field } from '@renderer/features/setup/SetupFrame'
import { UNREG_LIMITS, isListed, unregNameClash, type UnregisteredDto } from '@shared/schemas/unregistered'

/** The mark every screen shows next to the name of somebody who does not use TeamHub. */
export function UnregMark(): React.JSX.Element {
  return (
    <Badge variant="important" className="ml-1" title="TeamHub를 쓰지 않는 직원 — 관리 → 미등록 인원에 등록됨">
      미등록
    </Badge>
  )
}

type Form = { id?: string; name: string; dept: string; title: string; memo: string }

/**
 * 미등록 인원 (지시 134): the one list of staff who do not use TeamHub, used by 식사 신청 and
 * 긴급구조지휘대. The server PC and the 서무 keep it here.
 */
export function UnregisteredCard(): React.JSX.Element {
  const qc = useQueryClient()
  const list = useQuery({ queryKey: ['unregistered'], queryFn: () => api.get<UnregisteredDto[]>('/api/unregistered') })
  const members = useMembers()
  const depts = useDepartments()
  const [form, setForm] = useState<Form | null>(null)
  const [merge, setMerge] = useState<UnregisteredDto | null>(null)
  const [target, setTarget] = useState('')
  const [showOld, setShowOld] = useState(false)
  const [err, setErr] = useState('')
  const done = {
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['unregistered'] })
    },
    onError: (e: unknown) => setErr(errorMessage(e))
  }
  const save = useMutation({
    mutationFn: (f: Form) => (f.id ? api.patch(`/api/unregistered/${encodeURIComponent(f.id)}`, { name: f.name, dept: f.dept, title: f.title, memo: f.memo }) : api.post('/api/unregistered', { name: f.name, dept: f.dept, title: f.title, memo: f.memo })),
    ...done,
    onSuccess: () => {
      done.onSuccess()
      setForm(null)
    }
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/unregistered/${encodeURIComponent(id)}`), ...done })
  const link = useMutation({
    mutationFn: ({ id, memberId }: { id: string; memberId: string | null }) => api.put(`/api/unregistered/${encodeURIComponent(id)}/merge`, { memberId }),
    ...done,
    onSuccess: () => {
      done.onSuccess()
      setMerge(null)
    }
  })
  const all = list.data ?? []
  const listed = all.filter(isListed)
  const merged = all.filter((p) => !p.deleted && p.mergedInto)
  const deleted = all.filter((p) => p.deleted)
  const active = useMemo(() => (members.data ?? []).filter((m) => m.status === 'active'), [members.data])
  const clash = form ? unregNameClash(form.name, active, all, form.id) : ''
  const deptNames = [...new Set((depts.data ?? []).map((d) => d.name))]

  return (
    <Card data-testid="unregistered-card">
      <CardHeader>
        <CardTitle>
          미등록 인원 ({listed.length}) <span className="text-xs font-normal text-muted-foreground">/ {UNREG_LIMITS.max}명까지</span>
        </CardTitle>
        <Button size="sm" variant="outline" onClick={() => setForm({ name: '', dept: '', title: '', memo: '' })} data-testid="unregistered-add">
          <Plus /> 미등록 인원 추가
        </Button>
      </CardHeader>
      <p className="px-4 pb-2 text-xs text-muted-foreground">
        TeamHub를 쓰지 않는 직원입니다. 이 명단 하나를 <b>식사 신청</b>(대신 신청·통계·식대 정산)과 <b>긴급구조지휘대</b>(조원·배치·공통업무·예외자)가 함께 쓰고, 어느 화면에서나 이름 옆에 <b>미등록</b>이 붙습니다. 나중에 TeamHub에 가입하면 <b>구성원과 합치기</b>로 그 구성원의 기록으로 옮깁니다.
      </p>
      {err && <p className="px-4 pb-2 text-sm text-urgent">{err}</p>}
      {listed.length > 0 || merged.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-4 py-2">이름</th>
              <th>부서·직위</th>
              <th>메모</th>
              <th>등록</th>
              <th className="w-72" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {listed.map((p) => (
              <tr key={p.id} data-testid={`unregistered-row-${p.name}`}>
                <td className="px-4 py-2">
                  {p.name}
                  <UnregMark />
                </td>
                <td className="text-muted-foreground">{[p.dept, p.title].filter(Boolean).join(' · ')}</td>
                <td className="text-muted-foreground">{p.memo}</td>
                <td className="text-xs text-muted-foreground">
                  {p.createdByName ? `${p.createdByName} · ` : ''}
                  {format(p.createdAt, 'yyyy-MM-dd')}
                </td>
                <td className="space-x-1 pr-4 text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onClick={() => setForm({ id: p.id, name: p.name, dept: p.dept, title: p.title, memo: p.memo })}>
                    <Pencil /> 고치기
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setMerge(p)
                      setTarget(active.find((m) => m.name === p.name)?.id ?? '')
                    }}
                  >
                    <UserCheck /> 구성원과 합치기
                  </Button>
                  <Button size="sm" variant="ghost" className="text-urgent" onClick={() => window.confirm(`${p.name}을(를) 명단에서 지울까요? 식사 신청의 지난 기록에는 남고, 긴급구조지휘대에서는 "명단에서 지워짐"으로 보여 편성에서 뺄 수 있습니다.`) && del.mutate(p.id)}>
                    <Trash2 /> 삭제
                  </Button>
                </td>
              </tr>
            ))}
            {merged.map((p) => (
              <tr key={p.id} className="text-muted-foreground">
                <td className="px-4 py-2">{p.name}</td>
                <td colSpan={3}>구성원 {p.mergedIntoName ?? '(알 수 없음)'}의 기록으로 합침</td>
                <td className="pr-4 text-right">
                  <Button size="sm" variant="ghost" onClick={() => link.mutate({ id: p.id, memberId: null })}>
                    <Undo2 /> 합치기 취소
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="px-4 pb-3 text-sm text-muted-foreground">{list.isLoading ? '불러오는 중…' : '미등록 인원이 없습니다.'}</p>
      )}
      {deleted.length > 0 && (
        <div className="px-4 py-2 text-xs text-muted-foreground">
          <label className="flex cursor-pointer items-center gap-1">
            <input type="checkbox" checked={showOld} onChange={(e) => setShowOld(e.target.checked)} /> 지운 사람 보기 ({deleted.length})
          </label>
          {showOld && <p className="mt-1">{deleted.map((p) => p.name).join(', ')}</p>}
        </div>
      )}

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        title={form?.id ? '미등록 인원 고치기' : '미등록 인원 추가'}
        width="max-w-lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setForm(null)}>
              취소
            </Button>
            <Button disabled={!form?.name.trim() || save.isPending} onClick={() => form && save.mutate(form)} data-testid="unregistered-save">
              저장
            </Button>
          </>
        }
      >
        {form && (
          <div className="space-y-3">
            <Field label="이름" hint={clash === 'member' ? '같은 이름의 구성원이 있습니다. 다른 사람이면 그대로 저장하세요.' : clash === 'unregistered' ? '같은 이름의 미등록 인원이 있습니다. 다른 사람이면 그대로 저장하세요.' : undefined}>
              <Input aria-label="미등록 인원 이름" value={form.name} maxLength={UNREG_LIMITS.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="부서">
                <Input aria-label="미등록 인원 부서" list="unreg-depts" value={form.dept} maxLength={UNREG_LIMITS.dept} placeholder="고르거나 적기" onChange={(e) => setForm({ ...form, dept: e.target.value })} />
                <datalist id="unreg-depts">
                  {deptNames.map((d) => (
                    <option key={d} value={d} />
                  ))}
                </datalist>
              </Field>
              <Field label="직위">
                <Input aria-label="미등록 인원 직위" value={form.title} maxLength={UNREG_LIMITS.title} placeholder="선택" onChange={(e) => setForm({ ...form, title: e.target.value })} />
              </Field>
            </div>
            <Field label="메모">
              <Input aria-label="미등록 인원 메모" value={form.memo} maxLength={UNREG_LIMITS.memo} placeholder="선택" onChange={(e) => setForm({ ...form, memo: e.target.value })} />
            </Field>
            {err && <p className="text-sm text-urgent">{err}</p>}
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!merge}
        onClose={() => setMerge(null)}
        title={`${merge?.name ?? ''} — 구성원과 합치기`}
        width="max-w-lg"
        footer={
          <>
            <Button variant="outline" onClick={() => setMerge(null)}>
              취소
            </Button>
            <Button disabled={!target || link.isPending} onClick={() => merge && link.mutate({ id: merge.id, memberId: target })}>
              합치기
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            이 사람이 TeamHub에 가입했을 때 씁니다. 식사 신청의 기록은 그 구성원의 것으로 보이고(같은 날 양쪽에 신청이 있어도 한 번만 셈), 긴급구조지휘대의 조·배치·공통업무·예외는 그 구성원으로 옮겨집니다(그 구성원이 이미 조에 있으면 이 사람의 조·배치는 버려짐). 합치기 취소로 되돌리면 식사 기록은 다시 이 사람의 것으로 보이지만, 긴급구조지휘대에서 옮겨진 자리는 구성원에게 남습니다.
          </p>
          <Select aria-label="합칠 구성원" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">구성원 고르기</option>
            {active.map((m) => (
              <option key={m.id} value={m.id}>
                {m.deptName ? `${m.deptName} · ` : ''}
                {m.name}
              </option>
            ))}
          </Select>
          {err && <p className="text-sm text-urgent">{err}</p>}
        </div>
      </Dialog>
    </Card>
  )
}
