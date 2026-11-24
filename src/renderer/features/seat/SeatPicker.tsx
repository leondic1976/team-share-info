import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, KeyRound, ShieldCheck, Trash2, UserPlus, UserRound, Users } from 'lucide-react'
import type { SeatInfo, SeatResult, SeatState } from '@shared/ipc'
import { SEAT_NAME_MAX, SEAT_PIN_MAX, SEAT_PIN_MIN } from '@shared/constants'
import { invoke } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { PinInput } from '@renderer/features/lock/LockGate'

type View = { kind: 'list' } | { kind: 'pin'; seat: SeatInfo } | { kind: 'forgot'; seat: SeatInfo } | { kind: 'add' } | { kind: 'remove'; seat: SeatInfo | null } | { kind: 'recovery'; code: string }

const PIN_LABEL = `숫자 ${SEAT_PIN_MIN}자리 이상`

function Err({ text }: { text: string }): React.JSX.Element | null {
  return text ? (
    <p className="text-sm text-urgent" role="alert">
      {text}
    </p>
  ) : null
}

function Back({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline" onClick={onClick}>
      <ArrowLeft className="size-3.5" /> 사용자 선택으로
    </button>
  )
}

/** Seconds left while nothing is accepted after too many wrong tries. */
function useWait(initialMs: number): { wait: number; hold: (ms?: number) => void } {
  const [until, setUntil] = useState(() => (initialMs > 0 ? Date.now() + initialMs : 0))
  const [, tick] = useState(0)
  useEffect(() => {
    if (!until) return
    const t = setInterval(() => (Date.now() >= until ? setUntil(0) : tick((n) => n + 1)), 500)
    return () => clearInterval(t)
  }, [until])
  return { wait: until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0, hold: (ms) => ms && setUntil(Date.now() + ms) }
}

