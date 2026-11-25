/** 훈련 화면 (참가자): 대상물 정보와 지도, 상황판(메시지와 답변), 내가 처리할 메시지, 끝난 뒤 결과. */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CheckCircle2, Clock, Download, MonitorPlay, Paperclip, Printer, Send, Timer } from 'lucide-react'
import type { CmdFile, Drill, DrillMsg } from '../shared/types'
import { GRADE_LABEL, HANDLING_LABEL } from '../shared/types'
import { answerRefusal, drillElapsedMs, drillSummary, formatClock, formatSeconds, marksAt, waitsFor } from '../shared/logic'
import type { Model } from './model'
import { hm, when } from './model'
import { useAct, useDrill, useServerNow } from './data'
import { useHost } from './host'
import { MapCanvas } from './MapCanvas'
import { FileList, FilePicker } from './Notices'
import { RichView } from './rich'
import { targetText } from './ScenarioEditor'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyNote, Textarea, cn } from './ui'

export const STATE_LABEL: Record<Drill['state'], string> = { scheduled: '예정', running: '진행 중', paused: '일시정지', ended: '종료' }
export const stateTone = (s: Drill['state']): 'drill' | 'important' | 'muted' | 'primary' => (s === 'running' ? 'drill' : s === 'paused' ? 'important' : s === 'scheduled' ? 'primary' : 'muted')

/** The answer box of one message for me (text with files, or the choices). */
export function AnswerBox({ d, msg, compact, onDone }: { d: Drill; msg: DrillMsg; compact?: boolean; onDone?: () => void }): React.JSX.Element | null {
  const host = useHost()
  const act = useAct()
  const meId = useMeId()
  const mine = msg.answers.find((a) => a.memberId === meId)
  const [body, setBody] = useState(mine?.body ?? '')
  const [choice, setChoice] = useState<number | null>(mine?.choiceIndex ?? null)
  const [files, setFiles] = useState<CmdFile[]>([])
  const isParticipant = d.members.some((x) => x.memberId === meId)
  if (d.state === 'ended' || d.state === 'scheduled') return null
  const why = answerRefusal(msg, meId, isParticipant)
  if (why && !mine) return compact ? null : <p className="text-xs text-muted-foreground">{why}</p>
  const send = (): void => void act.run(() => host.api.post(`/api/command/drills/${d.id}/messages/${msg.id}/answer`, { body, choiceIndex: choice, attachmentIds: files.map((f) => f.id) }), () => (setFiles([]), onDone?.()))
  return (
    <div className="space-y-2 rounded-md border border-orange-400/60 bg-orange-500/5 p-2" data-testid="cmd-answer-box">
      {msg.answerKind === 'choice' ? (
        <div className="flex flex-col gap-1">
          {msg.choices.map((c, i) => (
            <label key={i} className={cn('flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm', choice === i ? 'bg-primary/10 font-semibold' : 'hover:bg-muted')}>
              <input type="radio" name={`ans-${msg.id}`} checked={choice === i} onChange={() => setChoice(i)} /> {i + 1}. {c}
            </label>
          ))}
        </div>
      ) : (
        <>
          <Textarea rows={compact ? 3 : 4} value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} placeholder="처리 내용을 적으세요 (조치, 보고, 요청…)" aria-label="처리 답변" />
          <FilePicker files={files} onChange={setFiles} />
        </>
      )}
      <div className="flex items-center gap-2">
        {mine && <span className="text-xs text-muted-foreground">{hm(mine.answeredAt)}에 답함 · 훈련 중에는 고쳐 쓸 수 있습니다</span>}
        <Button size="sm" className="ml-auto" disabled={act.busy || (msg.answerKind === 'choice' ? choice == null : !body.trim() && !files.length)} onClick={send} data-testid="cmd-answer-send">
          <Send /> {mine ? '고쳐 보내기' : '처리 보고'}
        </Button>
      </div>
      {act.err && <p className="text-xs text-urgent">{act.err}</p>}
    </div>
  )
}

