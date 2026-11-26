/**
 * 설정 (the server PC and the 지휘대담당): 지휘대담당, 근무 유형, 조, 순환, 분류와 임무, 배치,
 * 공통업무, 예외자, 대리자, 미등록 인원 (the host's list, read only here).
 */
import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Copy, FileText, Pencil, Plus, Search, Trash2, UserPlus, Users } from 'lucide-react'
import type { CmdCommon, CmdException, CmdPerson, CmdRole, CmdTeam } from '../shared/types'
import { atTime, rolePath, teamAt, ymd } from '../shared/logic'
import type { Model } from './model'
import { when } from './model'
import { useAct, useRoleDuty } from './data'
import { useHost } from './host'
import { Editor } from './rich'
import { SubstitutionsCard } from './Substitutions'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, EmptyNote, Field, Input, Names, PersonName, Select, Textarea, Unreg, cn, titled, titledText, useAsk } from './ui'

const COLORS = ['#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed', '#db2777', '#475569']
const pad = (n: number): string => String(n).padStart(2, '0')

/** Hour and minute lists (no browser time picker: it has no 확인 button). */
export function TimePick({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }): React.JSX.Element {
  const [h, mi] = (value || '09:00').split(':').map(Number)
  const cls = 'h-9 cursor-pointer rounded-md border border-input bg-background px-1.5 text-sm'
  return (
    <span className="inline-flex gap-1">
      <select className={cls} aria-label={`${label} 시`} value={h} onChange={(e) => onChange(`${pad(Number(e.target.value))}:${pad(mi)}`)}>
        {Array.from({ length: 24 }, (_, i) => (
          <option key={i} value={i}>
            {pad(i)}시
          </option>
        ))}
      </select>
      <select className={cls} aria-label={`${label} 분`} value={mi} onChange={(e) => onChange(`${pad(h)}:${pad(Number(e.target.value))}`)}>
        {Array.from({ length: 12 }, (_, i) => i * 5).map((x) => (
          <option key={x} value={x}>
            {pad(x)}분
          </option>
        ))}
      </select>
    </span>
  )
}

function Move({ onUp, onDown, first, last }: { onUp: () => void; onDown: () => void; first: boolean; last: boolean }): React.JSX.Element {
  return (
    <span className="inline-flex">
      <Button size="icon-sm" variant="ghost" aria-label="위로" disabled={first} onClick={onUp}>
        <ArrowUp />
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="아래로" disabled={last} onClick={onDown}>
        <ArrowDown />
      </Button>
    </span>
  )
}
const swap = <T,>(list: T[], i: number, j: number): T[] => {
  const a = [...list]
  ;[a[i], a[j]] = [a[j], a[i]]
  return a
}

/** Picks people: grouped by 조, with a search; some can be disabled with the reason. */
export function PeoplePicker({ open, title, people, value, onClose, onSave, note, max }: { open: boolean; title: string; people: (CmdPerson & { group?: string; why?: string })[]; value: string[]; onClose: () => void; onSave: (ids: string[]) => void; note?: string; max?: number }): React.JSX.Element {
  const [sel, setSel] = useState<string[]>(value)
  const [q, setQ] = useState('')
  useEffect(() => {
    if (open) {
      setSel(value)
      setQ('')
    }
  }, [open, value])
  const shown = people.filter((p) => !q.trim() || `${p.name} ${p.title} ${p.dept}`.includes(q.trim()))
  const groups = [...new Set(shown.map((p) => p.group ?? ''))]
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <span className="mr-auto self-center text-xs text-muted-foreground">{sel.length}명 선택</span>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => onSave(sel)} data-testid="picker-save">
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-2">
        {note && <p className="text-xs text-muted-foreground">{note}</p>}
        <div className="relative">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="이름·직위·소속 찾기" value={q} onChange={(e) => setQ(e.target.value)} aria-label="사람 찾기" />
        </div>
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {groups.map((g) => (
            <div key={g}>
              {g && <p className="mb-1 text-xs font-semibold text-muted-foreground">{g}</p>}
              <div className="grid gap-x-3 gap-y-0.5 sm:grid-cols-2">
                {shown
                  .filter((p) => (p.group ?? '') === g)
                  .map((p) => {
                    const on = sel.includes(p.id)
                    const off = !!p.why && !on
                    return (
                      <label key={p.id} className={cn('flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-sm hover:bg-muted', off && 'cursor-not-allowed opacity-50')} title={p.why}>
                        <input type="checkbox" checked={on} disabled={off || (!on && !!max && sel.length >= max)} onChange={(e) => setSel(e.target.checked ? [...sel, p.id] : sel.filter((x) => x !== p.id))} aria-label={p.name} />
                        <span className="truncate">{titled(p)}</span>
                        <Unreg p={p} />
                        {p.why && <span className="truncate text-xs text-muted-foreground">{p.why}</span>}
                      </label>
                    )
                  })}
              </div>
            </div>
          ))}
          {!shown.length && <EmptyNote>찾는 사람이 없습니다.</EmptyNote>}
        </div>
      </div>
    </Dialog>
  )
}

