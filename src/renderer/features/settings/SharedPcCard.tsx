import { useCallback, useEffect, useState } from 'react'
import { ArchiveRestore, KeyRound, Lock, LockOpen, LogOut, Trash2, AlertTriangle, UserPlus, Users } from 'lucide-react'
import type { RemovedSeatInfo, SeatResult, SeatState } from '@shared/ipc'
import { PIN_LEN, SEAT_IDLE_MAX, SEAT_IDLE_MIN, SEAT_NAME_MAX, SEAT_PIN_MAX, SEAT_REMOVED_KEEP_DAYS } from '@shared/constants'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog } from '@renderer/components/Dialog'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { useConn } from '@renderer/app/conn-store'

const PIN_LABEL = `숫자 ${PIN_LEN}자리`
/** A PIN is each person's choice: said wherever one may be left out. */
const PIN_OPTIONAL = `${PIN_LABEL}, 비워 두면 PIN 없음`
const KEEP = SEAT_REMOVED_KEEP_DAYS
const day = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * `max` PIN_LEN: a PIN that is being made. Fields that check an existing PIN pass SEAT_PIN_MAX,
 * because PINs made before the 4-digit rule are longer and keep working until they are changed.
 */
function Pin({ label, value, onChange, max = PIN_LEN }: { label: string; value: string; onChange: (v: string) => void; max?: number }): React.JSX.Element {
  return (
    <label className="space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input aria-label={label} type="password" inputMode="numeric" autoComplete="off" maxLength={max} className="w-36" value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, max))} />
    </label>
  )
}

type AskKind = 'remove' | 'reset' | 'restore' | 'purge'
const ASK_TITLE: Record<AskKind, (name: string) => string> = {
  remove: (n) => `${n} 님 지우기`,
  reset: (n) => `${n} 님의 PIN 초기화`,
  restore: (n) => `${n} 님 복구`,
  purge: (n) => `${n} 님의 자료 완전히 지우기`
}
const ASK_OK: Record<AskKind, string> = { remove: '지우기', reset: 'PIN 새로 정하기', restore: '복구', purge: '완전히 지우기' }

/** What the PIN is and is not: said where the mode is turned on, and again in the manual. */
function Limits(): React.JSX.Element {
  return (
    <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="note" data-testid="seat-limits">
      <b className="text-foreground">알아 둘 점</b> · 여러 명이 같은 Windows 계정을 함께 쓰는 PC에서, 평소 사용 중에 서로의 TeamHub를 열어 보지 않게 하는 기능입니다. 사람마다 접속 정보와 개인 자료가 따로 보관됩니다. 숫자 4자리 PIN(또는 PIN 없이 쓰기)은 그 정도의
      장치일 뿐이며, Windows 계정이 같으므로 PC의 파일을 일부러 뒤지는 사람까지 막지는 못합니다. 확실히 나누려면 사람마다 Windows 계정을 따로 만들어 쓰세요(TeamHub는 Windows 계정별로 자료를 따로 보관합니다). 민감한 내용은 TeamHub에 두지 않는 원칙은 그대로입니다.
    </div>
  )
}

/** The one PIN of a person, and what going without one means. */
function PinRule(): React.JSX.Element {
  return (
    <p className="text-xs text-muted-foreground" data-testid="seat-pin-rule">
      PIN은 <b className="text-foreground">{PIN_LABEL}</b>이고 사람마다 하나입니다. 시작할 때 입력하는 그 PIN으로 &quot;지금 잠그기&quot;로 잠근 화면도 풉니다. 1111, 1234처럼 쉬운 번호는 쓸 수 없습니다. PIN은{' '}
      <b className="text-foreground">쓰지 않아도 됩니다.</b> PIN이 없는 사람은 사용자 선택 창에서 이름만 누르면 바로 시작하므로, 이 PC 앞에 앉은 누구나 그 사람의 TeamHub를 열 수 있습니다.
    </p>
  )
}