/** My member id, given by the app (from the command state). */
export const MeId = createContext('')
export const useMeId = (): string => useContext(MeId)

/** One message on the board with its answers. */
export function MsgCard({ m, d, msg, now, showAnswerBox = true, children }: { m: Model; d: Drill; msg: DrillMsg; now: number; showAnswerBox?: boolean; children?: React.ReactNode }): React.JSX.Element {
  const meId = useMeId()
  const mineToDo = waitsFor(msg, meId)
  const left = msg.limitMin && msg.sentAt ? msg.sentAt + msg.limitMin * 60_000 - now : null
  return (
    <div className={cn('rounded-lg border bg-card p-3', mineToDo ? 'border-orange-500 ring-2 ring-orange-500/30' : 'border-border')} data-testid="cmd-board-msg" data-msg={msg.title}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs tabular-nums text-muted-foreground">{msg.sentAt ? hm(msg.sentAt) : `+${msg.offsetMin}분`}</span>
        <b>{msg.title}</b>
        {msg.adHoc && <Badge tone="drill">즉석</Badge>}
        {mineToDo && <Badge tone="urgent">내가 처리</Badge>}
        {msg.done ? <Badge tone="success"><CheckCircle2 /> 처리됨</Badge> : left != null && d.state !== 'ended' && <Badge tone={left < 0 ? 'urgent' : 'important'}><Timer /> {left < 0 ? '시간 초과' : `${Math.ceil(left / 60000)}분 남음`}</Badge>}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        처리: {targetText(m, msg)} · {HANDLING_LABEL[msg.handling]}
        {msg.targets.length > 0 && msg.handling !== 'first' && ` · ${msg.answers.filter((a) => msg.targets.includes(a.memberId)).length}/${msg.targets.length}명 답함`}
      </p>
      {msg.bodyHtml && <RichView html={msg.bodyHtml} className="mt-2 text-sm" />}
      {msg.answerKind === 'choice' && (
        <ol className="mt-1 list-inside list-decimal text-sm">
          {msg.choices.map((c, i) => (
            <li key={i} className={cn(msg.correctIndex === i && 'font-bold text-success')}>
              {c}
              {msg.correctIndex === i && ' (정답)'}
            </li>
          ))}
        </ol>
      )}
      {msg.answers.length > 0 && (
        <div className="mt-2 space-y-1.5 border-l-2 border-border pl-3">
          {msg.answers.map((a) => (
            <div key={a.id} className="text-sm" data-testid="cmd-board-answer">
              <span className="font-semibold">{a.name}</span>{' '}
              <span className="text-xs text-muted-foreground">
                {hm(a.answeredAt)} · {formatSeconds(a.seconds)}
              </span>{' '}
              {a.late && <Badge tone="urgent">시간 초과</Badge>} {a.grade && <Badge tone={a.grade === 'good' ? 'success' : a.grade === 'fair' ? 'primary' : 'important'}>{GRADE_LABEL[a.grade]}</Badge>}
              <p className="whitespace-pre-wrap">{msg.answerKind === 'choice' && a.choiceIndex != null ? `${a.choiceIndex + 1}. ${msg.choices[a.choiceIndex] ?? ''}` : a.body}</p>
              <FileList files={a.attachments} />
              {a.comment && <p className="text-xs text-primary">평가: {a.comment}</p>}
            </div>
          ))}
        </div>
      )}
      {showAnswerBox && mineToDo && (
        <div className="mt-2">
          <AnswerBox d={d} msg={msg} />
        </div>
      )}
      {children}
    </div>
  )
}

