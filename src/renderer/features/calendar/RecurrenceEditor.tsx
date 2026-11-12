import { buildRule, parseRule, type SimpleRule } from '@shared/recurrence'
import { Input, Select } from '@renderer/components/ui/input'
import { fromInputValue, toInputValue } from '@renderer/lib/dates'
import { cn } from '@renderer/lib/utils'

const DAYS = ['월', '화', '수', '목', '금', '토', '일']

/** Simple recurrence editor -> RRULE string (6.4: 매일/매주/매월/매년, 종료 조건). */
export function RecurrenceEditor({ value, onChange, startAt }: { value: string | null; onChange: (rule: string | null) => void; startAt: number }): React.JSX.Element {
  const r = parseRule(value)
  const set = (patch: Partial<SimpleRule>): void => {
    const next = { ...r, ...patch }
    if (next.freq === 'weekly' && !next.byWeekday.length) next.byWeekday = [(new Date(startAt).getDay() + 6) % 7]
    onChange(buildRule(next))
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="반복" className="w-36" value={r.freq} onChange={(e) => set({ freq: e.target.value as SimpleRule['freq'] })}>
          <option value="none">반복 안 함</option>
          <option value="daily">매일</option>
          <option value="weekdays">평일 매일</option>
          <option value="weekly">매주</option>
          <option value="monthly">매월(같은 날짜)</option>
          <option value="yearly">매년</option>
        </Select>
        {['daily', 'weekly', 'monthly', 'yearly'].includes(r.freq) && (
          <label className="flex items-center gap-1 text-sm">
            <Input aria-label="반복 간격" className="w-16" type="number" min={1} max={30} value={r.interval} onChange={(e) => set({ interval: Math.max(1, Number(e.target.value) || 1) })} />
            {{ daily: '일', weekly: '주', monthly: '개월', yearly: '년' }[r.freq as 'daily']}마다
          </label>
        )}
      </div>
      {r.freq === 'weekly' && (
        <div className="flex gap-1" role="group" aria-label="반복 요일">
          {DAYS.map((d, i) => {
            const on = r.byWeekday.includes(i)
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => set({ byWeekday: on ? r.byWeekday.filter((x) => x !== i) : [...r.byWeekday, i].sort() })}
                className={cn('size-8 cursor-pointer rounded-full border text-sm', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border')}
              >
                {d}
              </button>
            )
          })}
        </div>
      )}
      {r.freq !== 'none' && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>종료</span>
          <Select
            aria-label="반복 종료"
            className="w-32"
            value={r.end.type}
            onChange={(e) => {
              const t = e.target.value
              set({ end: t === 'count' ? { type: 'count', count: 10 } : t === 'until' ? { type: 'until', date: startAt + 30 * 86400000 } : { type: 'never' } })
            }}
          >
            <option value="never">계속</option>
            <option value="until">날짜까지</option>
            <option value="count">횟수</option>
          </Select>
          {r.end.type === 'until' && (
            <Input aria-label="반복 종료 날짜" type="date" className="w-40" value={toInputValue(r.end.date, true)} onChange={(e) => e.target.value && set({ end: { type: 'until', date: fromInputValue(e.target.value) } })} />
          )}
          {r.end.type === 'count' && (
            <label className="flex items-center gap-1">
              <Input aria-label="반복 횟수" type="number" min={1} max={999} className="w-20" value={r.end.count} onChange={(e) => set({ end: { type: 'count', count: Math.max(1, Number(e.target.value) || 1) } })} />회
            </label>
          )}
        </div>
      )}
    </div>
  )
}
