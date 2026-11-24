import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Lock, LogOut, Trash2, UserPlus, Users } from 'lucide-react'
import type { SeatResult, SeatState } from '@shared/ipc'
import { SEAT_IDLE_MAX, SEAT_IDLE_MIN, SEAT_NAME_MAX, SEAT_PIN_MAX, SEAT_PIN_MIN } from '@shared/constants'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { useConn } from '@renderer/app/conn-store'

const digits = (v: string): string => v.replace(/\D/g, '').slice(0, SEAT_PIN_MAX)
const PIN_LABEL = `숫자 ${SEAT_PIN_MIN}자리 이상`

function Pin({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <label className="space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input aria-label={label} type="password" inputMode="numeric" autoComplete="off" maxLength={SEAT_PIN_MAX} className="w-36" value={value} onChange={(e) => onChange(digits(e.target.value))} />
    </label>
  )
}

/** What the PIN is and is not: said where the mode is turned on, and again in the manual. */
function Limits(): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="note">
      <b className="text-foreground">알아 둘 점</b> · 여러 명이 같은 Windows 계정을 함께 쓰는 PC에서, 평소 사용 중에 서로의 TeamHub를 열어 보지 못하게 하는 기능입니다. 사람마다 접속 정보와 개인 자료가 따로 보관됩니다. 다만 Windows 계정이
      같으므로 PC의 파일을 일부러 뒤지는 사람까지 막지는 못합니다. 확실히 나누려면 사람마다 Windows 계정을 따로 만들어 쓰세요(TeamHub는 Windows 계정별로 자료를 따로 보관합니다). 민감한 내용은 TeamHub에 두지 않는 원칙은 그대로입니다.
    </div>
  )
}

/**
 * Settings: 공용 PC 사용 - one member PC used by several people, each with a name and a PIN.
 * Off for the usual one PC, one person. Adding and removing people and the other management
 * actions need the PIN of the PC 책임자 (whoever turned the mode on).
 */