/** The map of a drill at a moment (live, or replayed with the time bar after it ended). */
export function DrillMap({ d, at, edit, className }: { d: Drill; at: number; edit?: Parameters<typeof MapCanvas>[0]['edit']; className?: string }): React.JSX.Element {
  const marks = useMemo(() => marksAt(d.marks, at), [d.marks, at])
  // what changed in the last 20 seconds stands out
  const fresh = useMemo(() => new Set(d.marks.filter((x) => (x.createdAt ?? 0) > at - 20_000 && (x.createdAt ?? 0) > (d.startedAt ?? 0) + 1000).map((x) => x.key)), [d.marks, d.startedAt, at])
  return <MapCanvas imageId={d.map.imageId} width={d.map.width} height={d.map.height} marks={marks} edit={edit} highlight={fresh} className={className} />
}

export function DrillView({ m, id, onBack }: { m: Model; id: string; onBack: () => void }): React.JSX.Element {
  const host = useHost()
  const q = useDrill(id)
  const d = q.data
  const now = useServerNow(d?.serverNow)
  const [replay, setReplay] = useState<number | null>(null)
  const meId = useMeId()
  useEffect(() => setReplay(null), [id])
  if (!d) return <p className="p-4 text-sm text-muted-foreground">{q.isError ? host.errorMessage(q.error) : '불러오는 중…'}</p>
  const elapsed = drillElapsedMs(d, now)
  const sent = d.messages.filter((x) => x.sentAt && !x.skipped).sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
  const todo = sent.filter((x) => waitsFor(x, meId))
  const mapAt = d.state === 'ended' && replay != null ? replay : d.state === 'ended' ? (d.endedAt ?? now) : now
  return (
    <div className="space-y-4" data-testid="cmd-drill-view">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onBack}>
          <ArrowLeft /> 목록
        </Button>
        <h2 className="text-lg font-bold">{d.title}</h2>
        <Badge tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Badge>
        <span className="text-sm text-muted-foreground">
          {m.s.modes.find((x) => x.id === d.modeId)?.name} · {d.teamIds.map((t) => m.team(t)?.name).join(', ')} · 참가 {d.members.length}명
        </span>
        <span className="ml-auto flex items-center gap-2">
          {d.startedAt && (
            <span className="flex items-center gap-1 font-mono text-lg tabular-nums" data-testid="cmd-drill-clock">
              <Clock className="size-4" /> {formatClock(elapsed)}
            </span>
          )}
          {d.isManager && (
            <Button size="sm" onClick={() => host.openControlRoom(d.id)} data-testid="cmd-open-control">
              <MonitorPlay /> 통제실 열기
            </Button>
          )}
        </span>
      </div>
      {d.state === 'scheduled' && <p className="rounded-md border border-border bg-muted px-3 py-2 text-sm">{d.startAt ? `${when(d.startAt)}에 시작합니다.` : '지휘대담당이 시작하면 진행됩니다.'}</p>}
      {todo.length > 0 && (
        <div className="rounded-md border-2 border-orange-500 bg-orange-500/10 px-3 py-2 text-sm font-semibold" data-testid="cmd-todo">
          내가 처리할 메시지 {todo.length}건 — 아래 상황판에서 처리 보고를 하세요.
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>지도</CardTitle>
              {d.state === 'ended' && d.startedAt && d.endedAt && (
                <span className="flex items-center gap-2 text-xs">
                  다시 보기
                  <input type="range" min={d.startedAt} max={d.endedAt} step={1000} value={replay ?? d.endedAt} onChange={(e) => setReplay(Number(e.target.value))} aria-label="지도 다시 보기 시각" />
                  <span className="w-16 tabular-nums">{formatClock((replay ?? d.endedAt) - d.startedAt)}</span>
                </span>
              )}
            </CardHeader>
            <CardContent>
              <DrillMap d={d} at={mapAt} className="h-[420px]" />
            </CardContent>
          </Card>
          {(d.targetHtml || d.summaryHtml) && (
            <Card>
              <CardHeader>
                <CardTitle>훈련 대상물 · 개요</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {d.targetHtml && <RichView html={d.targetHtml} />}
                {d.summaryHtml && <RichView html={d.summaryHtml} className="text-sm text-muted-foreground" />}
              </CardContent>
            </Card>
          )}
        </div>
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">상황판 ({sent.length})</h3>
          {sent.length ? sent.map((x) => <MsgCard key={x.id} m={m} d={d} msg={x} now={now} />) : <EmptyNote>아직 메시지가 없습니다.</EmptyNote>}
        </div>
      </div>
      {d.state === 'ended' && <Results m={m} d={d} />}
    </div>
  )
}

/** 결과 요약: by person and by role; print and CSV. */
export function Results({ m, d }: { m: Model; d: Drill }): React.JSX.Element {
  const host = useHost()
  const s = drillSummary(d, m.s.roles)
  const pct = (a: number, b: number): string => (b ? `${Math.round((a / b) * 100)}%` : '-')
  const head = ['구분', '받은 메시지', '답함', '응답률', '평균 응답 시간', '시간 초과', '우수', '보통', '미흡', '객관식 정답']
  const rowOf = (r: (typeof s.people)[number]): string[] => [r.name, String(r.received), String(r.answered), pct(r.answered, r.received), formatSeconds(r.avgSeconds), String(r.late), String(r.grades.good), String(r.grades.fair), String(r.grades.poor), r.choiceAsked ? `${r.choiceRight}/${r.choiceAsked}` : '-']
  const csv = (): void => {
    const rows: string[][] = [[`${d.title} 결과`], [], ['사람별'], head, ...s.people.map(rowOf), [], ['분류별'], head, ...s.roles.map(rowOf), [], ['전체'], rowOf(s.total), [], ['답변 목록'], ['시각', '메시지', '답한 사람', '응답 시간', '시간 초과', '답변', '평가', '코멘트']]
    for (const x of d.messages.filter((y) => y.sentAt && !y.skipped)) for (const a of x.answers) rows.push([when(a.answeredAt), x.title, a.name, formatSeconds(a.seconds), a.late ? '예' : '', x.answerKind === 'choice' && a.choiceIndex != null ? `${a.choiceIndex + 1}. ${x.choices[a.choiceIndex] ?? ''}` : a.body, a.grade ? GRADE_LABEL[a.grade] : '', a.comment])
    host.saveCsv(`훈련결과_${d.title}.csv`, rows)
  }
  const table = (title: string, rows: typeof s.people): React.JSX.Element => (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="cmd-results">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              {head.map((h, i) => (
                <th key={h} className={cn('px-2 py-1.5 font-medium', i ? 'text-right' : 'text-left')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-border last:border-0">
                {rowOf(r).map((c, i) => (
                  <td key={i} className={cn('px-2 py-1.5', i ? 'text-right tabular-nums' : 'font-medium')}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <tfoot className="border-t border-border font-semibold">
            <tr>
              {rowOf(s.total).map((c, i) => (
                <td key={i} className={cn('px-2 py-1.5', i ? 'text-right tabular-nums' : '')}>
                  {c}
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </Card>
  )
  return (
    <div className="space-y-4" data-testid="cmd-results-block">
      <div className="flex items-center gap-2">
        <h3 className="text-base font-bold">결과 요약</h3>
        <Button size="sm" variant="outline" className="ml-auto print:hidden" onClick={() => window.print()}>
          <Printer /> 인쇄
        </Button>
        <Button size="sm" variant="outline" className="print:hidden" onClick={csv}>
          <Download /> CSV로 저장
        </Button>
      </div>
      {table('사람별', s.people)}
      {table('분류별', s.roles)}
      {d.reviewHtml && (
        <Card>
          <CardHeader>
            <CardTitle>총평</CardTitle>
          </CardHeader>
          <CardContent>
            <RichView html={d.reviewHtml} />
          </CardContent>
        </Card>
      )}
      <p className="hidden text-xs print:block">
        <Paperclip className="inline size-3" /> TeamHub 긴급구조지휘대 · {when(d.endedAt ?? Date.now())}
      </p>
    </div>
  )
}
