import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { MemberDto } from '@shared/schemas/auth'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Select, Textarea } from '@renderer/components/ui/input'
import { Dialog } from '@renderer/components/Dialog'
import { Field } from '@renderer/features/setup/SetupFrame'

/**
 * The admin corrects what a member entered (name, department, title, numbers, duty).
 * What is saved here takes priority: the member can no longer change those details, and
 * everybody sees the new values at once. The nickname is the member's own and is not here.
 */
export function MemberEditDialog({ member, onClose }: { member: MemberDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const depts = useQuery({ queryKey: ['members', 'departments'], queryFn: () => api.get<{ id: string; name: string }[]>('/api/departments') })
  const first = { name: member.name, deptId: member.deptId ?? '', title: member.title ?? '', ext: member.ext ?? '', mobile: member.mobile ?? '', duty: member.duty ?? '' }
  const [f, setF] = useState(first)
  const [err, setErr] = useState('')
  const set = (k: keyof typeof first, v: string): void => setF({ ...f, [k]: v })
  const save = useMutation({
    mutationFn: () => {
      // only what was changed is sent, so only those details become "set by the admin"
      const body: Record<string, string | null> = {}
      for (const k of Object.keys(first) as (keyof typeof first)[]) if (f[k].trim() !== first[k]) body[k] = k === 'name' ? f[k].trim() : f[k].trim() || null
      if (!Object.keys(body).length) return Promise.resolve(null)
      return api.patch(`/api/admin/members/${member.id}`, body)
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
      void qc.invalidateQueries({ queryKey: ['me'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${member.name} 정보 수정`}
      width="max-w-lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => (f.name.trim() ? save.mutate() : setErr('이름을 입력하세요.'))} disabled={save.isPending}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="이름">
            <Input aria-label="구성원 이름" value={f.name} maxLength={40} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="부서">
            <Select aria-label="구성원 부서" value={f.deptId} onChange={(e) => set('deptId', e.target.value)}>
              <option value="">미지정</option>
              {(depts.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="직위">
            <Input aria-label="구성원 직위" value={f.title} maxLength={40} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="내선번호">
            <Input aria-label="구성원 내선번호" value={f.ext} maxLength={20} onChange={(e) => set('ext', e.target.value)} />
          </Field>
          <Field label="휴대폰">
            <Input aria-label="구성원 휴대폰" value={f.mobile} maxLength={20} onChange={(e) => set('mobile', e.target.value)} />
          </Field>
        </div>
        <Field label="담당 업무">
          <Textarea aria-label="구성원 담당 업무" value={f.duty} maxLength={200} onChange={(e) => set('duty', e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">
          여기서 고친 항목은 서버 PC의 값이 우선합니다. 저장하면 모든 팀원 화면에 바로 반영되고, 그 구성원은 고친 항목을 스스로 바꿀 수 없게 됩니다. 별명{member.nickname ? `(${member.nickname})` : ''}은 본인만
          정할 수 있습니다. 기관·팀 이름은 <b>설정 → 조직 정보</b>에서 바꿉니다.
        </p>
        {err && (
          <p className="text-sm text-urgent" role="alert">
            {err}
          </p>
        )}
      </div>
    </Dialog>
  )
}