export function SharedPcCard(): React.JSX.Element | null {
  const myName = useConn((s) => s.me?.name ?? '')
  const [st, setSt] = useState<SeatState | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  // turning on
  const [name, setName] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  // management (PC 책임자's PIN)
  const [ownerPin, setOwnerPin] = useState('')
  const [newName, setNewName] = useState('')
  const [newPin, setNewPin] = useState('')
  const [idle, setIdle] = useState('')

  const load = useCallback(async () => {
    const s = await invoke('seat:state')
    setSt(s)
    setIdle(String(s.idleMinutes))
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    setName((n) => n || myName)
  }, [myName])

  if (!st) return null
  // a server PC is the 최종관리자's own and is not shared
  if (!st.enabled && !st.allowed) return null

  const done = async (r: SeatResult, okText: string): Promise<boolean> => {
    setMsg(r.ok ? { ok: true, text: r.warning ?? okText } : { ok: false, text: r.error ?? '하지 못했습니다.' })
    if (r.ok) await load()
    return r.ok
  }
  const fail = (text: string): void => setMsg({ ok: false, text })

  const enable = async (): Promise<void> => {
    if (!name.trim()) return fail('내 이름을 입력하세요.')
    if (a !== b) return fail('두 번 입력한 PIN이 다릅니다.')
    const r = await invoke('seat:enable', { name, pin: a })
    if (await done(r, '공용 PC 사용을 켰습니다. 이제 TeamHub를 시작할 때 이름을 고르고 PIN을 입력합니다.')) {
      setRecovery(r.recovery ?? null)
      setA('')
      setB('')
    }
  }
  const changePin = async (): Promise<void> => {
    if (await done(await invoke('seat:changePin', { oldPin: a, newPin: b }), '내 PIN을 바꿨습니다.')) {
      setA('')
      setB('')
    }
  }
  const add = async (): Promise<void> => {
    if (!newName.trim()) return fail('새 사용자의 이름을 입력하세요.')
    if (await done(await invoke('seat:add', { ownerPin, name: newName, pin: newPin }), `${newName.trim()} 님을 추가했습니다. "사용자 바꾸기"로 나간 뒤 그 이름으로 시작해 서버에 사용 신청을 하세요.`)) {
      setNewName('')
      setNewPin('')
      setOwnerPin('')
    }
  }
  const resetPin = async (id: string, who: string): Promise<void> => {
    if (!newPin) return fail(`아래 "새 사용자 PIN" 칸에 ${who} 님의 새 PIN을 입력한 뒤 다시 누르세요.`)
    if (await done(await invoke('seat:resetPin', { ownerPin, id, newPin }), `${who} 님의 PIN을 새로 정했습니다.`)) {
      setNewPin('')
      setOwnerPin('')
    }
  }
  const remove = async (id: string, who: string): Promise<void> => {
    if (
      !window.confirm(
        `${who} 님을 이 PC에서 지웁니다.\n\n이 PC에 있는 ${who} 님의 개인 자료(개인 일정·다이어리·메모·알람 등)와 접속 정보가 모두 지워지며 되돌릴 수 없습니다.\n서버의 계정과 올린 글·파일은 지워지지 않습니다(계정은 관리자가 관리 화면에서 사용 중지).\n\n계속할까요?`
      )
    )
      return
    if (await done(await invoke('seat:remove', { id, pin: ownerPin, by: 'owner' }), `${who} 님을 이 PC에서 지웠습니다.`)) setOwnerPin('')
  }
  const saveIdle = async (): Promise<void> => {
    const minutes = Number(idle)
    if (!Number.isInteger(minutes) || minutes < SEAT_IDLE_MIN || minutes > SEAT_IDLE_MAX) return fail(`자동 잠금 시간은 ${SEAT_IDLE_MIN}~${SEAT_IDLE_MAX}분입니다.`)
    if (await done(await invoke('seat:setIdle', { ownerPin, minutes }), `자동 잠금 시간을 ${minutes}분으로 바꿨습니다.`)) setOwnerPin('')
  }
  const disable = async (): Promise<void> => {
    if (await done(await invoke('seat:disable', { ownerPin }), '공용 PC 사용을 껐습니다. 이제 PIN 없이 바로 시작합니다.')) {
      setOwnerPin('')
      setRecovery(null)
    }
  }
  const switchUser = (): void => {
    if (window.confirm('사용을 마치고 사용자 선택 화면으로 돌아갑니다.\nTeamHub가 다시 시작되며, 저장하지 않은 내용은 사라집니다. 계속할까요?')) void invoke('seat:switch')
  }

  return (
    <Card data-testid="shared-pc-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Users className="size-4" /> 공용 PC 사용 (한 PC를 여러 명이 사용)
        </CardTitle>
        <span className="text-xs text-muted-foreground">{st.enabled ? '사용 중' : '사용 안 함'}</span>
      </CardHeader>
      <CardContent className="space-y-3">
        {!st.enabled ? (
          <>
            <p className="text-sm text-muted-foreground">
              PC 한 대를 여러 명이 함께 쓸 때만 켜세요. 켜면 TeamHub를 시작할 때 이름을 고르고 PIN을 입력하며, 사람마다 서버 승인·계정·개인 자료가 따로 관리됩니다. 켜는 사람이 이 PC의 <b>PC 책임자</b>가 되어 사용자를 추가하고 지웁니다. 지금 이 PC에 있는
              자료는 켜는 사람의 것으로 그대로 남습니다. 혼자 쓰는 PC는 켤 필요가 없습니다.
            </p>
            <Limits />
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">내 이름 (시작 화면에 표시)</span>
                <Input aria-label="내 이름 (시작 화면에 표시)" className="w-40" value={name} maxLength={SEAT_NAME_MAX} onChange={(e) => setName(e.target.value)} />
              </label>
              <Pin label={`내 PIN (${PIN_LABEL})`} value={a} onChange={setA} />
              <Pin label="내 PIN 다시 입력" value={b} onChange={setB} />
              <Button variant="outline" onClick={() => void enable()}>
                <Users /> 공용 PC 사용 켜기
              </Button>
            </div>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              지금 사용자: <b data-testid="seat-current">{st.active?.name ?? '-'}</b>
              {st.active?.owner && <Badge>PC 책임자</Badge>}
              <span className="text-xs text-muted-foreground">· {st.idleMinutes}분 동안 쓰지 않으면 자동으로 잠깁니다</span>
              <Button variant="outline" size="sm" className="ml-auto" onClick={() => void invoke('lock:now')}>
                <Lock /> 지금 잠그기
              </Button>
              <Button variant="outline" size="sm" onClick={switchUser}>
                <LogOut /> 사용자 바꾸기
              </Button>
            </div>
            <Limits />
            <div className="flex flex-wrap items-end gap-2">
              <Pin label="지금 내 PIN" value={a} onChange={setA} />
              <Pin label={`새 PIN (${PIN_LABEL})`} value={b} onChange={setB} />
              <Button variant="outline" onClick={() => void changePin()}>
                <KeyRound /> 내 PIN 바꾸기
              </Button>
            </div>

            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-sm font-medium">사용자 관리 (PC 책임자)</div>
              <p className="text-xs text-muted-foreground">
                아래 작업에는 PC 책임자의 PIN이 필요합니다. 사용자를 지우면 이 PC에 있는 그 사람의 개인 자료가 지워지고, 서버의 계정은 그대로 남습니다(관리자가 관리 화면에서 사용 중지). 지금 사용 중인 사용자와 PC 책임자는 여기서 지울 수 없습니다.
              </p>
              <ul className="divide-y divide-border rounded-md border border-border text-sm" data-testid="seat-rows">
                {st.seats.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="font-medium">{s.name}</span>
                    {s.owner && <Badge>PC 책임자</Badge>}
                    {s.id === st.active?.id && <span className="text-xs text-muted-foreground">사용 중</span>}
                    {!s.owner && (
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => void resetPin(s.id, s.name)}>
                          PIN 초기화
                        </Button>
                        {s.id !== st.active?.id && (
                          <Button size="sm" variant="ghost" className="text-urgent" onClick={() => void remove(s.id, s.name)}>
                            <Trash2 /> 지우기
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap items-end gap-2">
                <Pin label="PC 책임자 PIN" value={ownerPin} onChange={setOwnerPin} />
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">새 사용자 이름</span>
                  <Input aria-label="새 사용자 이름" className="w-36" value={newName} maxLength={SEAT_NAME_MAX} onChange={(e) => setNewName(e.target.value)} />
                </label>
                <Pin label={`새 사용자 PIN (${PIN_LABEL})`} value={newPin} onChange={setNewPin} />
                <Button variant="outline" onClick={() => void add()}>
                  <UserPlus /> 사용자 추가
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    자동 잠금 시간 ({SEAT_IDLE_MIN}~{SEAT_IDLE_MAX}분)
                  </span>
                  <Input aria-label="자동 잠금 시간(분)" type="number" min={SEAT_IDLE_MIN} max={SEAT_IDLE_MAX} className="w-24" value={idle} onChange={(e) => setIdle(e.target.value)} />
                </label>
                <Button variant="outline" onClick={() => void saveIdle()}>
                  시간 바꾸기
                </Button>
                <Button variant="outline" className="ml-auto" disabled={st.seats.length > 1} title={st.seats.length > 1 ? '다른 사용자를 모두 지운 뒤에 끌 수 있습니다.' : undefined} onClick={() => void disable()}>
                  공용 PC 사용 끄기
                </Button>
              </div>
            </div>
          </>
        )}
        {recovery && (
          <div className="rounded-md border border-border px-3 py-2 text-sm" role="note">
            <b>PC 책임자 복구 코드를 적어 두세요.</b> PC 책임자의 PIN을 잊었을 때 이 코드로 새 PIN을 만듭니다. 지금 한 번만 보여 드립니다.
            <div className="selectable mt-1 font-mono text-lg font-bold tracking-widest" data-testid="seat-recovery-code">
              {recovery}
            </div>
            <span className="text-xs text-muted-foreground">다른 사용자가 PIN을 잊으면 PC 책임자가 새로 정해 줍니다. PC 책임자의 PIN과 복구 코드를 모두 잃어버리면 사용자를 추가하거나 지울 수 없습니다.</span>
          </div>
        )}
        {msg && <p className={cn('text-xs', msg.ok ? 'text-success' : 'text-urgent')}>{msg.text}</p>}
      </CardContent>
    </Card>
  )
}