/**
 * Settings: 공용 PC 사용 - one member PC used by several people, each with a name and, if they
 * want one, a 4-digit PIN. Off for the usual one PC, one person. Adding and removing people and
 * the other management actions need the PIN of the PC 책임자 (whoever turned the mode on); when
 * the PC 책임자 uses no PIN they need nothing, and the card says so.
 */
export function SharedPcCard(): React.JSX.Element | null {
  const myName = useConn((s) => s.me?.name ?? '')
  const [st, setSt] = useState<SeatState | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  // turning on / my own PIN
  const [name, setName] = useState('')
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  // management (PC 책임자's PIN)
  const [ownerPin, setOwnerPin] = useState('')
  const [newName, setNewName] = useState('')
  const [newPin, setNewPin] = useState('')
  const [idle, setIdle] = useState('')
  // people removed from this PC whose data is still kept
  const [removed, setRemoved] = useState<RemovedSeatInfo[]>([])
  // removing a person / setting a new PIN for them / putting a removed person back / erasing their
  // kept data: asked in a window of its own, with the PC 책임자's PIN when there is one
  const [ask, setAsk] = useState<null | { kind: AskKind; id: string; name: string }>(null)
  const [askPin, setAskPin] = useState('')
  const [askNew, setAskNew] = useState('')
  const [askErr, setAskErr] = useState('')
  const [askBusy, setAskBusy] = useState(false)

  const load = useCallback(async () => {
    const s = await invoke('seat:state')
    setSt(s)
    setIdle(String(s.idleMinutes))
    setRemoved(s.signedIn ? await invoke('seat:removed') : [])
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

  const me = st.active
  const owner = st.seats.find((s) => s.owner)
  const ownerHasPin = owner?.hasPin ?? true

  const done = async (r: SeatResult, okText: string): Promise<boolean> => {
    setMsg(r.ok ? { ok: true, text: r.warning ?? okText } : { ok: false, text: r.error ?? '하지 못했습니다.' })
    if (r.ok) await load()
    return r.ok
  }
  const fail = (text: string): void => setMsg({ ok: false, text })
  const clearPins = (): void => {
    setA('')
    setB('')
  }

  const enable = async (): Promise<void> => {
    if (!name.trim()) return fail('내 이름을 입력하세요.')
    if (a !== b) return fail('두 번 입력한 PIN이 다릅니다.')
    if (a && a.length !== PIN_LEN) return fail(`PIN은 ${PIN_LABEL}입니다. 쓰지 않으려면 비워 두세요.`)
    const r = await invoke('seat:enable', { name, pin: a })
    const okText = a
      ? '공용 PC 사용을 켰습니다. 이제 TeamHub를 시작할 때 이름을 고르고 PIN을 입력합니다.'
      : '공용 PC 사용을 켰습니다. 이제 TeamHub를 시작할 때 이름을 고릅니다. PIN 없이 쓰는 중이며, 아래 "내 PIN 만들기"로 언제든 만들 수 있습니다.'
    if (await done(r, okText)) {
      setRecovery(r.recovery ?? null)
      clearPins()
    }
  }
  const changePin = async (): Promise<void> => {
    if (!a) return fail('지금 내 PIN을 입력하세요.')
    if (b.length !== PIN_LEN) return fail(`새 PIN은 ${PIN_LABEL}입니다.`)
    if (await done(await invoke('seat:changePin', { oldPin: a, newPin: b }), '내 PIN을 바꿨습니다.')) clearPins()
  }
  const createPin = async (): Promise<void> => {
    if (a.length !== PIN_LEN) return fail(`PIN은 ${PIN_LABEL}입니다.`)
    if (a !== b) return fail('두 번 입력한 PIN이 다릅니다.')
    const r = await invoke('seat:changePin', { oldPin: '', newPin: a })
    if (await done(r, '내 PIN을 만들었습니다. 이제 시작할 때와 잠근 화면을 풀 때 이 PIN을 입력합니다.')) {
      if (r.recovery) setRecovery(r.recovery)
      clearPins()
    }
  }
  const removePin = async (): Promise<void> => {
    if (!a) return fail('PIN을 없애려면 지금 내 PIN을 입력하세요.')
    const more = me?.owner ? '\n\nPC 책임자의 PIN이 없어지면 이 PC를 쓰는 누구나 PIN 확인 없이 사용자를 추가·삭제하고, 다른 사람의 PIN을 초기화하고, 공용 PC 사용을 끌 수 있습니다. 복구 코드도 더 쓰지 않습니다.' : ''
    if (!window.confirm(`PIN을 없애면 이 PC 앞에 앉은 누구나 내 이름만 눌러 내 TeamHub를 열 수 있습니다.${more}\n\nPIN 없이 쓸까요?`)) return
    if (await done(await invoke('seat:removePin', { pin: a }), '내 PIN을 없앴습니다. 이제 사용자 선택 창에서 이름만 눌러 시작합니다.')) {
      clearPins()
      if (me?.owner) setRecovery(null)
    }
  }
  const add = async (): Promise<void> => {
    if (!newName.trim()) return fail('새 사용자의 이름을 입력하세요.')
    if (newPin && newPin.length !== PIN_LEN) return fail(`새 사용자 PIN은 ${PIN_LABEL}입니다. 쓰지 않으려면 비워 두세요.`)
    const okText = `${newName.trim()} 님을 ${newPin ? '' : 'PIN 없이 '}추가했습니다. "사용자 바꾸기"로 나간 뒤 그 이름으로 시작해 서버에 사용 신청을 하세요.`
    if (await done(await invoke('seat:add', { ownerPin, name: newName, pin: newPin }), okText)) {
      setNewName('')
      setNewPin('')
      setOwnerPin('')
    }
  }
  const openAsk = (kind: AskKind, id: string, name: string): void => {
    setAsk({ kind, id, name })
    setAskPin('')
    setAskNew('')
    setAskErr('')
  }
  /** Carry out what the window asks; a wrong PIN or any refusal is shown in the window itself. */
  const confirmAsk = async (): Promise<void> => {
    if (!ask || askBusy) return
    if (ownerHasPin && !askPin) return setAskErr('PC 책임자의 PIN을 입력하세요.')
    if (ask.kind === 'reset' && askNew && askNew.length !== PIN_LEN) return setAskErr(`새 PIN은 ${PIN_LABEL}입니다. PIN 없이 쓰게 하려면 비워 두세요.`)
    setAskBusy(true)
    try {
      const r =
        ask.kind === 'remove'
          ? await invoke('seat:remove', { id: ask.id, pin: askPin, by: 'owner' })
          : ask.kind === 'reset'
            ? await invoke('seat:resetPin', { ownerPin: askPin, id: ask.id, newPin: askNew })
            : ask.kind === 'restore'
              ? await invoke('seat:restore', { ownerPin: askPin, id: ask.id })
              : await invoke('seat:purge', { ownerPin: askPin, id: ask.id })
      if (!r.ok) return setAskErr(r.error ?? '하지 못했습니다.')
      const okText: Record<AskKind, string> = {
        remove: `${ask.name} 님을 이 PC에서 지웠습니다. 자료는 ${KEEP}일 동안 보관되며 아래 "지운 사용자"에서 복구할 수 있습니다.`,
        reset: askNew ? `${ask.name} 님의 PIN을 새로 정했습니다.` : `${ask.name} 님의 PIN을 없앴습니다. 이제 이름만 눌러 시작합니다.`,
        restore: `${r.name ?? ask.name} 님을 복구했습니다. 시작 화면에서 전과 같이(PIN을 쓰던 사람은 예전 PIN으로) 들어갑니다.`,
        purge: `보관하던 ${ask.name} 님의 자료를 완전히 지웠습니다.`
      }
      setMsg({ ok: true, text: r.warning ?? okText[ask.kind] })
      setAsk(null)
      await load()
    } catch (e) {
      setAskErr(e instanceof Error ? e.message : '하지 못했습니다.')
    } finally {
      setAskBusy(false)
    }
  }
  const saveIdle = async (): Promise<void> => {
    const minutes = Number(idle)
    if (!Number.isInteger(minutes) || minutes < SEAT_IDLE_MIN || minutes > SEAT_IDLE_MAX) return fail(`자동 로그아웃 시간은 ${SEAT_IDLE_MIN}~${SEAT_IDLE_MAX}분입니다.`)
    if (await done(await invoke('seat:setIdle', { ownerPin, minutes }), `자동 로그아웃 시간을 ${minutes}분으로 바꿨습니다.`)) setOwnerPin('')
  }
  const disable = async (): Promise<void> => {
    // kept backups of removed people stay (never erased by turning the mode off); said before it is done
    if (
      removed.length &&
      !window.confirm(
        `지운 사용자 ${removed.length}명의 자료가 보관되어 있습니다.\n공용 PC 사용을 꺼도 이 자료는 지워지지 않고 남은 보관 기간 동안 그대로 있지만, 공용 PC 사용을 다시 켜야 복구할 수 있습니다. 보관 기간이 지나면 자동으로 지워집니다.\n지금 바로 없애려면 취소한 뒤 "완전히 지우기"를 먼저 누르세요.\n\n공용 PC 사용을 끌까요?`
      )
    )
      return
    // (without a PC 책임자 PIN nothing else asks: one question at least)
    if (!ownerHasPin && !removed.length && !window.confirm('공용 PC 사용을 끕니다. 이제 사용자 선택 없이 바로 시작합니다. 계속할까요?')) return
    if (await done(await invoke('seat:disable', { ownerPin }), '공용 PC 사용을 껐습니다. 이제 사용자 선택 없이 바로 시작합니다.')) {
      setOwnerPin('')
      setRecovery(null)
    }
  }
  const switchUser = (): void => {
    if (window.confirm('사용을 마치고(로그아웃) 사용자 선택 화면으로 돌아갑니다.\nTeamHub가 다시 시작되며, 저장하지 않은 내용은 사라집니다. 계속할까요?')) void invoke('seat:switch')
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
              PC 한 대를 여러 명이 함께 쓸 때만 켜세요. 켜면 TeamHub를 시작할 때 이름을 고르며(PIN을 정한 사람은 PIN도 입력), 사람마다 서버 승인·계정·개인 자료가 따로 관리됩니다. 한동안 쓰지 않으면 자동으로 로그아웃됩니다. 켜는 사람이 이 PC의 <b>PC 책임자</b>가 되어
              사용자를 추가하고 지웁니다. 지금 이 PC에 있는 자료는 켜는 사람의 것으로 그대로 남습니다. 혼자 쓰는 PC는 켤 필요가 없습니다.
            </p>
            <PinRule />
            <Limits />
            {removed.length > 0 && (
              <p className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground" role="note" data-testid="seat-removed-kept">
                전에 지운 사용자 {removed.length}명({removed.map((x) => x.name).join(', ')})의 자료가 아직 보관되어 있습니다. 공용 PC 사용을 다시 켜면 PC 책임자가 복구할 수 있고, 지운 날부터 {KEEP}일이 지나면 자동으로 완전히 지워집니다.
              </p>
            )}
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1">
                <span className="block text-xs text-muted-foreground">내 이름 (시작 화면에 표시)</span>
                <Input aria-label="내 이름 (시작 화면에 표시)" className="w-40" value={name} maxLength={SEAT_NAME_MAX} onChange={(e) => setName(e.target.value)} />
              </label>
              <Pin label={`내 PIN (${PIN_OPTIONAL})`} value={a} onChange={setA} />
              <Pin label="내 PIN 다시 입력" value={b} onChange={setB} />
              <Button variant="outline" onClick={() => void enable()}>
                <Users /> 공용 PC 사용 켜기
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              PC 책임자가 PIN 없이 쓰면 이 PC를 쓰는 누구나 PIN 확인 없이 사용자를 추가·삭제하고 다른 사람의 PIN을 초기화할 수 있습니다. 여러 명이 각자 PIN을 쓰는 PC라면 PC 책임자는 PIN을 정하세요.
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              지금 사용자: <b data-testid="seat-current">{me?.name ?? '-'}</b>
              {me?.owner && <Badge>PC 책임자</Badge>}
              <span className="text-xs text-muted-foreground" data-testid="seat-idle-note">
                · {st.idleMinutes}분 동안 쓰지 않으면 자동으로 로그아웃됩니다(1분 전에 알림)
              </span>
              <span className="ml-auto flex gap-2">
                {/* without a PIN there is nothing to open a lock with: such a person leaves with 사용자 바꾸기 */}
                {me?.hasPin && (
                  <Button variant="outline" size="sm" onClick={() => void invoke('lock:now')}>
                    <Lock /> 지금 잠그기
                  </Button>
                )}
                <Button variant="outline" size="sm" onClick={switchUser}>
                  <LogOut /> 사용자 바꾸기
                </Button>
              </span>
            </div>
            <PinRule />
            <Limits />
            {me?.hasPin ? (
              <div className="flex flex-wrap items-end gap-2" data-testid="seat-mypin">
                <Pin label="지금 내 PIN" value={a} onChange={setA} max={SEAT_PIN_MAX} />
                <Pin label={`새 PIN (${PIN_LABEL})`} value={b} onChange={setB} />
                <Button variant="outline" onClick={() => void changePin()}>
                  <KeyRound /> 내 PIN 바꾸기
                </Button>
                <Button variant="outline" onClick={() => void removePin()}>
                  <LockOpen /> PIN 없이 쓰기
                </Button>
              </div>
            ) : (
              <div className="space-y-2" data-testid="seat-mypin">
                <p className="rounded-md border border-border px-3 py-2 text-xs" role="note" data-testid="seat-nopin-note">
                  <b>지금 PIN 없이 쓰고 있습니다.</b> 이 PC 앞에 앉은 누구나 사용자 선택 창에서 내 이름만 눌러 내 TeamHub를 열 수 있습니다. 막으려면 PIN을 만드세요.
                </p>
                <div className="flex flex-wrap items-end gap-2">
                  <Pin label={`새 PIN (${PIN_LABEL})`} value={a} onChange={setA} />
                  <Pin label="새 PIN 다시 입력" value={b} onChange={setB} />
                  <Button variant="outline" onClick={() => void createPin()}>
                    <KeyRound /> 내 PIN 만들기
                  </Button>
                </div>
              </div>
            )}

            <div className="space-y-2 border-t border-border pt-3">
              <div className="text-sm font-medium">사용자 관리 (PC 책임자)</div>
              {!ownerHasPin && (
                <p className="flex items-start gap-2 rounded-md border border-urgent/40 bg-urgent/5 px-3 py-2 text-xs" role="alert" data-testid="seat-owner-nopin">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent" />
                  <span>
                    <b>PC 책임자({owner?.name ?? ''})에게 PIN이 없습니다.</b> 지금은 이 PC를 쓰는 누구나 PIN 확인 없이 사용자를 추가·삭제하고, 다른 사람의 PIN을 초기화하고, 자동 로그아웃 시간을 바꾸고, 공용 PC 사용을 끌 수 있습니다. 다른 사람이 정한 PIN도 이렇게 초기화될 수
                    있습니다. 막으려면 PC 책임자가 위의 &quot;내 PIN 만들기&quot;로 PIN을 만드세요.
                  </span>
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                사용자를 지우거나 PIN을 초기화하려면 그 줄의 단추를 누르세요{ownerHasPin ? '(PC 책임자의 PIN을 묻습니다)' : ''}. {ownerHasPin ? '사용자 추가·시간 바꾸기·끄기는 아래 칸에 PC 책임자의 PIN을 넣고 누릅니다. ' : ''}사용자를 지우면 이 PC에 있던 그 사람의 개인 자료와 접속 정보를{' '}
                {KEEP}일 동안 보관했다가 완전히 지웁니다. 그 안에는 아래 &quot;지운 사용자&quot;에서 복구할 수 있습니다. 서버의 계정은 그대로 남습니다(관리자가 관리 화면에서 사용 중지). 지금 사용 중인 사용자와 PC 책임자는 여기서 지울 수 없습니다.
              </p>
              <ul className="hover-rows divide-y divide-border rounded-md border border-border text-sm" data-testid="seat-rows">
                {st.seats.map((s) => (
                  <li key={s.id} className="flex items-center gap-2 px-3 py-1.5">
                    <span className="font-medium">{s.name}</span>
                    {s.owner && <Badge>PC 책임자</Badge>}
                    {s.hasPin ? <Lock className="size-3.5 text-muted-foreground" aria-label="PIN 사용" /> : <span className="text-xs text-muted-foreground">PIN 없음</span>}
                    {s.id === me?.id && <span className="text-xs text-muted-foreground">사용 중</span>}
                    {!s.owner && (
                      <span className="ml-auto flex gap-1">
                        <Button size="sm" variant="ghost" onClick={() => openAsk('reset', s.id, s.name)}>
                          PIN 초기화
                        </Button>
                        {s.id !== me?.id && (
                          <Button size="sm" variant="ghost" className="text-urgent" onClick={() => openAsk('remove', s.id, s.name)}>
                            <Trash2 /> 지우기
                          </Button>
                        )}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {removed.length > 0 && (
                <div className="space-y-1" data-testid="seat-removed">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <ArchiveRestore className="size-4" /> 지운 사용자 ({KEEP}일 보관)
                  </div>
                  <ul className="divide-y divide-border rounded-md border border-border text-sm" data-testid="seat-removed-rows">
                    {removed.map((x) => (
                      <li key={x.id} className="flex flex-wrap items-center gap-2 px-3 py-1.5">
                        <span className="font-medium">{x.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {day(x.removedAt)}에 지움 · {x.daysLeft > 0 ? `${x.daysLeft}일 뒤 완전히 지워짐` : '곧 완전히 지워짐'}
                        </span>
                        <span className="ml-auto flex gap-1">
                          <Button size="sm" variant="ghost" onClick={() => openAsk('restore', x.id, x.name)}>
                            <ArchiveRestore /> 복구
                          </Button>
                          <Button size="sm" variant="ghost" className="text-urgent" onClick={() => openAsk('purge', x.id, x.name)}>
                            <Trash2 /> 완전히 지우기
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex flex-wrap items-end gap-2">
                {ownerHasPin && <Pin label="PC 책임자 PIN" value={ownerPin} onChange={setOwnerPin} max={SEAT_PIN_MAX} />}
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">새 사용자 이름</span>
                  <Input aria-label="새 사용자 이름" className="w-36" value={newName} maxLength={SEAT_NAME_MAX} onChange={(e) => setNewName(e.target.value)} />
                </label>
                <Pin label={`새 사용자 PIN (${PIN_OPTIONAL})`} value={newPin} onChange={setNewPin} />
                <Button variant="outline" onClick={() => void add()}>
                  <UserPlus /> 사용자 추가
                </Button>
              </div>
              <div className="flex flex-wrap items-end gap-2">
                <label className="space-y-1">
                  <span className="block text-xs text-muted-foreground">
                    자동 로그아웃 시간 ({SEAT_IDLE_MIN}~{SEAT_IDLE_MAX}분)
                  </span>
                  <Input aria-label="자동 로그아웃 시간(분)" type="number" min={SEAT_IDLE_MIN} max={SEAT_IDLE_MAX} className="w-24" value={idle} onChange={(e) => setIdle(e.target.value)} />
                </label>
                <Button variant="outline" onClick={() => void saveIdle()}>
                  시간 바꾸기
                </Button>
                <Button variant="outline" className="ml-auto" disabled={st.seats.length > 1} title={st.seats.length > 1 ? '다른 사용자를 모두 지운 뒤에 끌 수 있습니다.' : undefined} onClick={() => void disable()}>
                  공용 PC 사용 끄기
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                자동 로그아웃: 이 시간 동안 PC를 쓰지 않으면 PIN이 있든 없든 로그아웃되어 사용자 선택 창으로 돌아갑니다. 1분 전에 알림 창이 뜨며, 그 창의 &quot;계속 사용&quot;을 누르거나 마우스·키보드를 쓰면 취소됩니다. 로그아웃되면 저장하지 않은 내용은 사라집니다. Windows를 잠가도(Windows 키 + L)
                바로 로그아웃됩니다.
              </p>
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
        <Dialog
          open={!!ask}
          onClose={() => setAsk(null)}
          title={ask ? ASK_TITLE[ask.kind](ask.name) : ''}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsk(null)}>
                취소
              </Button>
              <Button variant={ask?.kind === 'remove' || ask?.kind === 'purge' ? 'destructive' : 'default'} disabled={askBusy} onClick={() => void confirmAsk()} data-testid="seat-ask-ok">
                {ask ? ASK_OK[ask.kind] : ''}
              </Button>
            </>
          }
        >
          {ask && (
            <form
              className="space-y-3 text-sm"
              data-testid="seat-ask"
              onSubmit={(e) => {
                e.preventDefault()
                void confirmAsk()
              }}
            >
              {ask.kind === 'remove' && (
                <p>
                  <b>{ask.name}</b> 님을 이 PC의 사용자 목록에서 지웁니다. 이 PC에 있는 그 사람의 개인 자료(개인 일정·다이어리·메모·알람 등)와 접속 정보는 바로 지우지 않고 <b>{KEEP}일 동안 보관</b>하며, 그 안에는 PC 책임자가 &quot;지운 사용자&quot;에서 복구할 수
                  있습니다. {KEEP}일이 지나면 완전히 지워져 되돌릴 수 없습니다. 서버의 계정은 지워지지 않습니다. 필요하면 관리자가 관리 화면에서 사용 중지하세요.
                </p>
              )}
              {ask.kind === 'reset' && (
                <p>
                  <b>{ask.name}</b> 님이 PIN을 잊었을 때 새 PIN을 정해 줍니다. 새 PIN 칸을 비워 두면 그 사람은 PIN 없이 이름만 눌러 시작합니다. 그 사람의 자료는 그대로입니다.
                </p>
              )}
              {ask.kind === 'restore' && (
                <p>
                  <b>{ask.name}</b> 님을 다시 이 PC의 사용자로 등록하고, 보관해 둔 개인 자료와 접속 정보를 되돌립니다. 그 사람은 시작 화면에서 전과 같이 들어갑니다(PIN을 쓰던 사람은 <b>예전 PIN</b>으로, PIN이 없던 사람은 이름만 눌러서). 서버에는 전과 같이 접속됩니다(관리자가 계정을 사용
                  중지했다면 관리자에게 문의). 같은 이름의 사용자가 이미 있으면 이름 뒤에 &quot;(복구)&quot;를 붙여 복구합니다.
                </p>
              )}
              {ask.kind === 'purge' && (
                <p>
                  보관 중인 <b>{ask.name}</b> 님의 개인 자료와 접속 정보를 지금 <b>완전히 지웁니다. 되돌릴 수 없습니다.</b> 서버의 계정과 그 사람이 올린 글·파일은 지워지지 않습니다.
                </p>
              )}
              <div className="flex flex-wrap items-end gap-3">
                {ownerHasPin && <Pin label="PC 책임자 PIN" value={askPin} onChange={setAskPin} max={SEAT_PIN_MAX} />}
                {ask.kind === 'reset' && <Pin label={`새 PIN (${PIN_OPTIONAL})`} value={askNew} onChange={setAskNew} />}
              </div>
              {!ownerHasPin && (
                <p className="text-xs text-muted-foreground" data-testid="seat-ask-nopin">
                  PC 책임자에게 PIN이 없어 PIN 확인 없이 진행합니다.
                </p>
              )}
              {askErr && (
                <p className="text-urgent" role="alert">
                  {askErr}
                </p>
              )}
              <button type="submit" className="hidden" aria-hidden tabIndex={-1} />
            </form>
          )}
        </Dialog>
      </CardContent>
    </Card>
  )
}
