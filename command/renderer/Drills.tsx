/** 훈련 탭: 진행 중·예정·끝난 훈련, 훈련 시작(지휘대담당), 시나리오 목록·편집. */
import { useEffect, useState } from 'react'
import { Copy, FilePlus, Flag, Pencil, Play, Siren, Trash2 } from 'lucide-react'
import { atTime, ymd } from '../shared/logic'
import type { Model } from './model'
import { when } from './model'
import { useAct, useScenarios } from './data'
import { useHost } from './host'
import { ScenarioEditor } from './ScenarioEditor'
import { STATE_LABEL, stateTone } from './DrillView'
import { TimePick } from './Settings'
import { Badge, Button, Card, CardHeader, CardTitle, Dialog, EmptyNote, Field, Input, Select, Tabs } from './ui'

export function Drills({ m, now, onOpen }: { m: Model; now: number; onOpen: (id: string) => void }): React.JSX.Element {
  const host = useHost()
  const manager = m.s.me.isManager
  const [view, setView] = useState<'drills' | 'scenarios'>('drills')
  const [editing, setEditing] = useState<string | null | undefined>(undefined)
  const [start, setStart] = useState<{ scenarioId: string | null } | null>(null)
  const scen = useScenarios(manager)
  const act = useAct()
  if (editing !== undefined) return <ScenarioEditor m={m} id={editing} onClose={() => setEditing(undefined)} />
  const groups: { title: string; list: typeof m.s.drills }[] = [
    { title: '진행 중', list: m.s.drills.filter((d) => d.state === 'running' || d.state === 'paused') },
    { title: '예정', list: m.s.drills.filter((d) => d.state === 'scheduled') },
    { title: '끝난 훈련 (최근 30일)', list: m.s.drills.filter((d) => d.state === 'ended') }
  ]
  return (
    <div className="space-y-4" data-testid="cmd-drills">
      {manager && (
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={view}
            onChange={setView}
            items={[
              { key: 'drills', label: '훈련', icon: Flag },
              { key: 'scenarios', label: '시나리오', icon: FilePlus }
            ]}
          />
          <Button className="ml-auto" onClick={() => setStart({ scenarioId: null })} data-testid="cmd-drill-new">
            <Play /> 훈련 시작
          </Button>
        </div>
      )}
      {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      {view === 'drills' ? (
        groups.map((g) => (
          <Card key={g.title}>
            <CardHeader>
              <CardTitle>{g.title}</CardTitle>
              <Badge>{g.list.length}</Badge>
            </CardHeader>
            {g.list.length ? (
              <div className="divide-y divide-border">
                {g.list.map((d) => (
                  <div key={d.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" data-testid="cmd-drill-row">
                    <Siren className="size-4 text-orange-600" />
                    <button type="button" className="cursor-pointer font-semibold hover:underline" onClick={() => onOpen(d.id)}>
                      {d.title}
                    </button>
                    <Badge tone={stateTone(d.state)}>{STATE_LABEL[d.state]}</Badge>
                    {d.pendingForMe > 0 && <Badge tone="urgent">내가 처리할 메시지 {d.pendingForMe}</Badge>}
                    {!d.participant && d.state !== 'ended' && <Badge>참가 안 함</Badge>}
                    <span className="text-muted-foreground">
                      {m.s.modes.find((x) => x.id === d.modeId)?.name} · {d.teamIds.map((t) => m.team(t)?.name).join(', ')} · {d.startedAt ? when(d.startedAt) : d.startAt ? `${when(d.startAt)} 시작 예정` : ''}
                    </span>
                    <span className="ml-auto flex gap-1">
                      <Button size="sm" variant="outline" onClick={() => onOpen(d.id)}>
                        열기
                      </Button>
                      {manager && d.state !== 'ended' && (
                        <Button size="sm" onClick={() => host.openControlRoom(d.id)}>
                          통제실
                        </Button>
                      )}
                      {manager && (d.state === 'ended' || d.state === 'scheduled') && (
                        <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="훈련 기록 삭제" onClick={() => window.confirm(`"${d.title}"을(를) 지울까요? 기록이 모두 지워집니다.`) && void act.run(() => host.api.post(`/api/command/drills/${d.id}/${d.state === 'scheduled' ? 'end' : 'delete'}`).then(() => (d.state === 'scheduled' ? host.api.post(`/api/command/drills/${d.id}/delete`) : null)))}>
                          <Trash2 />
                        </Button>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyNote>없습니다.</EmptyNote>
            )}
          </Card>
        ))
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>시나리오</CardTitle>
            <Button size="sm" variant="outline" onClick={() => setEditing(null)} data-testid="cmd-scenario-new">
              <FilePlus /> 새 시나리오
            </Button>
          </CardHeader>
          {scen.data?.length ? (
            <div className="divide-y divide-border">
              {scen.data.map((x) => (
                <div key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2 text-sm" data-testid="cmd-scenario-row">
                  <b>{x.title}</b>
                  <span className="text-muted-foreground">
                    {m.s.modes.find((y) => y.id === x.modeId)?.name} · 메시지 {x.messages}개 · {when(x.updatedAt)} 고침
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" onClick={() => setStart({ scenarioId: x.id })}>
                      <Play /> 이 시나리오로 시작
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="고치기" onClick={() => setEditing(x.id)}>
                      <Pencil />
                    </Button>
                    <Button size="icon-sm" variant="ghost" aria-label="복사" onClick={() => void act.run(() => host.api.post(`/api/command/scenarios/${x.id}/copy`))}>
                      <Copy />
                    </Button>
                    <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="삭제" onClick={() => window.confirm(`"${x.title}"을(를) 지울까요?`) && void act.run(() => host.api.del(`/api/command/scenarios/${x.id}`))}>
                      <Trash2 />
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <EmptyNote>시나리오가 없습니다. 새 시나리오를 만들어 상황 메시지를 시간 순서로 적어 두세요.</EmptyNote>
          )}
        </Card>
      )}
      <StartDialog m={m} now={now} value={start} onClose={() => setStart(null)} onStarted={(id) => (setStart(null), onOpen(id))} />
    </div>
  )
}

function StartDialog({ m, now, value, onClose, onStarted }: { m: Model; now: number; value: { scenarioId: string | null } | null; onClose: () => void; onStarted: (id: string) => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const scen = useScenarios(!!value)
  const [f, setF] = useState({ scenarioId: '', modeId: '', title: '', teamIds: [] as string[], withCommon: false, later: false, date: ymd(now), time: '14:00' })
  useEffect(() => {
    if (!value) return
    const sc = scen.data?.find((x) => x.id === value.scenarioId)
    setF({ scenarioId: value.scenarioId ?? '', modeId: sc?.modeId ?? m.modes[0]?.id ?? '', title: sc ? `${sc.title}` : '', teamIds: m.shift ? [m.shift.teamId] : [], withCommon: false, later: false, date: ymd(Date.now()), time: '14:00' })
  }, [value, scen.data, m])
  const sc = scen.data?.find((x) => x.id === f.scenarioId)
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title="훈련 시작"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button
            disabled={!f.title.trim() || !f.teamIds.length || act.busy}
            onClick={() =>
              void act.run(
                () => host.api.post<{ id: string }>('/api/command/drills', { scenarioId: f.scenarioId || null, modeId: f.modeId, title: f.title, teamIds: f.teamIds, withCommon: f.withCommon, startAt: f.later ? atTime(f.date, f.time) : null }),
                (r) => onStarted(r.id)
              )
            }
            data-testid="cmd-drill-start"
          >
            <Play /> {f.later ? '예약' : '지금 시작'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="시나리오">
          <Select value={f.scenarioId} onChange={(e) => {
            const s = scen.data?.find((x) => x.id === e.target.value)
            setF({ ...f, scenarioId: e.target.value, modeId: s?.modeId ?? f.modeId, title: s ? s.title : f.title })
          }} aria-label="시나리오">
            <option value="">(시나리오 없이 — 즉석 메시지로만 진행)</option>
            {scen.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title} (메시지 {x.messages}개)
              </option>
            ))}
          </Select>
        </Field>
        <Field label="훈련 이름">
          <Input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} aria-label="훈련 이름" />
        </Field>
        <Field label="근무 유형" hint={sc ? '시나리오의 근무 유형입니다.' : undefined}>
          <Select value={f.modeId} disabled={!!sc} onChange={(e) => setF({ ...f, modeId: e.target.value })} aria-label="훈련 근무 유형">
            {m.s.modes.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <p className="mb-1 text-sm font-medium">참가 조</p>
          <div className="flex flex-wrap gap-3 text-sm">
            {m.s.teams.map((t) => (
              <label key={t.id} className="flex cursor-pointer items-center gap-1.5">
                <input type="checkbox" checked={f.teamIds.includes(t.id)} onChange={(e) => setF({ ...f, teamIds: e.target.checked ? [...f.teamIds, t.id] : f.teamIds.filter((x) => x !== t.id) })} aria-label={t.name} />
                {t.name} <span className="text-xs text-muted-foreground">{t.members.length}명{m.shift?.teamId === t.id ? ' · 오늘' : ''}</span>
              </label>
            ))}
          </div>
          <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={f.withCommon} onChange={(e) => setF({ ...f, withCommon: e.target.checked })} /> 공통업무 담당자도 참가
          </label>
          <p className="mt-1 text-xs text-muted-foreground">참가자는 시작하는 순간의 편성으로 정해집니다(예외자·임시 인원 제외).</p>
        </div>
        <div className="space-y-1 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={!f.later} onChange={() => setF({ ...f, later: false })} /> 지금 시작
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={f.later} onChange={() => setF({ ...f, later: true })} /> 시각을 정해 자동 시작
          </label>
          {f.later && (
            <span className="flex gap-1 pl-6">
              <Input type="date" className="w-40" value={f.date} onChange={(e) => e.target.value && setF({ ...f, date: e.target.value })} aria-label="시작 날짜" />
              <TimePick label="시작" value={f.time} onChange={(t) => setF({ ...f, time: t })} />
            </span>
          )}
        </div>
        {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      </div>
    </Dialog>
  )
}