export function Settings({ m, now }: { m: Model; now: number }): React.JSX.Element {
  const [modeId, setModeId] = useState(m.s.modes[0]?.id ?? '')
  useEffect(() => {
    if (!m.s.modes.some((x) => x.id === modeId)) setModeId(m.s.modes[0]?.id ?? '')
  }, [m.s.modes, modeId])
  return (
    <div className="space-y-4" data-testid="cmd-settings">
      <ManagersCard m={m} />
      <ModesCard m={m} />
      <TeamsCard m={m} />
      <RotationCard m={m} now={now} />
      <Card>
        <CardHeader>
          <CardTitle>분류와 임무 · 배치</CardTitle>
          <label className="flex items-center gap-2 text-sm">
            근무 유형
            <Select className="w-56" value={modeId} onChange={(e) => setModeId(e.target.value)} aria-label="설정할 근무 유형">
              {m.s.modes.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.hidden ? ' (숨김)' : ''}
                </option>
              ))}
            </Select>
          </label>
        </CardHeader>
        <CardContent className="space-y-6">
          <RolesEditor m={m} modeId={modeId} />
          <AssignEditor m={m} modeId={modeId} />
        </CardContent>
      </Card>
      <CommonCard m={m} />
      <ExceptionsCard m={m} now={now} />
      <SubstitutionsCard m={m} now={now} />
      <UnregisteredCard m={m} />
    </div>
  )
}

function ErrorLine({ err }: { err: string }): React.JSX.Element | null {
  return err ? <p className="text-sm text-urgent" role="alert">{err}</p> : null
}

function ManagersCard({ m }: { m: Model }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [open, setOpen] = useState(false)
  const members = m.s.people.filter((p) => !p.temp)
  return (
    <Card>
      <CardHeader>
        <CardTitle>지휘대담당 (최대 3명)</CardTitle>
        {m.s.me.isOwner ? (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)} data-testid="cmd-managers-edit">
            <Users /> 지정하기
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">서버 PC에서만 지정합니다</span>
        )}
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        <p>
          {m.s.managers.length ? m.s.managers.map((x) => <Badge key={x.memberId} tone="primary" className="mr-1">지휘대담당 {x.name}</Badge>) : <span className="text-muted-foreground">지정된 사람이 없습니다. 서버 PC만 관리합니다.</span>}
        </p>
        <p className="text-xs text-muted-foreground">서버 PC와 지휘대담당이 편성·설정·공지·자료·시나리오·훈련을 관리합니다. 훈련담당자도 지휘대담당입니다.</p>
        <ErrorLine err={act.err} />
      </CardContent>
      <PeoplePicker open={open} title="지휘대담당 지정" people={members} value={m.s.managers.map((x) => x.memberId)} max={3} note="3명까지 고릅니다." onClose={() => setOpen(false)} onSave={(ids) => void act.run(() => host.api.put('/api/command/managers', { memberIds: ids }), () => setOpen(false))} />
    </Card>
  )
}

