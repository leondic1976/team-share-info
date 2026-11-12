import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Calculator, CalendarRange, Copy, Ruler } from 'lucide-react'
import { UNITS, addDays, addWorkdays, convertUnit, dDay, daysBetween, evalExpression, workdaysBetween } from '@shared/calc'
import type { HolidayDto } from '@shared/schemas/events'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { api } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { ymd } from '@renderer/lib/dates'
import { useConn } from '@renderer/app/conn-store'

const num = (n: number): string => n.toLocaleString('ko-KR', { maximumFractionDigits: 10 })

function CalculatorCard(): React.JSX.Element {
  const [expr, setExpr] = useState('')
  const [history, setHistory] = useState<{ expr: string; value: number }[]>([])
  const preview = ((): string => {
    try {
      return expr.trim() ? num(evalExpression(expr)) : ''
    } catch (e) {
      return (e as Error).message
    }
  })()
  const run = (): void => {
    try {
      const value = evalExpression(expr)
      setHistory([{ expr, value }, ...history].slice(0, 20))
      setExpr(String(value))
    } catch {
      // preview already shows the error
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Calculator className="size-4" /> 계산기
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Input aria-label="계산식" placeholder="예: 1,250,000 × 3 + 10%" value={expr} onChange={(e) => setExpr(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} className="font-mono" />
        <div className="flex items-center gap-2">
          <span className="flex-1 truncate font-mono text-lg font-bold" data-testid="calc-result">
            {preview && `= ${preview}`}
          </span>
          <Button size="sm" onClick={run}>
            계산
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">+ − × ÷ ^(거듭제곱) %(백분율) 괄호를 쓸 수 있습니다.</p>
        {history.length > 0 && (
          <div className="max-h-40 space-y-0.5 overflow-y-auto border-t border-border pt-2 font-mono text-xs">
            {history.map((h, i) => (
              <button key={i} className="flex w-full cursor-pointer justify-between rounded px-1 py-0.5 hover:bg-muted" onClick={() => void invoke('clipboard:write', { text: String(h.value) })} title="결과 복사">
                <span className="truncate text-muted-foreground">{h.expr}</span>
                <span>= {num(h.value)}</span>
              </button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function DateCard(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const today = ymd()
  const [a, setA] = useState(today)
  const [b, setB] = useState(addDays(today, 30))
  const [n, setN] = useState(10)
  const year = Number(today.slice(0, 4))
  const holidays = useQuery({
    queryKey: ['holidays', 'calc', year],
    queryFn: () => api.get<HolidayDto[]>('/api/holidays', { from: `${year - 1}-01-01`, to: `${year + 2}-12-31` }),
    enabled: online,
    staleTime: 3600_000
  })
  const hs = useMemo(() => new Set((holidays.data ?? []).map((h) => h.date)), [holidays.data])
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(a) && /^\d{4}-\d{2}-\d{2}$/.test(b)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <CalendarRange className="size-4" /> 날짜 계산
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Input type="date" aria-label="시작일" className="w-40" value={a} onChange={(e) => setA(e.target.value)} />
          <span>~</span>
          <Input type="date" aria-label="종료일" className="w-40" value={b} onChange={(e) => setB(e.target.value)} />
        </div>
        {valid && (
          <div className="grid grid-cols-3 gap-2 text-center" data-testid="date-calc">
            <div className="rounded-md bg-muted p-2">
              <div className="text-xs text-muted-foreground">종료일까지</div>
              <div className="font-bold">{dDay(b, today)}</div>
            </div>
            <div className="rounded-md bg-muted p-2">
              <div className="text-xs text-muted-foreground">기간 (시작일 포함)</div>
              <div className="font-bold">{Math.abs(daysBetween(a, b)) + 1}일</div>
            </div>
            <div className="rounded-md bg-muted p-2">
              <div className="text-xs text-muted-foreground">근무일 (주말·공휴일 제외)</div>
              <div className="font-bold">{workdaysBetween(a, b, hs)}일</div>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
          <span>시작일부터</span>
          <Input type="number" aria-label="더할 일수" className="w-20" value={n} onChange={(e) => setN(Number(e.target.value) || 0)} />
          <span>일 뒤</span>
          {/^\d{4}-\d{2}-\d{2}$/.test(a) && (
            <span className="font-semibold">
              {addDays(a, n)} · 근무일 기준 {addWorkdays(a, n, hs)}
            </span>
          )}
        </div>
        {!online && <p className="text-xs text-muted-foreground">서버에 연결되지 않아 공휴일은 빼지 않고 주말만 뺐습니다.</p>}
      </CardContent>
    </Card>
  )
}

function UnitCard(): React.JSX.Element {
  const [cat, setCat] = useState('area')
  const units = Object.entries(UNITS[cat].units)
  const [from, setFrom] = useState('pyeong')
  const [to, setTo] = useState('m2')
  const [value, setValue] = useState('1')
  const pick = (c: string): void => {
    setCat(c)
    const keys = Object.keys(UNITS[c].units)
    setFrom(keys[0])
    setTo(keys[1] ?? keys[0])
  }
  let out = ''
  try {
    out = value.trim() ? num(convertUnit(cat, Number(value.replace(/,/g, '')), from, to)) : ''
  } catch {
    out = ''
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Ruler className="size-4" /> 단위 변환
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-1">
          {Object.entries(UNITS).map(([k, c]) => (
            <Button key={k} size="sm" variant={cat === k ? 'default' : 'outline'} onClick={() => pick(k)}>
              {c.label}
            </Button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="변환할 값" className="w-32" value={value} onChange={(e) => setValue(e.target.value)} />
          <Select aria-label="원래 단위" className="w-32" value={from} onChange={(e) => setFrom(e.target.value)}>
            {units.map(([k, u]) => (
              <option key={k} value={k}>
                {u.label}
              </option>
            ))}
          </Select>
          <span>=</span>
          <span className="min-w-24 font-mono text-base font-bold" data-testid="unit-result">
            {out}
          </span>
          <Select aria-label="바꿀 단위" className="w-32" value={to} onChange={(e) => setTo(e.target.value)}>
            {units.map(([k, u]) => (
              <option key={k} value={k}>
                {u.label}
              </option>
            ))}
          </Select>
          {out && (
            <Button size="icon-sm" variant="ghost" aria-label="결과 복사" onClick={() => void invoke('clipboard:write', { text: out.replace(/,/g, '') })}>
              <Copy />
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

/** Calculator, date math and unit conversion (6.12 ③). Nothing is stored. */
export function CalcTools(): React.JSX.Element {
  return (
    <div className="grid min-h-0 flex-1 auto-rows-min gap-4 overflow-y-auto p-5 lg:grid-cols-2">
      <CalculatorCard />
      <DateCard />
      <UnitCard />
    </div>
  )
}

