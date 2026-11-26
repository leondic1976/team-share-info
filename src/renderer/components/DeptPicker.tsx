import { useMemo, useState } from 'react'
import { Check, PencilLine, Search, X } from 'lucide-react'
import { Input } from '@renderer/components/ui/input'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { cn } from '@renderer/lib/utils'
import type { DepartmentDto } from '@shared/schemas/org'
import { DEPT_MAX_DEPTH, DEPT_SEP, deptNameError, deptOptions, deptPathText, matchDeptPath, parseDeptPath } from '@shared/org'
import { matchesHangul } from '@shared/hangul'

/** An existing department (null: none), or the affiliation as typed, top level first. */
export type DeptChoice = { deptId: string | null } | { path: string[] }

/** Why a typed affiliation cannot be saved, or '' when it can. */
export function deptPathError(path: string[]): string {
  if (path.length > DEPT_MAX_DEPTH) return `소속은 ${DEPT_MAX_DEPTH}단계까지 입력할 수 있습니다.`
  for (const n of path) {
    const err = deptNameError(n)
    if (err) return err
  }
  return ''
}

/**
 * 소속 고르기: the department tree with a name filter, the chosen affiliation in full, and (when
 * `allowTyping`) "목록에 없으면 직접 입력" for an affiliation the tree does not have yet.
 */
export function DeptPicker({
  depts,
  value,
  onChange,
  disabled,
  allowTyping = true,
  fallbackText = ''
}: {
  depts: DepartmentDto[]
  value: DeptChoice
  onChange: (v: DeptChoice) => void
  disabled?: boolean
  allowTyping?: boolean
  /** shown for a chosen department that is not in `depts` (the list has not arrived yet) */
  fallbackText?: string
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [typing, setTyping] = useState('path' in value)
  const [text, setText] = useState('path' in value ? deptPathText(value.path) : '')
  const options = useMemo(() => deptOptions(depts), [depts])
  const needle = q.trim().toLowerCase()
  const shown = needle ? options.filter((o) => matchesHangul(o.path.join(' '), needle)) : options

  const pickedId = 'deptId' in value ? value.deptId : null
  const typed = 'path' in value ? value.path : null
  const match = useMemo(() => (typed ? matchDeptPath(depts, typed) : null), [depts, typed])
  const pickedText = typed ? deptPathText(typed) : pickedId ? deptPathText(options.find((o) => o.id === pickedId)?.path) || fallbackText : ''
  const typedError = typed ? deptPathError(typed) : ''

  const pick = (id: string | null): void => {
    setTyping(false)
    setText('')
    onChange({ deptId: id })
  }
  const type = (t: string): void => {
    setText(t)
    const path = parseDeptPath(t)
    // nothing typed yet: what was chosen in the list stays
    if (path.length) onChange({ path })
    else if (typed) onChange({ deptId: null })
  }

  return (
    <div className="space-y-2" data-testid="dept-picker">
      <div className={cn('flex min-h-9 items-center gap-2 rounded-md border border-input bg-muted px-3 py-1.5 text-sm', disabled && 'opacity-60')}>
        <span className="shrink-0 text-xs text-muted-foreground">선택한 소속</span>
        <b className="min-w-0 flex-1 break-keep" data-testid="dept-picked">
          {pickedText || '미지정'}
        </b>
        {typed && match && match.missing.length > 0 && <Badge variant="important">새로 입력</Badge>}
      </div>
      {!disabled && (
        <>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
            <Input aria-label="소속 찾기" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="부서 이름으로 찾기" />
          </div>
          <div role="listbox" aria-label="소속 목록" className="max-h-52 overflow-y-auto rounded-md border border-border bg-card py-1 text-sm">
            {!needle && (
              <button type="button" role="option" aria-selected={!typed && !pickedId} className={cn('flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left text-muted-foreground hover:bg-muted', !typed && !pickedId && 'bg-accent')} onClick={() => pick(null)}>
                <span className="flex-1">미지정</span>
                {!typed && !pickedId && <Check className="size-4 text-primary" aria-hidden />}
              </button>
            )}
            {shown.map((o) => {
              const on = !typed && pickedId === o.id
              return (
                <button
                  key={o.id}
                  type="button"
                  role="option"
                  aria-selected={on}
                  title={deptPathText(o.path)}
                  data-testid={`dept-option-${deptPathText(o.path)}`}
                  className={cn('flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left hover:bg-muted', on && 'bg-accent font-semibold')}
                  style={needle ? undefined : { paddingLeft: `${0.75 + o.depth * 1.1}rem` }}
                  onClick={() => pick(o.id)}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {needle && o.depth > 0 && (
                      <span className="font-normal text-muted-foreground">
                        {deptPathText(o.path.slice(0, -1))}
                        {DEPT_SEP}
                      </span>
                    )}
                    {!needle && o.depth > 0 && <span className="font-normal text-muted-foreground">└ </span>}
                    {o.name}
                  </span>
                  {on && <Check className="size-4 shrink-0 text-primary" aria-hidden />}
                </button>
              )
            })}
            {shown.length === 0 && <p className="px-3 py-2 text-xs text-muted-foreground">{needle ? '찾는 부서가 없습니다.' : '아직 등록된 부서가 없습니다.'}</p>}
          </div>
          {allowTyping &&
            (typing ? (
              <div className="space-y-1.5 rounded-md border border-dashed border-border p-2">
                <div className="flex items-center gap-2">
                  <Input aria-label="소속 직접 입력" value={text} maxLength={300} onChange={(e) => type(e.target.value)} placeholder="예: 행정지원본부 > 총무과 > 서무팀" autoFocus />
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label="직접 입력 취소"
                    title="직접 입력 취소"
                    onClick={() => {
                      setTyping(false)
                      setText('')
                      if (typed) onChange({ deptId: null })
                    }}
                  >
                    <X />
                  </Button>
                </div>
                {typed && match && (
                  <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="dept-typed-levels">
                    {typed.map((name, i) => (
                      <span key={`${i}:${name}`} className="inline-flex items-center gap-1">
                        {i > 0 && <span className="text-muted-foreground">&gt;</span>}
                        <Badge variant={i < match.ids.length ? 'muted' : 'important'}>
                          {name} · {i < match.ids.length ? '있음' : '새로 추가'}
                        </Badge>
                      </span>
                    ))}
                  </div>
                )}
                {typedError ? (
                  <p className="text-xs text-urgent">{typedError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    위 단계부터 차례로 적고 단계 사이는 &gt; 로 구분합니다(최대 {DEPT_MAX_DEPTH}단계). 이미 있는 단계는 그대로 쓰이고 없는 단계만 새로 추가됩니다. 새로 추가한 소속은 최종관리자(서버 PC)가 조직 관리에서 확인·정리합니다.
                  </p>
                )}
              </div>
            ) : (
              <Button type="button" size="sm" variant="outline" onClick={() => setTyping(true)}>
                <PencilLine /> 목록에 없으면 직접 입력
              </Button>
            ))}
        </>
      )}
    </div>
  )
}
