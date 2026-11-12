import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import type { MemberDto } from '@shared/schemas/auth'

interface Dept {
  id: string
  name: string
  parentId: string | null
  sort: number
}

/** Admin: department tree for the org chart, and assigning members to departments (6.10). */
export function DepartmentsCard({ members }: { members: MemberDto[] }): React.JSX.Element {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [parent, setParent] = useState('')
  const [err, setErr] = useState('')
  const depts = useQuery({ queryKey: ['members', 'departments'], queryFn: () => api.get<Dept[]>('/api/departments') })
  const done = {
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['members'] })
      void qc.invalidateQueries({ queryKey: ['admin'] })
    },
    onError: (e: unknown) => setErr(errorMessage(e))
  }
  const add = useMutation({ mutationFn: () => api.post('/api/admin/departments', { name, parentId: parent || null }), ...done, onSuccess: () => (setName(''), done.onSuccess()) })
  const patch = useMutation({ mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/api/admin/departments/${id}`, body), ...done })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/admin/departments/${id}`), ...done })
  const setMemberDept = useMutation({ mutationFn: ({ id, deptId }: { id: string; deptId: string | null }) => api.patch(`/api/admin/members/${id}`, { deptId }), ...done })
  const list = depts.data ?? []
  return (
    <Card>
      <CardHeader>
        <CardTitle>부서 (조직도)</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input aria-label="새 부서 이름" placeholder="새 부서 이름" value={name} onChange={(e) => setName(e.target.value)} className="w-48" />
          <Select aria-label="상위 부서" value={parent} onChange={(e) => setParent(e.target.value)} className="w-44">
            <option value="">(최상위)</option>
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </Select>
          <Button onClick={() => add.mutate()} disabled={!name.trim()}>
            <Plus /> 추가
          </Button>
        </div>
        <div className="divide-y divide-border rounded-md border border-border">
          {list.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-3 py-1.5 text-sm">
              <Input
                aria-label={`${d.name} 이름`}
                defaultValue={d.name}
                className="h-8 w-44"
                onBlur={(e) => e.target.value.trim() && e.target.value !== d.name && patch.mutate({ id: d.id, body: { name: e.target.value.trim() } })}
              />
              <span className="text-xs text-muted-foreground">상위</span>
              <Select aria-label={`${d.name} 상위 부서`} className="h-8 w-40" value={d.parentId ?? ''} onChange={(e) => patch.mutate({ id: d.id, body: { parentId: e.target.value || null } })}>
                <option value="">(최상위)</option>
                {list
                  .filter((x) => x.id !== d.id)
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
              </Select>
              <span className="text-xs text-muted-foreground">순서</span>
              <Input aria-label={`${d.name} 순서`} type="number" defaultValue={d.sort} className="h-8 w-16" onBlur={(e) => Number(e.target.value) !== d.sort && patch.mutate({ id: d.id, body: { sort: Number(e.target.value) || 0 } })} />
              <span className="ml-auto text-xs text-muted-foreground">{members.filter((m) => m.deptId === d.id).length}명</span>
              <Button size="icon-sm" variant="ghost" aria-label={`${d.name} 삭제`} onClick={() => window.confirm(`${d.name} 부서를 지울까요?`) && del.mutate(d.id)}>
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 text-sm font-medium">구성원 부서 지정</div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {members.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm">
                <span className="w-24 truncate">{m.name}</span>
                <Select aria-label={`${m.name} 부서`} className="h-8" value={m.deptId ?? ''} onChange={(e) => setMemberDept.mutate({ id: m.id, deptId: e.target.value || null })}>
                  <option value="">미지정</option>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </Select>
              </label>
            ))}
          </div>
        </div>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </CardContent>
    </Card>
  )
}
