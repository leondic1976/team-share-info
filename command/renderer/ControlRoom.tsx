/**
 * 훈련 통제실 (지휘대담당): the whole flow of a drill on one screen — the clock and controls, the
 * time table of messages, the situation board with grading, who has answered, the live map, and
 * the 통제 기록. After the drill it is where the results are put in order (총평).
 */
import { useEffect, useMemo, useState } from 'react'
import { BellRing, CheckCircle2, Clock, FastForward, Flag, MapPinned, MessageSquarePlus, Pause, Pencil, Play, Send, Square, Trash2, Users } from 'lucide-react'
import type { Drill, DrillMsg, Grade, Mark, ScenarioMsg } from '../shared/types'
import { GRADE_LABEL, HANDLING_LABEL } from '../shared/types'
import { drillElapsedMs, formatClock, formatSeconds, marksAt } from '../shared/logic'
import type { Model } from './model'
import { hm } from './model'
import { useAct, useDrill, useServerNow } from './data'
import { useHost } from './host'
import type { MapEditOps } from './MapCanvas'
import { DrillMap, MsgCard, Results, STATE_LABEL, stateTone } from './DrillView'
import { MessageDialog, targetText } from './ScenarioEditor'
import { Editor } from './rich'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, EmptyNote, Input, Select, cn, titled } from './ui'

type Filter = 'all' | 'unanswered' | 'late' | 'ungraded'

function GradeBar({ d, a }: { d: Drill; a: DrillMsg['answers'][number] }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [comment, setComment] = useState(a.comment)
  useEffect(() => setComment(a.comment), [a.comment])
  const save = (grade: Grade | null): void => void act.run(() => host.api.put(`/api/command/drills/${d.id}/answers/${a.id}/grade`, { grade, comment }))
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1" data-testid="cmd-grade">
      <span className="text-xs text-muted-foreground">{a.name} 평가</span>
      {(['good', 'fair', 'poor'] as Grade[]).map((g) => (
        <Button key={g} size="sm" variant={a.grade === g ? 'default' : 'outline'} className="h-7" onClick={() => save(a.grade === g ? null : g)} data-grade={g}>
          {GRADE_LABEL[g]}
        </Button>
      ))}
      <Input className="h-7 w-56 text-xs" placeholder="코멘트" value={comment} maxLength={1000} onChange={(e) => setComment(e.target.value)} onBlur={() => comment !== a.comment && save(a.grade)} aria-label={`${a.name} 코멘트`} />
      {a.gradedByName && <span className="text-[0.65rem] text-muted-foreground">{a.gradedByName}</span>}
      {act.err && <span className="text-xs text-urgent">{act.err}</span>}
    </div>
  )
}

