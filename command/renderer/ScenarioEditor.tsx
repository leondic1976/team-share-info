/** 시나리오 편집 (those in charge): 개요, 훈련 대상물, 지도 표기, 메시지(시각·대상·처리 방식·답변 형식·지도 변경). */
import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, ImagePlus, MapPinned, Pencil, Plus, Save, Trash2 } from 'lucide-react'
import type { CmdFile, MapData, Mark, MarkChange, Scenario, ScenarioMsg } from '../shared/types'
import { HANDLING_LABEL } from '../shared/types'
import { applyMarkChanges, rolePath } from '../shared/logic'
import type { Model } from './model'
import { useAct, useScenario } from './data'
import { useBlobUrl, useHost } from './host'
import { MapCanvas, type MapEditOps } from './MapCanvas'
import { FilePicker } from './Notices'
import { Editor } from './rich'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Dialog, EmptyNote, Field, Input, Select, cn } from './ui'

type Draft = Omit<Scenario, 'id' | 'createdBy' | 'createdByName' | 'createdAt' | 'updatedAt'>
const blankMsg = (offsetMin: number): ScenarioMsg => ({ id: '', sort: 0, offsetMin, title: '', bodyHtml: '', targetKind: 'all', targetIds: [], handling: 'assigned', answerKind: 'text', choices: [], correctIndex: null, limitMin: 5, popup: true, mapChanges: [] })

/** Marks after some changes (local, for the editor). */
function applyLocal(marks: Mark[], changes: MarkChange[]): Mark[] {
  let n = 0
  const { add, close } = applyMarkChanges(marks, changes, () => `tmp${++n}`)
  return [...marks.filter((m) => !close.includes(m.id)), ...add]
}

/** Map edits that only change local state (the scenario's own marks). */
function localOps(set: (f: (m: Mark[]) => Mark[]) => void): MapEditOps {
  return {
    add: (mark) => set((ms) => [...ms, { ...mark, id: mark.key }]),
    move: (mark) => set((ms) => ms.map((x) => (x.key === mark.key ? { ...mark, id: mark.key } : x))),
    remove: (key) => set((ms) => ms.filter((x) => x.key !== key))
  }
}