function ModesCard({ m }: { m: Model }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const modes = m.s.modes
  const { ask, dialog } = useAsk()
  const add = async (): Promise<void> => {
    const name = await ask('새 근무 유형 이름')
    if (name) void act.run(() => host.api.post('/api/command/modes', { name }))
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>근무 유형</CardTitle>
        <Button size="sm" variant="outline" onClick={() => void add()}>
          <Plus /> 근무 유형 추가
        </Button>
      </CardHeader>
      <CardContent className="space-y-1">
        <p className="text-xs text-muted-foreground">조와 조원은 모든 근무 유형에서 같고, 근무 유형마다 분류(임무명)·임무 내용·배치가 따로입니다.</p>
        {modes.map((x, i) => (
          <div key={x.id} className="flex items-center gap-2 text-sm" data-testid="cmd-mode-row">
            <b className={cn('min-w-0 flex-1 truncate', x.hidden && 'text-muted-foreground line-through')}>{x.name}</b>
            <Move first={i === 0} last={i === modes.length - 1} onUp={() => void act.run(() => host.api.put('/api/command/modes/order', { ids: swap(modes, i, i - 1).map((y) => y.id) }))} onDown={() => void act.run(() => host.api.put('/api/command/modes/order', { ids: swap(modes, i, i + 1).map((y) => y.id) }))} />
            <Button size="sm" variant="ghost" onClick={() => void ask('근무 유형 이름', x.name).then((name) => void (name && act.run(() => host.api.patch(`/api/command/modes/${x.id}`, { name }))))}>
              <Pencil /> 이름
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void act.run(() => host.api.patch(`/api/command/modes/${x.id}`, { hidden: !x.hidden }))}>
              {x.hidden ? '보이기' : '숨기기'}
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label={`${x.name} 삭제`} onClick={() => window.confirm(`${x.name}을(를) 지울까요? 분류와 배치도 함께 지워집니다.`) && void act.run(() => host.api.del(`/api/command/modes/${x.id}`))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <ErrorLine err={act.err} />
      </CardContent>
      {dialog}
    </Card>
  )
}

function TeamsCard({ m }: { m: Model }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [members, setMembers] = useState<CmdTeam | null>(null)
  const teams = m.s.teams
  const { ask, dialog } = useAsk()
  const add = async (): Promise<void> => {
    const name = await ask('새 조 이름', '', '예: A조')
    if (name) void act.run(() => host.api.post('/api/command/teams', { name, color: COLORS[teams.length % COLORS.length] }))
  }
  const pickable = useMemo(
    () =>
      m.s.people.map((p) => {
        const t = m.team(m.teamOf(p.id))
        return { ...p, group: p.temp ? unregGroup(p) : p.dept || '소속 없음', why: leftWhy(p) ?? (m.excepted.has(p.id) ? '예외자' : t && t.id !== members?.id ? `${t.name} (옮겨짐)` : undefined) }
      }),
    [m, members]
  )
  return (
    <Card>
      <CardHeader>
        <CardTitle>조</CardTitle>
        <Button size="sm" variant="outline" onClick={() => void add()} data-testid="cmd-team-add">
          <Plus /> 조 추가
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!teams.length && <EmptyNote>조가 없습니다. A조·B조·C조·D조처럼 만드세요.</EmptyNote>}
        {teams.map((t, i) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="cmd-team-row">
            <span className="flex gap-0.5">
              {COLORS.map((c) => (
                <button key={c} type="button" aria-label={`색 ${c}`} className={cn('size-4 cursor-pointer rounded-full border-2', t.color === c ? 'border-foreground' : 'border-transparent')} style={{ background: c }} onClick={() => void act.run(() => host.api.patch(`/api/command/teams/${t.id}`, { color: c }))} />
              ))}
            </span>
            <b>{t.name}</b>
            <span className="text-muted-foreground">{t.members.length}명</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              <Names people={t.members.map((p) => m.person(p))} />
            </span>
            <Button size="sm" variant="outline" onClick={() => setMembers(t)}>
              <Users /> 조원
            </Button>
            <Move first={i === 0} last={i === teams.length - 1} onUp={() => void act.run(() => host.api.put('/api/command/teams/order', { ids: swap(teams, i, i - 1).map((y) => y.id) }))} onDown={() => void act.run(() => host.api.put('/api/command/teams/order', { ids: swap(teams, i, i + 1).map((y) => y.id) }))} />
            <Button size="icon-sm" variant="ghost" aria-label="이름 바꾸기" onClick={() => void ask('조 이름', t.name).then((name) => void (name && act.run(() => host.api.patch(`/api/command/teams/${t.id}`, { name }))))}>
              <Pencil />
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label={`${t.name} 삭제`} onClick={() => window.confirm(`${t.name}을(를) 지울까요?`) && void act.run(() => host.api.del(`/api/command/teams/${t.id}`))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">한 사람은 한 조에만 들어갑니다. 다른 조의 사람을 고르면 이 조로 옮겨지고, 그 조에서 맡던 분류·공통업무(조별)는 빠집니다.</p>
        <ErrorLine err={act.err} />
      </CardContent>
      {dialog}
      <PeoplePicker open={!!members} title={`${members?.name ?? ''} 조원`} people={pickable} value={members?.members ?? []} onClose={() => setMembers(null)} onSave={(ids) => members && void act.run(() => host.api.put(`/api/command/teams/${members.id}/members`, { personIds: ids }), () => setMembers(null))} />
    </Card>
  )
}

function RotationCard({ m, now }: { m: Model; now: number }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const r = m.s.rotation
  const [f, setF] = useState({ baseDate: r?.baseDate ?? ymd(now), shiftTime: r?.shiftTime ?? '09:00', periodDays: r?.periodDays ?? 7, order: r?.order ?? m.s.teams.map((t) => t.id) })
  useEffect(() => {
    setF({ baseDate: r?.baseDate ?? ymd(Date.now()), shiftTime: r?.shiftTime ?? '09:00', periodDays: r?.periodDays ?? 7, order: r?.order?.length ? r.order : m.s.teams.map((t) => t.id) })
  }, [r, m.s.teams])
  const [ov, setOv] = useState<{ fromDate: string; fromTime: string; toDate: string; toTime: string; teamId: string; note: string } | null>(null)
  const preview = useMemo(() => {
    const out: { teamId: string; from: number; to: number }[] = []
    const rot = { ...f, order: f.order.filter((id) => m.s.teams.some((t) => t.id === id)) }
    let at = now
    for (let i = 0; i < 8; i++) {
      const s = teamAt(rot, m.s.overrides, at)
      if (!s) break
      out.push(s)
      at = s.to
    }
    return out
  }, [f, m.s.teams, m.s.overrides, now])
  const inOrder = f.order.filter((id) => m.s.teams.some((t) => t.id === id))
  const outOfOrder = m.s.teams.filter((t) => !inOrder.includes(t.id))
  return (
    <Card>
      <CardHeader>
        <CardTitle>순환 (오늘의 조)</CardTitle>
        <Button size="sm" disabled={act.busy || !inOrder.length} onClick={() => void act.run(() => host.api.put('/api/command/rotation', { ...f, order: inOrder }))} data-testid="cmd-rotation-save">
          순환 저장
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="기준일 (순서의 첫 조가 시작하는 날)">
              <Input type="date" className="w-44" value={f.baseDate} onChange={(e) => e.target.value && setF({ ...f, baseDate: e.target.value })} aria-label="기준일" />
            </Field>
            <Field label="교대 시각">
              <TimePick label="교대 시각" value={f.shiftTime} onChange={(v) => setF({ ...f, shiftTime: v })} />
            </Field>
            <Field label="주기(일)">
              <Input type="number" min={1} max={31} className="w-20" value={f.periodDays} onChange={(e) => setF({ ...f, periodDays: Math.min(31, Math.max(1, Number(e.target.value) || 1)) })} aria-label="주기" />
            </Field>
          </div>
          <div>
            <p className="mb-1 text-sm font-medium">조 순서</p>
            {inOrder.map((id, i) => (
              <div key={id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-right tabular-nums text-muted-foreground">{i + 1}</span>
                <b className="flex-1">{m.team(id)?.name}</b>
                <Move first={i === 0} last={i === inOrder.length - 1} onUp={() => setF({ ...f, order: swap(inOrder, i, i - 1) })} onDown={() => setF({ ...f, order: swap(inOrder, i, i + 1) })} />
                <Button size="sm" variant="ghost" onClick={() => setF({ ...f, order: inOrder.filter((x) => x !== id) })}>
                  빼기
                </Button>
              </div>
            ))}
            {outOfOrder.map((t) => (
              <div key={t.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                <span className="w-5" />
                <span className="flex-1">{t.name} (순환에서 빠짐)</span>
                <Button size="sm" variant="ghost" onClick={() => setF({ ...f, order: [...inOrder, t.id] })}>
                  넣기
                </Button>
              </div>
            ))}
          </div>
          <ErrorLine err={act.err} />
        </div>
        <div className="space-y-3">
          <div>
            <p className="mb-1 text-sm font-medium">앞으로의 순서 (미리보기)</p>
            <ul className="space-y-0.5 text-sm" data-testid="cmd-rotation-preview">
              {preview.map((s) => (
                <li key={s.from}>
                  <b className="mr-2">{m.team(s.teamId)?.name}</b>
                  <span className="text-muted-foreground">
                    {when(s.from)} ~ {when(s.to)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 flex items-center">
              <p className="text-sm font-medium">수동 지정 (맞교대·연휴 등)</p>
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setOv({ fromDate: ymd(now), fromTime: f.shiftTime, toDate: ymd(now + 86400000), toTime: f.shiftTime, teamId: m.s.teams[0]?.id ?? '', note: '' })}>
                <Plus /> 기간 지정
              </Button>
            </div>
            {m.s.overrides
              .filter((o) => o.toAt > now - 30 * 86400000)
              .map((o) => (
                <div key={o.id} className="flex items-center gap-2 text-sm">
                  <b>{m.team(o.teamId)?.name}</b>
                  <span className="text-muted-foreground">
                    {when(o.fromAt)} ~ {when(o.toAt)} {o.note}
                  </span>
                  <Button size="icon-sm" variant="ghost" className="ml-auto text-urgent" aria-label="수동 지정 삭제" onClick={() => void act.run(() => host.api.del(`/api/command/overrides/${o.id}`))}>
                    <Trash2 />
                  </Button>
                </div>
              ))}
          </div>
        </div>
      </CardContent>
      <Dialog
        open={!!ov}
        onClose={() => setOv(null)}
        title="기간 수동 지정"
        footer={
          <>
            <Button variant="outline" onClick={() => setOv(null)}>
              취소
            </Button>
            <Button onClick={() => ov && void act.run(() => host.api.post('/api/command/overrides', { fromAt: atTime(ov.fromDate, ov.fromTime), toAt: atTime(ov.toDate, ov.toTime), teamId: ov.teamId, note: ov.note }), () => setOv(null))}>저장</Button>
          </>
        }
      >
        {ov && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <Field label="시작">
                <span className="flex gap-1">
                  <Input type="date" className="w-40" value={ov.fromDate} onChange={(e) => e.target.value && setOv({ ...ov, fromDate: e.target.value })} aria-label="시작 날짜" />
                  <TimePick label="시작" value={ov.fromTime} onChange={(v) => setOv({ ...ov, fromTime: v })} />
                </span>
              </Field>
              <Field label="끝">
                <span className="flex gap-1">
                  <Input type="date" className="w-40" value={ov.toDate} onChange={(e) => e.target.value && setOv({ ...ov, toDate: e.target.value })} aria-label="끝 날짜" />
                  <TimePick label="끝" value={ov.toTime} onChange={(v) => setOv({ ...ov, toTime: v })} />
                </span>
              </Field>
            </div>
            <Field label="근무할 조">
              <Select value={ov.teamId} onChange={(e) => setOv({ ...ov, teamId: e.target.value })}>
                {m.s.teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="메모 (선택)">
              <Input value={ov.note} maxLength={100} onChange={(e) => setOv({ ...ov, note: e.target.value })} placeholder="예: 추석 연휴 맞교대" />
            </Field>
            <ErrorLine err={act.err} />
          </div>
        )}
      </Dialog>
    </Card>
  )
}

function RolesEditor({ m, modeId }: { m: Model; modeId: string }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const tree = m.tree(modeId)
  const [duty, setDuty] = useState<CmdRole | null>(null)
  const { ask, dialog } = useAsk()
  const add = async (parentId: string | null): Promise<void> => {
    const name = await ask(parentId ? '하위 분류 이름' : '분류 이름', '', parentId ? undefined : '예: 조장, 상황조사요원')
    if (name) void act.run(() => host.api.post('/api/command/roles', { modeId, parentId, name }))
  }
  const siblings = (r: CmdRole): CmdRole[] => tree.map((x) => x.role).filter((x) => x.parentId === r.parentId)
  return (
    <div className="space-y-2" data-testid="cmd-roles">
      <div className="flex items-center gap-2">
        <h4 className="text-sm font-semibold">분류(임무) 트리</h4>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => void add(null)} data-testid="cmd-role-add">
          <Plus /> 대분류 추가
        </Button>
      </div>
      {!tree.length && <EmptyNote>분류가 없습니다. 대분류를 추가하고, 그 아래에 중분류·소분류를 넣으세요.</EmptyNote>}
      {tree.map(({ role, depth }) => {
        const sib = siblings(role)
        const i = sib.findIndex((x) => x.id === role.id)
        return (
          <div key={role.id} className="flex flex-wrap items-center gap-1.5 rounded-md border border-border px-2 py-1 text-sm" style={{ marginLeft: depth * 20 }} data-testid="cmd-role-row">
            <b className={depth ? 'font-medium' : ''}>{role.name}</b>
            {role.hasDuty ? <Badge tone="success">임무 설명 있음</Badge> : <Badge>임무 설명 없음</Badge>}
            <span className="ml-auto flex items-center gap-0.5">
              <Button size="sm" variant="ghost" onClick={() => setDuty(role)}>
                <FileText /> 임무
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void add(role.id)}>
                <Plus /> 하위
              </Button>
              <Move first={i === 0} last={i === sib.length - 1} onUp={() => void act.run(() => host.api.put('/api/command/roles/order', { ids: swap(sib, i, i - 1).map((x) => x.id) }))} onDown={() => void act.run(() => host.api.put('/api/command/roles/order', { ids: swap(sib, i, i + 1).map((x) => x.id) }))} />
              <select
                className="h-8 max-w-36 rounded-md border border-input bg-background px-1 text-xs"
                aria-label={`${role.name} 상위 분류`}
                value={role.parentId ?? ''}
                onChange={(e) => void act.run(() => host.api.patch(`/api/command/roles/${role.id}`, { parentId: e.target.value || null }))}
              >
                <option value="">(대분류)</option>
                {tree
                  .filter((x) => x.role.id !== role.id)
                  .map((x) => (
                    <option key={x.role.id} value={x.role.id}>
                      {'  '.repeat(x.depth)}
                      {x.role.name}
                    </option>
                  ))}
              </select>
              <Button size="icon-sm" variant="ghost" aria-label="이름 바꾸기" onClick={() => void ask('분류 이름', role.name).then((name) => void (name && act.run(() => host.api.patch(`/api/command/roles/${role.id}`, { name }))))}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label={`${role.name} 삭제`} onClick={() => window.confirm(`"${role.name}"과(와) 그 아래 분류, 배치를 모두 지울까요?`) && void act.run(() => host.api.del(`/api/command/roles/${role.id}`))}>
                <Trash2 />
              </Button>
            </span>
          </div>
        )
      })}
      <ErrorLine err={act.err} />
      {dialog}
      <DutyDialog role={duty} roles={m.s.roles} onClose={() => setDuty(null)} />
    </div>
  )
}

function DutyDialog({ role, roles, onClose }: { role: CmdRole | null; roles: CmdRole[]; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const q = useRoleDuty(role?.id ?? null)
  const [html, setHtml] = useState('')
  const [loaded, setLoaded] = useState('')
  useEffect(() => {
    if (q.data && role && loaded !== role.id) {
      setHtml(q.data.dutyHtml)
      setLoaded(role.id)
    }
    if (!role) setLoaded('')
  }, [q.data, role, loaded])
  return (
    <Dialog
      open={!!role}
      onClose={onClose}
      width="max-w-3xl"
      title={`임무 설명 · ${role ? rolePath(roles, role.id) : ''}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={act.busy || loaded !== role?.id} onClick={() => role && void act.run(() => host.api.patch(`/api/command/roles/${role.id}`, { dutyHtml: html }), () => onClose())}>
            저장
          </Button>
        </>
      }
    >
      {loaded === role?.id ? <Editor value={html} onChange={setHtml} minHeight={260} ariaLabel="임무 설명" placeholder="이 분류가 하는 일, 순서, 연락처, 주의할 점…" /> : <p className="text-sm text-muted-foreground">불러오는 중…</p>}
      <ErrorLine err={act.err} />
    </Dialog>
  )
}

function AssignEditor({ m, modeId }: { m: Model; modeId: string }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [teamId, setTeamId] = useState(m.s.teams[0]?.id ?? '')
  const [pick, setPick] = useState<CmdRole | null>(null)
  const [from, setFrom] = useState('')
  useEffect(() => {
    if (!m.s.teams.some((t) => t.id === teamId)) setTeamId(m.s.teams[0]?.id ?? '')
  }, [m.s.teams, teamId])
  const tree = m.tree(modeId)
  const team = m.team(teamId)
  const roleIds = new Set(tree.map((x) => x.role.id))
  const others = m.s.modes.filter((x) => x.id !== modeId)
  const unplaced = (team?.members ?? []).filter((p) => !m.s.assignments.some((a) => a.personId === p && a.teamId === teamId && roleIds.has(a.roleId)))
  return (
    <div className="space-y-2" data-testid="cmd-assign">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-sm font-semibold">배치</h4>
        <span className="flex flex-wrap gap-1" role="tablist" aria-label="조">
          {m.s.teams.map((t) => (
            <Button key={t.id} size="sm" variant={teamId === t.id ? 'default' : 'outline'} onClick={() => setTeamId(t.id)} data-team={t.name}>
              {t.name}
            </Button>
          ))}
        </span>
        {others.length > 0 && (
          <span className="ml-auto flex items-center gap-1 text-xs">
            <Select className="h-8 w-48 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="배치를 가져올 근무 유형">
              <option value="">다른 근무 유형에서 가져오기…</option>
              {others.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="outline" disabled={!from} onClick={() => void act.run(() => host.api.post<{ copied: number }>('/api/command/assignments/copy', { fromModeId: from, toModeId: modeId }), (r) => window.alert(`같은 이름의 분류로 ${r.copied}명을 가져왔습니다.`))}>
              <Copy /> 가져오기
            </Button>
          </span>
        )}
      </div>
      {!team ? (
        <EmptyNote>조를 먼저 만드세요.</EmptyNote>
      ) : !tree.length ? (
        <EmptyNote>분류를 먼저 만드세요.</EmptyNote>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {tree.map(({ role, depth }) => {
            const ps = m.placed(role.id, teamId)
            return (
              <div key={role.id} className="flex items-center gap-2 px-2 py-1.5 text-sm" style={{ paddingLeft: 8 + depth * 18 }} data-testid="cmd-assign-row">
                <span className="w-48 shrink-0 truncate font-medium">{role.name}</span>
                <span className="min-w-0 flex-1 truncate">
                  <Names people={ps} empty={<span className="text-muted-foreground">-</span>} />
                </span>
                <Button size="sm" variant="outline" onClick={() => setPick(role)} data-testid="cmd-assign-pick">
                  <UserPlus /> 담당자
                </Button>
              </div>
            )
          })}
        </div>
      )}
      {team && unplaced.length > 0 && (
        <p className="text-xs text-important">
          미배치 {unplaced.length}명: <Names people={unplaced.map((p) => m.person(p))} />
        </p>
      )}
      <ErrorLine err={act.err} />
      <PeoplePicker
        open={!!pick}
        title={`${team?.name ?? ''} · ${pick?.name ?? ''} 담당자`}
        note="이 조의 조원만 고를 수 있고, 한 조에서는 한 분류만 맡습니다."
        people={(team?.members ?? []).map((pid) => {
          const p = m.person(pid) ?? { id: pid, name: '(알 수 없음)', title: '', dept: '', temp: false }
          const other = m.s.assignments.find((a) => a.personId === pid && a.teamId === teamId && roleIds.has(a.roleId) && a.roleId !== pick?.id)
          return { ...p, why: leftWhy(p) ?? (other ? `${m.s.roles.find((r) => r.id === other.roleId)?.name}에 배치됨` : undefined) }
        })}
        value={pick ? m.placed(pick.id, teamId).map((p) => p.id) : []}
        onClose={() => setPick(null)}
        onSave={(ids) => pick && void act.run(() => host.api.put('/api/command/assignments', { modeId, teamId, roleId: pick.id, personIds: ids }), () => setPick(null))}
      />
    </div>
  )
}

function CommonCard({ m }: { m: Model }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [edit, setEdit] = useState<Partial<CmdCommon> | null>(null)
  const [pick, setPick] = useState<{ c: CmdCommon; teamId: string } | null>(null)
  return (
    <Card>
      <CardHeader>
        <CardTitle>공통업무 (조와 관계없는 업무)</CardTitle>
        <Button size="sm" variant="outline" onClick={() => setEdit({ name: '', description: '', perTeam: false })} data-testid="cmd-common-add">
          <Plus /> 공통업무 추가
        </Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {!m.s.common.length && <EmptyNote>예: 장비운반차·콤비버스·화물차 운전요원</EmptyNote>}
        {m.s.common.map((c) => (
          <div key={c.id} className="space-y-1 rounded-md border border-border px-3 py-2 text-sm" data-testid="cmd-common-row">
            <div className="flex items-center gap-2">
              <b>{c.name}</b>
              <Badge>{c.perTeam ? '조별 지정' : '고정 지정'}</Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{c.description}</span>
              <Button size="icon-sm" variant="ghost" aria-label="고치기" onClick={() => setEdit(c)}>
                <Pencil />
              </Button>
              <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label={`${c.name} 삭제`} onClick={() => window.confirm(`${c.name}을(를) 지울까요?`) && void act.run(() => host.api.del(`/api/command/common/${c.id}`))}>
                <Trash2 />
              </Button>
            </div>
            {c.perTeam ? (
              m.s.teams.map((t) => (
                <div key={t.id} className="flex items-center gap-2">
                  <span className="w-16 text-xs text-muted-foreground">{t.name}</span>
                  <span className="min-w-0 flex-1 truncate">
                    <Names people={c.assign.filter((a) => a.teamId === t.id).map((a) => m.person(a.personId))} empty="-" />
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => setPick({ c, teamId: t.id })}>
                    <UserPlus /> 지정
                  </Button>
                </div>
              ))
            ) : (
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate">
                  <Names people={c.assign.map((a) => m.person(a.personId))} empty={<span className="text-muted-foreground">지정 안 됨</span>} />
                </span>
                <Button size="sm" variant="ghost" onClick={() => setPick({ c, teamId: '' })} data-testid="cmd-common-pick">
                  <UserPlus /> 지정
                </Button>
              </div>
            )}
          </div>
        ))}
        <ErrorLine err={act.err} />
      </CardContent>
      <CommonDialog value={edit} onClose={() => setEdit(null)} />
      <PeoplePicker
        open={!!pick}
        title={`${pick?.c.name ?? ''} 담당자${pick?.teamId ? ` · ${m.team(pick.teamId)?.name}` : ''}`}
        people={(pick?.teamId ? (m.team(pick.teamId)?.members ?? []).map((id) => m.person(id)).filter((p): p is CmdPerson => !!p) : m.s.people).map((p) => ({ ...p, group: pick?.teamId ? '' : p.temp ? unregGroup(p) : (m.team(m.teamOf(p.id))?.name ?? '조 없음'), why: leftWhy(p) ?? (m.excepted.has(p.id) ? '예외자' : undefined) }))}
        value={pick ? pick.c.assign.filter((a) => a.teamId === pick.teamId).map((a) => a.personId) : []}
        onClose={() => setPick(null)}
        onSave={(ids) => pick && void act.run(() => host.api.put(`/api/command/common/${pick.c.id}/assign`, { teamId: pick.teamId, personIds: ids }), () => setPick(null))}
      />
    </Card>
  )
}

function CommonDialog({ value, onClose }: { value: Partial<CmdCommon> | null; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [f, setF] = useState({ name: '', description: '', perTeam: false })
  useEffect(() => {
    if (value) setF({ name: value.name ?? '', description: value.description ?? '', perTeam: !!value.perTeam })
  }, [value])
  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={value?.id ? '공통업무 고치기' : '공통업무 추가'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!f.name.trim() || act.busy} onClick={() => void act.run(() => (value?.id ? host.api.patch(`/api/command/common/${value.id}`, f) : host.api.post('/api/command/common', f)), () => onClose())}>
            저장
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="이름">
          <Input value={f.name} maxLength={60} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="예: 장비운반차 운전요원" aria-label="공통업무 이름" />
        </Field>
        <Field label="설명 (선택)">
          <Textarea rows={2} value={f.description} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <fieldset className="space-y-1 text-sm">
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={!f.perTeam} onChange={() => setF({ ...f, perTeam: false })} /> 고정 지정 — 어느 조 기간이든 같은 사람
          </label>
          <label className="flex cursor-pointer items-center gap-2">
            <input type="radio" checked={f.perTeam} onChange={() => setF({ ...f, perTeam: true })} /> 조별 지정 — 조마다 그 조의 조원 중에서
          </label>
          {value?.id && value.perTeam !== f.perTeam && <p className="text-xs text-important">방식을 바꾸면 지금 지정된 담당자는 빠집니다.</p>}
        </fieldset>
        <ErrorLine err={act.err} />
      </div>
    </Dialog>
  )
}

function ExceptionsCard({ m, now }: { m: Model; now: number }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [edit, setEdit] = useState<Partial<CmdException> | null>(null)
  const [past, setPast] = useState(false)
  const today = ymd(now)
  const list = m.s.exceptions.filter((e) => past || !e.toDate || e.toDate >= today)
  return (
    <Card>
      <CardHeader>
        <CardTitle>예외자 (조에 편성되지 않는 사람)</CardTitle>
        <span className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted-foreground">
            <input type="checkbox" checked={past} onChange={(e) => setPast(e.target.checked)} /> 지난 예외도 보기
          </label>
          <Button size="sm" variant="outline" onClick={() => setEdit({ personId: '', reason: '', fromDate: today, toDate: null })} data-testid="cmd-exception-add">
            <Plus /> 예외자 추가
          </Button>
        </span>
      </CardHeader>
      <CardContent className="space-y-1">
        {!list.length && <EmptyNote>예외자가 없습니다.</EmptyNote>}
        {list.map((e) => (
          <div key={e.id} className={cn('flex items-center gap-2 text-sm', !m.excepted.has(e.personId) && 'text-muted-foreground')}>
            <b className="w-40 truncate">
              <PersonName p={m.person(e.personId)} />
            </b>
            <span className="min-w-0 flex-1 truncate">{e.reason}</span>
            <span className="whitespace-nowrap text-xs">
              {e.fromDate} ~ {e.toDate ?? '계속'}
            </span>
            <Button size="icon-sm" variant="ghost" aria-label="고치기" onClick={() => setEdit(e)}>
              <Pencil />
            </Button>
            <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="삭제" onClick={() => void act.run(() => host.api.del(`/api/command/exceptions/${e.id}`))}>
              <Trash2 />
            </Button>
          </div>
        ))}
        <p className="text-xs text-muted-foreground">기간이 오늘을 포함하면 그 사람은 조·분류·조별 공통업무에서 빠집니다. 기간이 끝나면 예외 목록에서 자동으로 내려가며, 다시 조에 넣으면 됩니다. 예외자는 대신할 사람 없이 빠지는 것이고, 휴가·교육·출장처럼 그 기간에 누군가 임무를 대신 맡으면 아래 <b>대리자</b>로 등록하세요.</p>
        <ErrorLine err={act.err} />
      </CardContent>
      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.id ? '예외 고치기' : '예외자 추가'}
        footer={
          <>
            <Button variant="outline" onClick={() => setEdit(null)}>
              취소
            </Button>
            <Button disabled={!edit?.personId || act.busy} onClick={() => edit && void act.run(() => (edit.id ? host.api.patch(`/api/command/exceptions/${edit.id}`, edit) : host.api.post('/api/command/exceptions', edit)), () => setEdit(null))}>
              저장
            </Button>
          </>
        }
      >
        {edit && (
          <div className="space-y-3">
            <Field label="사람">
              <Select value={edit.personId ?? ''} onChange={(e) => setEdit({ ...edit, personId: e.target.value })} aria-label="예외자">
                <option value="">고르세요</option>
                {m.s.people
                  .filter((p) => !p.left || p.id === edit.personId)
                  .map((p) => (
                  <option key={p.id} value={p.id}>
                    {titledText(p)}
                    {m.team(m.teamOf(p.id)) ? ` · ${m.team(m.teamOf(p.id))?.name}` : ''}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="사유">
              <Input value={edit.reason ?? ''} maxLength={100} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} placeholder="예: 장기교육, 파견, 육아휴직" aria-label="예외 사유" />
            </Field>
            <div className="flex flex-wrap gap-3">
              <Field label="시작일">
                <Input type="date" className="w-44" value={edit.fromDate ?? today} onChange={(e) => e.target.value && setEdit({ ...edit, fromDate: e.target.value })} />
              </Field>
              <Field label="끝일 (비우면 계속)">
                <Input type="date" className="w-44" value={edit.toDate ?? ''} onChange={(e) => setEdit({ ...edit, toDate: e.target.value || null })} />
              </Field>
            </div>
            <ErrorLine err={act.err} />
          </div>
        )}
      </Dialog>
    </Card>
  )
}

/** The group of somebody who is not a member in the pickers. */
const unregGroup = (p: CmdPerson): string => (p.left === 'old' ? '예전 임시 인원' : (p.source ?? '미등록 인원'))
/** Why somebody is not offered for a new place (they stay where they are until taken out). */
const leftWhy = (p: CmdPerson): string | undefined => (p.left === 'removed' ? '명단에서 지워짐' : p.left === 'old' ? '예전 임시 인원' : undefined)

/**
 * 미등록 인원: the host's list (TeamHub: 관리 → 구성원·PC → 미등록 인원), read only here. Those
 * taken off that list while still placed here, and 임시 인원 of before not moved yet, can be
 * taken out of every place.
 */
function UnregisteredCard({ m }: { m: Model }): React.JSX.Element {
  const host = useHost()
  const act = useAct()
  const [merge, setMerge] = useState<CmdPerson | null>(null)
  const [target, setTarget] = useState('')
  const g = m.s.guests
  const listed = m.s.people.filter((p) => p.temp && !p.left)
  const left = m.s.people.filter((p) => p.temp && p.left)
  return (
    <Card data-testid="cmd-unreg-card">
      <CardHeader>
        <CardTitle>{g?.label ?? '미등록 인원'} (TeamHub를 쓰지 않는 직원)</CardTitle>
        {g && <span className="text-xs text-muted-foreground">{listed.length}명</span>}
      </CardHeader>
      <CardContent className="space-y-2">
        {g ? (
          <p className="text-xs text-muted-foreground">
            식사 신청과 함께 쓰는 하나의 명단입니다. 등록·고치기·삭제·구성원과 합치기는 <b>{g.where}</b>에서 서버 PC와 서무가 합니다. 여기서는 조원·배치·공통업무·예외자로 고를 수 있고, 이름 옆에 항상 <b>미등록</b>이 붙으며 훈련에는 참여하지 못합니다. 그 명단에서 구성원과 합치면 이 사람의 조·배치·공통업무·예외가 그 구성원으로 옮겨집니다.
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">이 프로그램에는 미등록 인원 명단이 없습니다.</p>
        )}
        {g && !listed.length && <EmptyNote>미등록 인원이 없습니다. {g.where}에서 등록합니다.</EmptyNote>}
        {listed.length > 0 && (
          <div className="divide-y divide-border rounded-md border border-border">
            {listed.map((p) => (
              <div key={p.id} className="flex items-center gap-2 px-2 py-1 text-sm" data-testid="cmd-unreg-row">
                <b className="whitespace-nowrap">
                  <PersonName p={p} />
                </b>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{[p.dept, p.memo].filter(Boolean).join(' · ')}</span>
                {m.team(m.teamOf(p.id)) && <span className="text-xs text-muted-foreground">{m.team(m.teamOf(p.id))?.name}</span>}
              </div>
            ))}
          </div>
        )}
        {left.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-semibold text-important">편성에 남아 있는 사람 (새로 고를 수 없음)</p>
            {left.map((p) => (
              <div key={p.id} className="flex items-center gap-2 text-sm">
                <b>
                  <PersonName p={p} />
                </b>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{p.left === 'removed' ? '미등록 인원 명단에서 지워졌습니다.' : '예전 임시 인원입니다. 미등록 인원 명단으로 옮겨지면 사라집니다.'}</span>
                {p.left === 'old' && (
                  <Button size="sm" variant="ghost" onClick={() => (setMerge(p), setTarget(''))}>
                    구성원과 합치기
                  </Button>
                )}
                <Button size="sm" variant="ghost" className="text-urgent" onClick={() => window.confirm(`${p.name}을(를) 조·배치·공통업무·예외·대리 기록에서 모두 뺄까요?`) && void act.run(() => host.api.del(`/api/command/people/${encodeURIComponent(p.id)}`))}>
                  <Trash2 /> 편성에서 빼기
                </Button>
              </div>
            ))}
          </div>
        )}
        <ErrorLine err={act.err} />
      </CardContent>
      <Dialog
        open={!!merge}
        onClose={() => setMerge(null)}
        title={`${merge?.name ?? ''} — 구성원과 합치기`}
        footer={
          <>
            <Button variant="outline" onClick={() => setMerge(null)}>
              취소
            </Button>
            <Button disabled={!target} onClick={() => merge && void act.run(() => host.api.post(`/api/command/people/${encodeURIComponent(merge.id)}/merge`, { memberId: target }), () => setMerge(null))}>
              합치기
            </Button>
          </>
        }
      >
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">조·배치·공통업무·예외가 고른 구성원의 것으로 옮겨집니다. 그 구성원이 이미 조에 있으면 이 사람의 조·배치는 버려집니다.</p>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="합칠 구성원">
            <option value="">구성원 고르기</option>
            {m.s.people
              .filter((p) => !p.temp)
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {titled(p)} {p.dept ? `· ${p.dept}` : ''}
                </option>
              ))}
          </Select>
        </div>
      </Dialog>
    </Card>
  )
}