function PinStep({ seat, onForgot, onBack }: { seat: SeatInfo; onForgot: () => void; onBack: () => void }): React.JSX.Element {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const { wait, hold } = useWait(seat.waitMs)

  const go = async (): Promise<void> => {
    if (lock.current || wait > 0) return
    if (pin.length < SEAT_PIN_MIN) return setErr(`PIN은 ${PIN_LABEL}입니다.`)
    lock.current = true
    setBusy(true)
    try {
      // on success the main process opens this person's TeamHub and closes this window
      const r = await invoke('seat:signIn', { id: seat.id, pin })
      if (!r.ok) {
        setErr(r.error ?? 'PIN이 맞지 않습니다.')
        setPin('')
        hold(r.waitMs)
      }
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  return (
    <>
      <p className="text-center text-lg font-bold" data-testid="seat-pin-name">
        {seat.name}
      </p>
      <PinInput
        label="PIN"
        value={pin}
        autoFocus
        max={SEAT_PIN_MAX}
        onChange={(v) => {
          setPin(v)
          setErr('')
        }}
        onEnter={() => void go()}
      />
      <Button className="w-full" onClick={() => void go()} disabled={busy || wait > 0}>
        {busy ? '여는 중…' : '시작'}
      </Button>
      {wait > 0 ? <Err text={`여러 번 틀렸습니다. ${wait}초 뒤에 다시 입력할 수 있습니다.`} /> : <Err text={err} />}
      <div className="flex items-center justify-between">
        <Back onClick={onBack} />
        <button className="cursor-pointer text-xs text-primary hover:underline" onClick={onForgot}>
          PIN을 잊었습니다
        </button>
      </div>
    </>
  )
}

/** Forgotten PIN: the PC 책임자 sets a new one for somebody else; their own needs the recovery code. */
function ForgotStep({ seat, onDone, onRecovery, onBack }: { seat: SeatInfo; onDone: () => void; onRecovery: (code: string) => void; onBack: () => void }): React.JSX.Element {
  const [auth, setAuth] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [err, setErr] = useState('')
  const { wait, hold } = useWait(0)

  const go = async (): Promise<void> => {
    if (next !== again) return setErr('두 번 입력한 새 PIN이 다릅니다.')
    const r: SeatResult = seat.owner ? await invoke('seat:recover', { code: auth, newPin: next }) : await invoke('seat:resetPin', { ownerPin: auth, id: seat.id, newPin: next })
    if (!r.ok) {
      setErr(r.error ?? '바꾸지 못했습니다.')
      hold(r.waitMs)
      return
    }
    if (r.recovery) onRecovery(r.recovery)
    else onDone()
  }

  return (
    <>
      <p className="text-center text-lg font-bold">{seat.name}</p>
      <p className="text-sm text-muted-foreground">
        {seat.owner
          ? '공용 PC 사용을 켤 때 적어 둔 복구 코드를 입력하고 새 PIN을 정하세요.'
          : 'PC 책임자가 자신의 PIN을 입력하면 이 사용자의 PIN을 새로 정할 수 있습니다. 이 사용자의 자료는 그대로 남습니다.'}
      </p>
      {seat.owner ? (
        <label className="block space-y-1">
          <span className="text-sm font-medium">복구 코드</span>
          <Input aria-label="복구 코드" className="text-center font-mono tracking-widest uppercase" value={auth} maxLength={12} onChange={(e) => setAuth(e.target.value)} autoFocus />
        </label>
      ) : (
        <PinInput label="PC 책임자 PIN" value={auth} onChange={setAuth} max={SEAT_PIN_MAX} autoFocus />
      )}
      <PinInput label={`새 PIN (${PIN_LABEL})`} value={next} onChange={setNext} max={SEAT_PIN_MAX} />
      <PinInput label="새 PIN 다시 입력" value={again} onChange={setAgain} max={SEAT_PIN_MAX} onEnter={() => void go()} />
      <Button className="w-full" onClick={() => void go()} disabled={wait > 0}>
        <KeyRound /> 새 PIN 정하기
      </Button>
      {wait > 0 ? <Err text={`여러 번 틀렸습니다. ${wait}초 뒤에 다시 입력할 수 있습니다.`} /> : <Err text={err} />}
      <Back onClick={onBack} />
    </>
  )
}

function AddStep({ onDone, onBack }: { onDone: () => void; onBack: () => void }): React.JSX.Element {
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [again, setAgain] = useState('')
  const [ownerPin, setOwnerPin] = useState('')
  const [err, setErr] = useState('')
  const { wait, hold } = useWait(0)

  const go = async (): Promise<void> => {
    if (!name.trim()) return setErr('이름을 입력하세요.')
    if (pin !== again) return setErr('두 번 입력한 PIN이 다릅니다.')
    const r = await invoke('seat:add', { ownerPin, name, pin })
    if (!r.ok) {
      setErr(r.error ?? '추가하지 못했습니다.')
      hold(r.waitMs)
      return
    }
    onDone()
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">새 사용자는 자신의 이름과 PIN으로 시작한 뒤 서버에 사용 신청을 하고, 관리자의 승인을 받아 자기 계정으로 씁니다. 추가하려면 PC 책임자의 PIN이 필요합니다.</p>
      <label className="block space-y-1">
        <span className="text-sm font-medium">이름</span>
        <Input aria-label="새 사용자 이름" value={name} maxLength={SEAT_NAME_MAX} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <PinInput label={`새 사용자 PIN (${PIN_LABEL})`} value={pin} onChange={setPin} max={SEAT_PIN_MAX} />
      <PinInput label="새 사용자 PIN 다시 입력" value={again} onChange={setAgain} max={SEAT_PIN_MAX} />
      <PinInput label="PC 책임자 PIN" value={ownerPin} onChange={setOwnerPin} max={SEAT_PIN_MAX} onEnter={() => void go()} />
      <Button className="w-full" onClick={() => void go()} disabled={wait > 0}>
        <UserPlus /> 사용자 추가
      </Button>
      {wait > 0 ? <Err text={`여러 번 틀렸습니다. ${wait}초 뒤에 다시 입력할 수 있습니다.`} /> : <Err text={err} />}
      <Back onClick={onBack} />
    </>
  )
}

function RemoveStep({ seats, picked, onDone, onBack }: { seats: SeatInfo[]; picked: SeatInfo | null; onDone: (warning?: string) => void; onBack: () => void }): React.JSX.Element {
  const others = seats.filter((s) => !s.owner)
  const [seat, setSeat] = useState<SeatInfo | null>(picked)
  const [by, setBy] = useState<'self' | 'owner'>('self')
  const [pin, setPin] = useState('')
  const [sure, setSure] = useState(false)
  const [err, setErr] = useState('')
  const { wait, hold } = useWait(0)

  const go = async (): Promise<void> => {
    if (!seat) return
    const r = await invoke('seat:remove', { id: seat.id, pin, by })
    if (!r.ok) {
      setErr(r.error ?? '지우지 못했습니다.')
      setPin('')
      hold(r.waitMs)
      return
    }
    onDone(r.warning)
  }

  if (!seat)
    return (
      <>
        <p className="text-sm text-muted-foreground">이 PC에서 지울 사용자를 고르세요. PC 책임자는 지울 수 없습니다.</p>
        <div className="space-y-2">
          {others.map((s) => (
            <Button key={s.id} variant="outline" className="h-11 w-full justify-start" onClick={() => setSeat(s)}>
              <UserRound /> {s.name}
            </Button>
          ))}
          {!others.length && <p className="text-sm">지울 수 있는 사용자가 없습니다.</p>}
        </div>
        <Back onClick={onBack} />
      </>
    )
  return (
    <>
      <p className="text-center text-lg font-bold">{seat.name} 지우기</p>
      <div className="rounded-md border border-urgent/40 bg-urgent/5 px-3 py-2 text-sm">
        이 PC에 있는 <b>{seat.name}</b> 님의 개인 자료(개인 일정·다이어리·메모·알람 등)와 접속 정보가 <b>모두 지워지며 되돌릴 수 없습니다.</b> 필요한 자료는 먼저 그 사용자로 들어가 설정의 &quot;내보내기&quot;로 보관하세요.
        <br />
        서버의 계정과 그 사용자가 올린 글·파일은 지워지지 않습니다. 계정은 관리자가 관리 화면에서 사용 중지합니다.
      </div>
      <div className="flex gap-2" role="radiogroup" aria-label="확인 방법">
        <Button size="sm" variant={by === 'self' ? 'default' : 'outline'} role="radio" aria-checked={by === 'self'} onClick={() => setBy('self')}>
          본인 PIN으로
        </Button>
        <Button size="sm" variant={by === 'owner' ? 'default' : 'outline'} role="radio" aria-checked={by === 'owner'} onClick={() => setBy('owner')}>
          PC 책임자 PIN으로
        </Button>
      </div>
      <PinInput label={by === 'self' ? `${seat.name} PIN` : 'PC 책임자 PIN'} value={pin} onChange={setPin} max={SEAT_PIN_MAX} />
      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5" checked={sure} onChange={(e) => setSure(e.target.checked)} aria-label="자료 삭제 확인" />
        <span>이 PC에 있는 {seat.name} 님의 개인 자료가 지워지는 것을 확인했습니다.</span>
      </label>
      <Button variant="destructive" className="w-full" onClick={() => void go()} disabled={!sure || pin.length < SEAT_PIN_MIN || wait > 0}>
        <Trash2 /> 이 PC에서 지우기
      </Button>
      {wait > 0 ? <Err text={`여러 번 틀렸습니다. ${wait}초 뒤에 다시 입력할 수 있습니다.`} /> : <Err text={err} />}
      <Back onClick={onBack} />
    </>
  )
}

function Shell({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-screen flex-col overflow-y-auto bg-background p-6 text-foreground" data-testid="seat-picker">
      <div className="mb-4 flex items-center gap-2 text-lg font-bold">
        <Users className="size-5 text-primary" /> TeamHub 사용자 선택
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  )
}

/**
 * Shared PC: the window shown instead of the main window until somebody signed in. Nothing of
 * anybody is loaded here; only the names are known. The PIN is checked by the main process.
 */
export function SeatPicker(): React.JSX.Element {
  const [st, setSt] = useState<SeatState | null>(null)
  const [view, setView] = useState<View>({ kind: 'list' })
  const [note, setNote] = useState('')

  const load = useCallback(async () => setSt(await invoke('seat:state')), [])
  useEffect(() => {
    void load()
  }, [load])
  const home = (text = ''): void => {
    setNote(text)
    setView({ kind: 'list' })
    void load()
  }

  if (!st) return <Shell>{null}</Shell>
  if (st.damaged)
    return (
      <Shell>
        <p className="text-sm text-urgent" role="alert">
          사용자 목록을 읽을 수 없어 시작할 수 없습니다. 이 PC를 관리하는 PC 책임자나 담당자에게 알려 주세요. (프로그램 자료 폴더의 seats.json 파일이 손상되었습니다.)
        </p>
      </Shell>
    )

  switch (view.kind) {
    case 'pin':
      return (
        <Shell>
          <PinStep key={view.seat.id} seat={view.seat} onForgot={() => setView({ kind: 'forgot', seat: view.seat })} onBack={() => home()} />
        </Shell>
      )
    case 'forgot':
      return (
        <Shell>
          <ForgotStep seat={view.seat} onDone={() => home(`${view.seat.name} 님의 PIN을 새로 정했습니다.`)} onRecovery={(code) => setView({ kind: 'recovery', code })} onBack={() => home()} />
        </Shell>
      )
    case 'add':
      return (
        <Shell>
          <AddStep onDone={() => home('사용자를 추가했습니다. 이름을 눌러 시작하세요.')} onBack={() => home()} />
        </Shell>
      )
    case 'remove':
      return (
        <Shell>
          <RemoveStep seats={st.seats} picked={view.seat} onDone={(w) => home(w ?? '사용자를 지웠습니다.')} onBack={() => home()} />
        </Shell>
      )
    case 'recovery':
      return (
        <Shell>
          <div className="flex items-center gap-2 font-bold">
            <ShieldCheck className="size-5 text-success" /> 새 복구 코드를 적어 두세요
          </div>
          <p className="text-sm text-muted-foreground">PC 책임자의 PIN을 새로 정했습니다. 이전 복구 코드는 더 쓸 수 없습니다. 지금 한 번만 보여 드리니 종이에 적어 안전한 곳에 두세요.</p>
          <div className="selectable rounded-md bg-muted py-3 text-center font-mono text-2xl font-bold tracking-widest" data-testid="recovery-code">
            {view.code}
          </div>
          <Button className="w-full" onClick={() => home()}>
            적어 두었습니다
          </Button>
        </Shell>
      )
    default:
      return (
        <Shell>
          <p className="text-sm text-muted-foreground">이 PC는 여러 명이 함께 씁니다. 이름을 누르고 PIN을 입력하세요.</p>
          <div className="space-y-2" data-testid="seat-list">
            {st.seats.map((s) => (
              <Button key={s.id} variant="outline" className="h-14 w-full justify-start gap-3 text-base" onClick={() => setView({ kind: 'pin', seat: s })} data-testid={`seat-${s.name}`}>
                <UserRound className="size-5" />
                <span className="font-semibold">{s.name}</span>
                {s.owner && <span className="ml-auto text-xs text-muted-foreground">PC 책임자</span>}
              </Button>
            ))}
          </div>
          {note && <p className="text-sm text-success">{note}</p>}
          <div className="flex gap-2 border-t border-border pt-3">
            <Button size="sm" variant="ghost" onClick={() => setView({ kind: 'add' })}>
              <UserPlus /> 새 사용자 추가
            </Button>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setView({ kind: 'remove', seat: null })}>
              <Trash2 /> 사용자 지우기
            </Button>
          </div>
        </Shell>
      )
  }
}