export function ScenarioEditor({ m, id, onClose }: { m: Model; id: string | null; onClose: () => void }): React.JSX.Element {
  const host = useHost()
  const q = useScenario(id)
  const act = useAct()
  const [f, setF] = useState<Draft | null>(null)
  const [msg, setMsg] = useState<{ i: number; v: ScenarioMsg } | null>(null)
  const [image, setImage] = useState<CmdFile[]>([])
  useEffect(() => {
    if (id && q.data) setF({ modeId: q.data.modeId, title: q.data.title, summaryHtml: q.data.summaryHtml, targetHtml: q.data.targetHtml, map: q.data.map, messages: q.data.messages })
    else if (!id) setF({ modeId: m.modes[0]?.id ?? m.s.modes[0]?.id ?? '', title: '', summaryHtml: '', targetHtml: '', map: { imageId: null, width: 0, height: 0, marks: [] }, messages: [] })
  }, [id, q.data, m])
  const url = useBlobUrl(f?.map.imageId)
  // the natural size of a new picture, for the shape of the map
  useEffect(() => {
    if (!url || !f) return
    const img = new Image()
    img.onload = () => setF((p) => (p && (p.map.width !== img.naturalWidth || p.map.height !== img.naturalHeight) ? { ...p, map: { ...p.map, width: img.naturalWidth, height: img.naturalHeight } } : p))
    img.src = url
  }, [url, f])
  if (!f) return <p className="p-4 text-sm text-muted-foreground">불러오는 중…</p>
  const setMap = (fn: (ms: Mark[]) => Mark[]): void => setF((p) => (p ? { ...p, map: { ...p.map, marks: fn(p.map.marks) } } : p))
  const sorted = [...f.messages].sort((a, b) => a.offsetMin - b.offsetMin)
  const save = (): void =>
    void act.run(
      () => {
        const body = { ...f, messages: sorted.map(({ id: _i, sort: _s, ...rest }) => rest), map: { ...f.map, marks: f.map.marks.map(({ createdAt: _c, removedAt: _r, ...mk }) => mk) } }
        return id ? host.api.put(`/api/command/scenarios/${id}`, body) : host.api.post('/api/command/scenarios', body)
      },
      () => onClose()
    )
  return (
    <div className="space-y-4" data-testid="cmd-scenario-editor">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="ghost" onClick={onClose}>
          <ArrowLeft /> 목록
        </Button>
        <h2 className="text-lg font-bold">{id ? '시나리오 고치기' : '새 시나리오'}</h2>
        <span className="ml-auto text-xs text-muted-foreground">시나리오는 지휘대담당과 서버 PC에게만 보입니다</span>
        <Button disabled={!f.title.trim() || act.busy} onClick={save} data-testid="cmd-scenario-save">
          <Save /> 저장
        </Button>
      </div>
      {act.err && <p className="text-sm text-urgent">{act.err}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>기본 정보</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Field label="제목">
              <Input value={f.title} maxLength={120} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="예: ○○공장 화재 대응 훈련" aria-label="시나리오 제목" />
            </Field>
            <Field label="근무 유형">
              <Select value={f.modeId} onChange={(e) => setF({ ...f, modeId: e.target.value, messages: f.messages.map((x) => (x.targetKind === 'role' ? { ...x, targetIds: [] } : x)) })} aria-label="근무 유형">
                {m.s.modes.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <div>
              <p className="mb-1 text-sm font-medium">개요</p>
              <Editor value={f.summaryHtml} onChange={(h) => setF((p) => (p ? { ...p, summaryHtml: h } : p))} ariaLabel="훈련 개요" placeholder="훈련 목적, 진행 방법, 상황 개요" />
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>훈련 대상물 정보</CardTitle>
          </CardHeader>
          <CardContent>
            <Editor value={f.targetHtml} onChange={(h) => setF((p) => (p ? { ...p, targetHtml: h } : p))} minHeight={240} ariaLabel="훈련 대상물 정보" placeholder="주소, 용도, 구조·층수, 연면적, 위험물, 수용 인원, 진입로, 소화설비… 사진은 붙여넣을 수 있습니다." />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-1.5">
            <MapPinned className="size-4" /> 지도 표기 (처음 상태)
          </CardTitle>
          <span className="flex items-center gap-2">
            <ImagePlus className="size-4 text-muted-foreground" />
            <FilePicker files={image} multiple={false} onChange={(fs) => (setImage(fs), setF({ ...f, map: { ...f.map, imageId: fs[0]?.id ?? f.map.imageId } }))} />
            {f.map.imageId && (
              <Button size="sm" variant="ghost" onClick={() => setF({ ...f, map: { ...f.map, imageId: null, width: 0, height: 0 } })}>
                그림 빼기
              </Button>
            )}
          </span>
        </CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">지도 캡처·도면·항공사진 이미지를 올리고 지휘소·차량·화점 등을 표시합니다. 훈련 중에는 지휘대담당이 표식을 실시간으로 더하고 옮길 수 있습니다.</p>
          <MapCanvas imageId={f.map.imageId} width={f.map.width} height={f.map.height} marks={f.map.marks} edit={localOps(setMap)} className="h-[520px]" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>메시지 ({f.messages.length})</CardTitle>
          <Button size="sm" onClick={() => setMsg({ i: -1, v: blankMsg(sorted.length ? sorted[sorted.length - 1].offsetMin + 5 : 0) })} data-testid="cmd-msg-add">
            <Plus /> 메시지 추가
          </Button>
        </CardHeader>
        {!sorted.length ? (
          <EmptyNote>훈련을 시작한 뒤 몇 분에 어떤 상황을 누구에게 알릴지 메시지를 추가하세요.</EmptyNote>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-xs text-muted-foreground">
                <th className="w-20 px-3 py-1.5 text-left font-medium">시작 후</th>
                <th className="px-2 py-1.5 text-left font-medium">메시지</th>
                <th className="px-2 py-1.5 text-left font-medium">대상</th>
                <th className="px-2 py-1.5 text-left font-medium">처리</th>
                <th className="w-24 px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {sorted.map((x) => {
                const i = f.messages.indexOf(x)
                return (
                  <tr key={i} className="border-b border-border last:border-0" data-testid="cmd-msg-row">
                    <td className="px-3 py-1.5 tabular-nums">{x.offsetMin}분</td>
                    <td className="px-2 py-1.5">
                      <b>{x.title}</b> {x.answerKind === 'choice' && <Badge>객관식</Badge>} {x.mapChanges.length > 0 && <Badge tone="drill">지도 변경 {x.mapChanges.length}</Badge>} {!x.popup && <Badge>창 안 띄움</Badge>}
                    </td>
                    <td className="px-2 py-1.5 text-xs">{targetText(m, x)}</td>
                    <td className="px-2 py-1.5 text-xs">
                      {HANDLING_LABEL[x.handling]}
                      {x.limitMin ? ` · ${x.limitMin}분 안` : ''}
                    </td>
                    <td className="px-2 py-1.5 text-right">
                      <Button size="icon-sm" variant="ghost" aria-label="고치기" onClick={() => setMsg({ i, v: x })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" className="text-urgent" aria-label="삭제" onClick={() => setF({ ...f, messages: f.messages.filter((_, j) => j !== i) })}>
                        <Trash2 />
                      </Button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
      <MessageDialog
        m={m}
        modeId={f.modeId}
        value={msg?.v ?? null}
        map={f.map}
        // the map as it is when this message goes: the first state and the changes of the messages before it
        baseMarks={msg ? applyLocal(f.map.marks, sorted.filter((x) => x !== msg.v && x.offsetMin <= msg.v.offsetMin).flatMap((x) => x.mapChanges)) : []}
        onClose={() => setMsg(null)}
        onSave={(v) => {
          if (!msg) return
          setF({ ...f, messages: msg.i < 0 ? [...f.messages, v] : f.messages.map((x, j) => (j === msg.i ? v : x)) })
          setMsg(null)
        }}
      />
    </div>
  )
}

export function targetText(m: Model, x: Pick<ScenarioMsg, 'targetKind' | 'targetIds' | 'handling'>): string {
  if (x.handling === 'all' || x.targetKind === 'all') return '참가자 전원'
  if (x.targetKind === 'person') return x.targetIds.map((id) => m.person(id)?.name ?? '(알 수 없음)').join(', ')
  return x.targetIds.map((id) => rolePath(m.s.roles, id) || '(지운 분류)').join(', ')
}

/** One message: when, what, to whom, how it is handled, the answer, the map change it brings. */
export function MessageDialog({ m, modeId, value, map, baseMarks, onClose, onSave, sendNow }: { m: Model; modeId: string; value: ScenarioMsg | null; map: Pick<MapData, 'imageId' | 'width' | 'height'>; baseMarks: Mark[]; onClose: () => void; onSave: (v: ScenarioMsg) => void; sendNow?: boolean }): React.JSX.Element {
  const [v, setV] = useState<ScenarioMsg | null>(value)
  const [mapOpen, setMapOpen] = useState(false)
  useEffect(() => setV(value), [value])
  const tree = m.tree(modeId)
  const preview = useMemo(() => (v ? applyLocal(baseMarks, v.mapChanges) : []), [baseMarks, v])
  if (!v) return <Dialog open={false} onClose={onClose} title="" children={null} />
  const set = (p: Partial<ScenarioMsg>): void => setV({ ...v, ...p })
  const ops: MapEditOps = {
    add: (mark) => set({ mapChanges: [...v.mapChanges, { op: 'add', mark: { key: mark.key, kind: mark.kind, icon: mark.icon, color: mark.color, label: mark.label, points: mark.points } }] }),
    move: (mark) => set({ mapChanges: [...v.mapChanges.filter((c) => !(c.op === 'move' && c.key === mark.key)), { op: 'move', key: mark.key, points: mark.points }] }),
    remove: (key) => set({ mapChanges: [...v.mapChanges.filter((c) => !(c.op === 'add' && c.mark.key === key)), ...(v.mapChanges.some((c) => c.op === 'add' && c.mark.key === key) ? [] : [{ op: 'remove' as const, key }])] })
  }
  const ok = v.title.trim() && (v.answerKind !== 'choice' || v.choices.filter((c) => c.trim()).length >= 2) && (v.targetKind === 'all' || v.handling === 'all' || v.targetIds.length > 0)
  return (
    <Dialog
      open
      onClose={onClose}
      width="max-w-3xl"
      title={sendNow ? '즉석 메시지 보내기' : value?.title ? '메시지 고치기' : '메시지 추가'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            취소
          </Button>
          <Button disabled={!ok} onClick={() => onSave({ ...v, choices: v.choices.map((c) => c.trim()).filter(Boolean) })} data-testid="cmd-msg-save">
            {sendNow ? '지금 보내기' : '확인'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          {!sendNow && (
            <Field label="시작 후 (분)">
              <Input type="number" min={0} max={1440} className="w-24" value={v.offsetMin} onChange={(e) => set({ offsetMin: Math.max(0, Number(e.target.value) || 0) })} aria-label="시작 후 분" />
            </Field>
          )}
          <Field label="제목" className="min-w-60 flex-1">
            <Input value={v.title} maxLength={120} onChange={(e) => set({ title: e.target.value })} placeholder="예: 3층 연기 확산 보고" aria-label="메시지 제목" />
          </Field>
        </div>
        <Editor value={v.bodyHtml} onChange={(h) => setV((p) => (p ? { ...p, bodyHtml: h } : p))} ariaLabel="메시지 내용" placeholder="상황 설명, 지시 사항. 사진을 붙여넣을 수 있습니다." />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="처리 방식">
            <Select value={v.handling} onChange={(e) => set({ handling: e.target.value as ScenarioMsg['handling'] })} aria-label="처리 방식">
              <option value="assigned">{HANDLING_LABEL.assigned}</option>
              <option value="first">{HANDLING_LABEL.first}</option>
              <option value="all">{HANDLING_LABEL.all}</option>
            </Select>
          </Field>
          <Field label="처리 대상" hint={v.handling === 'all' ? '전원 각자 처리는 참가자 모두가 대상입니다.' : v.handling === 'first' ? '대상이 먼저 보이고, 누구든 먼저 처리하면 끝납니다.' : '대상만 답할 수 있고, 대상 모두가 답해야 끝납니다.'}>
            <Select value={v.handling === 'all' ? 'all' : v.targetKind} disabled={v.handling === 'all'} onChange={(e) => set({ targetKind: e.target.value as ScenarioMsg['targetKind'], targetIds: [] })} aria-label="처리 대상">
              <option value="all">참가자 전원</option>
              <option value="role">분류(직책)</option>
              <option value="person">사람</option>
            </Select>
          </Field>
        </div>
        {v.handling !== 'all' && v.targetKind === 'role' && (
          <div className="max-h-40 overflow-y-auto rounded-md border border-border p-2 text-sm" data-testid="cmd-msg-roles">
            {tree.length ? (
              tree.map(({ role, depth }) => (
                <label key={role.id} className="flex cursor-pointer items-center gap-2" style={{ paddingLeft: depth * 16 }}>
                  <input type="checkbox" checked={v.targetIds.includes(role.id)} onChange={(e) => set({ targetIds: e.target.checked ? [...v.targetIds, role.id] : v.targetIds.filter((x) => x !== role.id) })} aria-label={role.name} />
                  {role.name}
                </label>
              ))
            ) : (
              <EmptyNote>이 근무 유형에 분류가 없습니다.</EmptyNote>
            )}
          </div>
        )}
        {v.handling !== 'all' && v.targetKind === 'person' && (
          <div className="grid max-h-40 gap-x-3 overflow-y-auto rounded-md border border-border p-2 text-sm sm:grid-cols-2">
            {m.s.people
              .filter((p) => !p.temp)
              .map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" checked={v.targetIds.includes(p.id)} onChange={(e) => set({ targetIds: e.target.checked ? [...v.targetIds, p.id] : v.targetIds.filter((x) => x !== p.id) })} aria-label={p.name} />
                  {p.title} {p.name}
                </label>
              ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="답변 형식">
            <Select value={v.answerKind} onChange={(e) => set({ answerKind: e.target.value as ScenarioMsg['answerKind'], choices: e.target.value === 'choice' && v.choices.length < 2 ? ['', ''] : v.choices })} aria-label="답변 형식">
              <option value="text">주관식 (글·첨부)</option>
              <option value="choice">객관식</option>
            </Select>
          </Field>
          <Field label="제한 시간(분)" hint="비우면 제한 없음">
            <Input type="number" min={1} max={600} value={v.limitMin ?? ''} onChange={(e) => set({ limitMin: e.target.value ? Math.max(1, Number(e.target.value)) : null })} aria-label="제한 시간" />
          </Field>
          <label className="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
            <input type="checkbox" checked={v.popup} onChange={(e) => set({ popup: e.target.checked })} /> 화면 가운데 훈련 창 띄우기
          </label>
        </div>
        {v.answerKind === 'choice' && (
          <div className="space-y-1" data-testid="cmd-msg-choices">
            {v.choices.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input type="radio" name="correct" checked={v.correctIndex === i} onChange={() => set({ correctIndex: i })} aria-label={`${i + 1}번을 정답으로`} title="정답(선택)" />
                <span className="w-5 text-right text-sm tabular-nums">{i + 1}.</span>
                <Input className="h-8" value={c} maxLength={100} onChange={(e) => set({ choices: v.choices.map((x, j) => (j === i ? e.target.value : x)) })} aria-label={`선택지 ${i + 1}`} />
                <Button size="icon-sm" variant="ghost" aria-label="선택지 빼기" disabled={v.choices.length <= 2} onClick={() => set({ choices: v.choices.filter((_, j) => j !== i), correctIndex: v.correctIndex === i ? null : v.correctIndex != null && v.correctIndex > i ? v.correctIndex - 1 : v.correctIndex })}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" disabled={v.choices.length >= 6} onClick={() => set({ choices: [...v.choices, ''] })}>
                <Plus /> 선택지
              </Button>
              <span className="text-xs text-muted-foreground">동그라미로 정답을 고르면(선택) 결과에서 정답률을 셉니다. 정답은 훈련이 끝난 뒤 참가자에게 보입니다.</span>
            </div>
          </div>
        )}
        <div className="rounded-md border border-border p-2">
          <div className="flex items-center gap-2">
            <MapPinned className="size-4" />
            <span className="text-sm font-medium">이 메시지와 함께 지도 바꾸기</span>
            {v.mapChanges.length > 0 && <Badge tone="drill">{v.mapChanges.length}건</Badge>}
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => setMapOpen((o) => !o)}>
              {mapOpen ? '접기' : '지도 열기'}
            </Button>
          </div>
          {mapOpen && <MapCanvas imageId={map.imageId} width={map.width} height={map.height} marks={preview} edit={ops} className={cn('mt-2 h-[420px]')} />}
        </div>
      </div>
    </Dialog>
  )
}
