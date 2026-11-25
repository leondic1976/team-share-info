import { X } from 'lucide-react'
import { cn } from '@renderer/lib/utils'
import { pad } from '@renderer/lib/dates'

/**
 * Date and time without the browser's combined date-time picker. That picker (input
 * type="datetime-local") has no 확인 button and does not close when a day is clicked, which left
 * people unsure whether they had picked anything (2026-11-25, 지시 69). Here the day is a date
 * field, whose calendar closes as soon as a day is clicked, and the time is two lists (시, 분)
 * that close as soon as an item is picked.
 *
 * The value keeps the format of datetime-local, "YYYY-MM-DDTHH:mm" ('' = not set), so it is a
 * drop-in replacement.
 */

const selectCls = 'h-9 cursor-pointer rounded-md border border-input bg-background px-1.5 text-sm tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50'

/** Minutes offered: every `step`, plus the current one when it is not on the grid. */
function minuteOptions(step: number, current: number | null): number[] {
  const out: number[] = []
  for (let m = 0; m < 60; m += Math.max(1, step)) out.push(m)
  if (current !== null && !out.includes(current)) out.push(current)
  return out.sort((a, b) => a - b)
}

/** "HH:mm" with a list for the hour and one for the minute. */
export function TimeSelect({
  value,
  onChange,
  label,
  minuteStep = 1,
  disabled,
  className
}: {
  value: string
  onChange: (v: string) => void
  /** what the time is for, e.g. "시작": the lists are labelled "시작 시" and "시작 분" */
  label: string
  minuteStep?: number
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  const m = /^(\d{1,2}):(\d{2})/.exec(value)
  const h = m ? Number(m[1]) : null
  const min = m ? Number(m[2]) : null
  const set = (nh: number, nm: number): void => onChange(`${pad(nh)}:${pad(nm)}`)
  return (
    <span className={cn('inline-flex items-center gap-1', className)}>
      <select className={selectCls} aria-label={`${label} 시`} value={h ?? ''} disabled={disabled} onChange={(e) => set(Number(e.target.value), min ?? 0)}>
        {h === null && <option value="">--</option>}
        {Array.from({ length: 24 }, (_, i) => (
          <option key={i} value={i}>
            {i < 12 ? '오전' : '오후'} {i % 12 === 0 ? 12 : i % 12}시
          </option>
        ))}
      </select>
      <select className={selectCls} aria-label={`${label} 분`} value={min ?? ''} disabled={disabled} onChange={(e) => set(h ?? 9, Number(e.target.value))}>
        {min === null && <option value="">--</option>}
        {minuteOptions(minuteStep, min).map((x) => (
          <option key={x} value={x}>
            {pad(x)}분
          </option>
        ))}
      </select>
    </span>
  )
}

/** "YYYY-MM-DDTHH:mm" (or '' when `clearable` and not set): a date field and the time lists. */
export function DateTimeInput({
  value,
  onChange,
  label,
  minuteStep = 1,
  clearable = false,
  min,
  disabled,
  defaultTime = '09:00',
  className
}: {
  value: string
  onChange: (v: string) => void
  /** e.g. "시작": the date field is labelled "시작", the lists "시작 시" and "시작 분" */
  label: string
  minuteStep?: number
  /** may be left empty: shows an X that clears it */
  clearable?: boolean
  /** earliest day that can be picked ("YYYY-MM-DD" or a datetime-local value) */
  min?: string
  disabled?: boolean
  /** the time taken when only a day has been picked */
  defaultTime?: string
  className?: string
}): React.JSX.Element {
  const [date = '', time = ''] = value ? value.split('T') : []
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1', className)} data-testid="datetime-input">
      <input
        type="date"
        aria-label={label}
        className={cn(selectCls, 'w-[9.5rem] cursor-text px-2')}
        value={date}
        min={min ? min.slice(0, 10) : undefined}
        disabled={disabled}
        onChange={(e) => {
          const d = e.target.value
          if (!d) {
            if (clearable) onChange('')
            return
          }
          onChange(`${d}T${time || defaultTime}`)
        }}
      />
      <TimeSelect label={label} value={time} minuteStep={minuteStep} disabled={disabled || !date} onChange={(t) => date && onChange(`${date}T${t}`)} />
      {clearable && value && !disabled && (
        <button type="button" className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`${label} 지우기`} title="지우기" onClick={() => onChange('')}>
          <X className="size-4" />
        </button>
      )}
    </span>
  )
}