export function ControlRoom({ m, id }: { m: Model; id: string }): React.JSX.Element {
  const host = useHost()
  const q = useDrill(id)
  const d = q.data
  const now = useServerNow(d?.serverNow, 1000)
  const act = useAct()
  const [filter, setFilter] = useState<Filter>('all')
  const [person, setPerson] = useState('')
  const [adHoc, setAdHoc] = useState<ScenarioMsg | null>(null)
  const [editMsg, setEditMsg] = useState<DrillMsg | null>(null)
  const [note, setNote] = useState('')
  const [review, setReview] = useState<string | null>(null)
  const [mapBig, setMapBig] = useState(false)
  useEffect(() => {
    if (d && review === null) setReview(d.reviewHtml)
  }, [d, review])

  const ops: MapEditOps | undefined = useMemo(() => {
    if (!d || d.state === 'ended') return undefined
    const body = (mk: Mark): Record<string, unknown> => ({ key: mk.key, kind: mk.kind, icon: mk.icon, color: mk.color, label: mk.label, points: mk.points })
    return {
      add: (mk) => void act.run(() => host.api.post(`/api/command/drills/${d.id}/marks`, body(mk))),
      move: (mk) => void act.run(() => host.api.patch(`/api/command/drills/${d.id}/marks/${encodeURIComponent(mk.key)}`, body(mk))),
      remove: (key) => void act.run(() => host.api.del(`/api/command/drills/${d.id}/marks/${encodeURIComponent(key)}`))
    }
  }, [d, act, host])

  if (!d) return <p className="p-4 text-sm text-muted-foreground">{q.isError ? host.errorMessage(q.error) : '불러오는 중…'}</p>
  if (!d.isManager) return <EmptyNote>통제실은 서버 PC와 지휘대담당만 열 수 있습니다.</EmptyNote>
  const elapsed = drillElapsedMs(d, now)
  const pending = d.messages.filter((x) => !x.sentAt && !x.skipped)
  const nextMsg = pending.sort((a, b) => a.offsetMin - b.offsetMin)[0]
  const nextIn = nextMsg && d.state === 'running' ? nextMsg.offsetMin * 60_000 - elapsed : null
  const sent = d.messages.filter((x) => x.sentAt && !x.skipped)
  const ctl = (action: string, confirm?: string): void => {
    if (confirm && !window.confirm(confirm)) return
    void act.run(() => host.api.post(`/api/command/drills/${d.id}/${action}`))
  }
  const board = sent
    .filter((x) => {
      if (person && !(x.targets.includes(person) || x.answers.some((a) => a.memberId === person))) return false
      if (filter === 'unanswered') return !x.done
      if (filter === 'late') return x.answers.some((a) => a.late) || (!x.done && !!x.limitMin && now - (x.sentAt ?? now) > x.limitMin * 60_000)
      if (filter === 'ungraded') return x.answers.some((a) => !a.grade)
      return true
    })
    .sort((a, b) => (b.sentAt ?? 0) - (a.sentAt ?? 0))
  const memberStats = d.members.map((mb) => {
    const got = sent.filter((x) => x.targets.includes(mb.memberId))
    const answered = got.filter((x) => x.answers.some((a) => a.memberId === mb.memberId))
    const secs = answered.map((x) => x.answers.find((a) => a.memberId === mb.memberId)!.seconds)
    const open = got.filter((x) => !x.answers.some((a) => a.memberId === mb.memberId) && !(x.handling === 'first' && x.answers.length))
    return { mb, got: got.length, answered: answered.length, open, avg: secs.length ? Math.round(secs.reduce((s, x) => s + x, 0) / secs.length) : null }
  })
  const rolesOf = (ids: string[]): string => ids.map((r) => m.s.roles.find((x) => x.id === r)?.name).filter(Boolean).join(', ')
  const noTarget = d.messages.filter((x) => x.sentAt && !x.skipped && x.handling !== 'first' && !x.targets.length)

  return (
    <div className="flex min-h-0 flex-col gap-3" data-testid="cmd-control">
      {/* the clock and the controls */}
      <div className="flex flex-wrap items-center gap-3 rounded-lg border-2 border-orange-500 bg-orange-500/10 px-4 py-2">
        <Flag className="size-5 text-orange-600" />
        <div className="min-w-0">
          <p className="truncate font-bold">{d.title}</p>
          <p className="text-xs text-muted-foreground">
            {m.s.modes.find((x) => x.id === d.modeId)?.name} · {d.teamIds.map((t) => m.team(t)?.name).join(', ')} · 참가 {d.members.length}명
          </p>
        </div>
        <Badge tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Badge>
        <span className="flex items-center gap-1 font-mono text-3xl font-bold tabular-nums" data-testid="cmd-control-clock">
          <Clock className="size-6" /> {formatClock(elapsed)}
        </span>
        {nextMsg && (
          <span className="text-sm">
            다음: <b>{nextMsg.title}</b> {nextIn != null && <span className="tabular-nums text-muted-foreground">({nextIn > 0 ? formatClock(nextIn) : '곧'} 뒤)</span>}
          </span>
        )}
        <span className="ml-auto flex flex-wrap gap-1.5">
          {d.state === 'scheduled' && (
            <Button onClick={() => ctl('start')}>
              <Play /> 지금 시작
            </Button>
          )}
          {d.state === 'running' && (
            <Button variant="outline" onClick={() => ctl('pause')} data-testid="cmd-pause">
              <Pause /> 일시정지
            </Button>
          )}
          {d.state === 'paused' && (
            <Button onClick={() => ctl('resume')} data-testid="cmd-resume">
              <Play /> 계속
            </Button>
          )}
          {(d.state === 'running' || d.state === 'paused') && (
            <>
              <Button variant="outline" onClick={() => setAdHoc({ id: '', sort: 0, offsetMin: 0, title: '', bodyHtml: '', targetKind: 'all', targetIds: [], handling: 'assigned', answerKind: 'text', choices: [], correctIndex: null, limitMin: 5, popup: true, mapChanges: [] })} data-testid="cmd-adhoc">
                <MessageSquarePlus /> 즉석 메시지
              </Button>
              <Button variant="destructive" onClick={() => ctl('end', '훈련을 끝낼까요? 끝나면 답변을 받지 않습니다.')} data-testid="cmd-end">
                <Square /> 훈련 종료
              </Button>
            </>
          )}
        </span>
      </div>
      {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      {d.state === 'paused' && d.pausedAt && <p className="rounded-md bg-important/10 px-3 py-1.5 text-sm text-important">일시정지 중입니다. 시계와 자동 발송이 멈춰 있습니다. (서버 PC가 다시 켜졌을 때도 진행 중이던 훈련은 일시정지됩니다.)</p>}
      {noTarget.length > 0 && <p className="rounded-md bg-urgent/10 px-3 py-1.5 text-sm text-urgent">처리 담당이 없는 메시지가 있습니다: {noTarget.map((x) => x.title).join(', ')} (그 분류에 배치된 참가자가 없음)</p>}

      <div className="grid min-h-0 gap-3 xl:grid-cols-[18rem_minmax(0,1fr)_18rem]">
        {/* the time table */}
        <Card className="min-h-0 overflow-hidden">
          <CardHeader>
            <CardTitle>시간표</CardTitle>
            <span className="text-xs text-muted-foreground">
              보냄 {sent.length} · 남음 {pending.length}
            </span>
          </CardHeader>
          <div className="max-h-[60vh] divide-y divide-border overflow-y-auto" data-testid="cmd-timeline">
            {[...d.messages]
              .sort((a, b) => a.offsetMin - b.offsetMin || a.sort - b.sort)
              .map((x) => {
                const total = x.handling === 'first' ? 1 : x.targets.length
                const done = x.handling === 'first' ? Math.min(1, x.answers.length) : x.answers.filter((a) => x.targets.includes(a.memberId)).length
                return (
                  <div key={x.id} className={cn('px-3 py-1.5 text-sm', x.skipped && 'opacity-50')} data-testid="cmd-timeline-row">
                    <div className="flex items-center gap-1.5">
                      <span className="w-12 shrink-0 text-xs tabular-nums text-muted-foreground">{x.sentAt ? hm(x.sentAt) : `+${x.offsetMin}분`}</span>
                      <span className="min-w-0 flex-1 truncate font-medium">{x.title}</span>
                      {x.sentAt ? <Badge tone={x.done ? 'success' : 'drill'}>{x.done ? '완료' : '진행'}</Badge> : x.skipped ? <Badge>건너뜀</Badge> : <Badge tone="primary">예정</Badge>}
                    </div>
                    <p className="truncate pl-[3.375rem] text-[0.7rem] text-muted-foreground">
                      {targetText(m, x)} · {HANDLING_LABEL[x.handling]}
                    </p>
                    {x.sentAt && total > 0 && (
                      <div className="ml-[3.375rem] mt-0.5 h-1.5 overflow-hidden rounded-full bg-muted" title={`${done}/${total}`}>
                        <div className={cn('h-full', x.done ? 'bg-success' : 'bg-orange-500')} style={{ width: `${(done / total) * 100}%` }} />
                      </div>
                    )}
                    {!x.sentAt && !x.skipped && (d.state === 'running' || d.state === 'paused') && (
                      <div className="mt-1 flex gap-1 pl-[3.375rem]">
                        <Button size="sm" variant="outline" className="h-6 px-1.5" onClick={() => void act.run(() => host.api.post(`/api/command/drills/${d.id}/messages/${x.id}/send`))} data-testid="cmd-send-now">
                          <Send /> 지금
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => void act.run(() => host.api.post(`/api/command/drills/${d.id}/messages/${x.id}/skip`))}>
                          <FastForward /> 건너뛰기
                        </Button>
                        <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={() => setEditMsg(x)}>
                          <Pencil />
                        </Button>
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        </Card>

        {/* the situation board */}
        <div className="flex min-h-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">상황판</h3>
            {(['all', 'unanswered', 'late', 'ungraded'] as Filter[]).map((f) => (
              <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} className="h-7" onClick={() => setFilter(f)}>
                {{ all: '전체', unanswered: '미처리', late: '시간 초과', ungraded: '미평가' }[f]}
              </Button>
            ))}
            <Select className="h-7 w-40 text-xs" value={person} onChange={(e) => setPerson(e.target.value)} aria-label="사람별로 보기">
              <option value="">모든 사람</option>
              {d.members.map((x) => (
                <option key={x.memberId} value={x.memberId}>
                  {x.title} {x.name}
                </option>
              ))}
            </Select>
            <Button size="sm" variant={mapBig ? 'default' : 'outline'} className="ml-auto h-7" onClick={() => setMapBig((v) => !v)}>
              <MapPinned /> {mapBig ? '상황판 보기' : '지도 크게'}
            </Button>
          </div>
          {mapBig ? (
            <DrillMap d={d} at={d.state === 'ended' ? (d.endedAt ?? now) : now} edit={ops} className="h-[64vh]" />
          ) : (
            <div className="max-h-[64vh] space-y-2 overflow-y-auto pr-1" data-testid="cmd-control-board">
              {board.length ? (
                board.map((x) => (
                  <MsgCard key={x.id} m={m} d={d} msg={x} now={now} showAnswerBox={false}>
                    {x.answers.map((a) => (
                      <GradeBar key={a.id} d={d} a={a} />
                    ))}
                  </MsgCard>
                ))
              ) : (
                <EmptyNote>보여 줄 메시지가 없습니다.</EmptyNote>
              )}
            </div>
          )}
        </div>

        {/* who has answered; the map; the notes */}
        <div className="flex min-h-0 flex-col gap-3">
          <Card className="min-h-0 overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Users className="size-4" /> 참가자 현황
              </CardTitle>
            </CardHeader>
            <div className="max-h-72 divide-y divide-border overflow-y-auto text-sm" data-testid="cmd-participants">
              {memberStats.map(({ mb, got, answered, open, avg }) => (
                <div key={mb.memberId} className="px-3 py-1.5">
                  <div className="flex items-center gap-1.5">
                    <b className="truncate">{titled({ ...mb, mark: m.person(mb.memberId)?.mark })}</b>
                    {mb.common && <Badge>공통</Badge>}
                    <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                      {answered}/{got}
                    </span>
                  </div>
                  <p className="truncate text-[0.7rem] text-muted-foreground">
                    {m.team(mb.teamId)?.name ?? ''} {rolesOf(mb.roleIds) || '(분류 없음)'} · 평균 {formatSeconds(avg)}
                  </p>
                  {open.length > 0 && d.state !== 'ended' && (
                    <Button size="sm" variant="ghost" className="h-6 px-1.5 text-urgent" onClick={() => void act.run(() => Promise.all(open.map((x) => host.api.post(`/api/command/drills/${d.id}/messages/${x.id}/remind`, { memberIds: [mb.memberId] }))))} data-testid="cmd-remind">
                      <BellRing /> 미처리 {open.length}건 다시 알림
                    </Button>
                  )}
                </div>
              ))}
            </div>
          </Card>
          {!mapBig && (
            <Card>
              <CardHeader>
                <CardTitle>지도 (실시간 표식)</CardTitle>
              </CardHeader>
              <CardContent className="p-2">
                <DrillMap d={d} at={d.state === 'ended' ? (d.endedAt ?? now) : now} className="h-56" />
                <Button size="sm" variant="outline" className="mt-1 w-full" onClick={() => setMapBig(true)}>
                  <MapPinned /> 크게 열어 표식 고치기
                </Button>
              </CardContent>
            </Card>
          )}
          <Card className="min-h-0">
            <CardHeader>
              <CardTitle>통제 기록</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 p-3">
              <div className="flex gap-1">
                <Input className="h-8 text-sm" value={note} maxLength={1000} onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && note.trim() && void act.run(() => host.api.post(`/api/command/drills/${d.id}/notes`, { body: note }), () => setNote(''))} placeholder="시각과 함께 남길 메모 (Enter)" aria-label="통제 기록" />
              </div>
              <div className="max-h-44 space-y-1 overflow-y-auto text-sm" data-testid="cmd-notes">
                {[...d.notes].reverse().map((n) => (
                  <div key={n.id} className="group flex gap-2">
                    <span className="text-xs tabular-nums text-muted-foreground">{hm(n.at)}</span>
                    <span className="min-w-0 flex-1 whitespace-pre-wrap">{n.body}</span>
                    <button type="button" className="invisible cursor-pointer text-muted-foreground group-hover:visible" aria-label="기록 지우기" onClick={() => void act.run(() => host.api.del(`/api/command/drills/${d.id}/notes/${n.id}`))}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {d.state === 'ended' && (
        <div className="space-y-3">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <CheckCircle2 className="size-4" /> 정리 · 총평
              </CardTitle>
              <span className="text-xs text-muted-foreground">미평가 답변 {sent.reduce((s, x) => s + x.answers.filter((a) => !a.grade).length, 0)}건</span>
              <Button size="sm" disabled={act.busy || review === null} onClick={() => void act.run(() => host.api.put(`/api/command/drills/${d.id}/review`, { reviewHtml: review ?? '' }))}>
                총평 저장
              </Button>
            </CardHeader>
            <CardContent>{review !== null && <Editor value={review} onChange={setReview} minHeight={160} ariaLabel="총평" placeholder="잘된 점, 보완할 점, 다음 훈련에 반영할 사항" />}</CardContent>
          </Card>
          <Results m={m} d={d} />
        </div>
      )}

      {adHoc && (
        <MessageDialog
          m={m}
          modeId={d.modeId}
          value={adHoc}
          sendNow
          map={d.map}
          baseMarks={marksAt(d.marks, now)}
          onClose={() => setAdHoc(null)}
          onSave={(v) => {
            const { id: _i, sort: _s, ...body } = v
            void act.run(() => host.api.post(`/api/command/drills/${d.id}/messages`, body), () => setAdHoc(null))
          }}
        />
      )}
      {editMsg && (
        <MessageDialog
          m={m}
          modeId={d.modeId}
          value={editMsg}
          map={d.map}
          baseMarks={marksAt(d.marks, now)}
          onClose={() => setEditMsg(null)}
          onSave={(v) => {
            const { id: _i, sort: _s, ...rest } = v
            const body = { offsetMin: rest.offsetMin, title: rest.title, bodyHtml: rest.bodyHtml, targetKind: rest.targetKind, targetIds: rest.targetIds, handling: rest.handling, answerKind: rest.answerKind, choices: rest.choices, correctIndex: rest.correctIndex, limitMin: rest.limitMin, popup: rest.popup, mapChanges: rest.mapChanges }
            void act.run(() => host.api.patch(`/api/command/drills/${d.id}/messages/${editMsg.id}`, body), () => setEditMsg(null))
          }}
        />
      )}
    </div>
  )
}
