import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Card } from '@renderer/components/ui/card'
import type { HolidayDto } from '@shared/schemas/events'

/** Admin: built-in Korean holidays plus organization days off (6.3 공휴일). */
export function HolidaysTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [year, setYear] = useState(new Date().getFullYear())
  const [date, setDate] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['events', 'holidays', 'admin', year], queryFn: () => api.get<HolidayDto[]>('/api/holidays', { from: `${year}-01-01`, to: `${year}-12-31` }) })
  const done = {
    onSuccess: () => {
      setErr('')
      void qc.invalidateQueries({ queryKey: ['events'] })
    },
    onError: (e: unknown) => setErr(errorMessage(e))
  }
  const add = useMutation({ mutationFn: () => api.put(`/api/admin/holidays/${date}`, { name }), ...done })
  const del = useMutation({ mutationFn: (d: string) => api.del(`/api/admin/holidays/${d}`), ...done })
  return (
    <div className="max-w-2xl space-y-4">
      <p className="text-sm text-muted-foreground">기본으로 들어 있는 공휴일을 확인하고, 기관 휴일(창립기념일 등)을 추가하거나 잘못된 날을 지웁니다. 달력에 붉게 표시됩니다.</p>
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => setYear(year - 1)}>
          ◀
        </Button>
        <span className="w-16 text-center font-semibold">{year}년</span>
        <Button size="sm" variant="outline" onClick={() => setYear(year + 1)}>
          ▶
        </Button>
      </div>
      <div className="flex items-end gap-2">
        <Input aria-label="휴일 날짜" type="date" className="w-44" value={date} onChange={(e) => setDate(e.target.value)} />
        <Input aria-label="휴일 이름" placeholder="휴일 이름" value={name} onChange={(e) => setName(e.target.value)} />
        <Button onClick={() => add.mutate()} disabled={!date || !name.trim()}>
          <Plus /> 추가·수정
        </Button>
      </div>
      {err && <p className="text-sm text-urgent">{err}</p>}
      <Card className="divide-y divide-border">
        {(q.data ?? []).map((h) => (
          <div key={h.date} className="flex items-center gap-3 px-4 py-1.5 text-sm">
            <span className="w-28 text-muted-foreground">{h.date}</span>
            <span className="flex-1">{h.name}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`${h.name} 삭제`} onClick={() => window.confirm(`${h.date} ${h.name}을(를) 지울까요?`) && del.mutate(h.date)}>
              <Trash2 />
            </Button>
          </div>
        ))}
        {q.data?.length === 0 && <p className="px-4 py-3 text-sm text-muted-foreground">이 해의 공휴일 정보가 없습니다. 직접 추가하세요.</p>}
      </Card>
    </div>
  )
}
