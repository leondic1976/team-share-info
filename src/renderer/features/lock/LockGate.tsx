import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Lock, ShieldCheck } from 'lucide-react'
import type { LockState } from '@shared/ipc'
import { invoke, onMain } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Loading } from '@renderer/components/EmptyState'

/** Lock state of the program, kept current in every window. */
export function useLock(): LockState | null {
  const [st, setSt] = useState<LockState | null>(null)
  useEffect(() => {
    void invoke('lock:state').then(setSt)
    return onMain('lock:changed', setSt)
  }, [])
  return st
}

const only4 = (v: string): string => v.replace(/\D/g, '').slice(0, 4)

export function PinInput({ label, value, onChange, autoFocus, onEnter }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; onEnter?: () => void }): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-sm font-medium">{label}</span>
      <Input
        aria-label={label}
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={4}
        className="h-11 text-center text-xl tracking-[0.6em]"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(only4(e.target.value))}
        onKeyDown={(e) => e.key === 'Enter' && onEnter?.()}
      />
    </label>
  )
}

function Frame({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="flex h-screen items-center justify-center bg-background p-6 text-foreground" data-testid="lock-screen">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2 text-lg font-bold">
          {icon} {title}
        </div>
        {children}
      </div>
    </div>
  )
}

/** The recovery code is shown once, right after it was made. */
export function RecoveryNote({ code, onDone }: { code: string; onDone: () => void }): React.JSX.Element {
  return (
    <Frame icon={<ShieldCheck className="size-5 text-success" />} title="복구 코드를 적어 두세요">
      <p className="text-sm text-muted-foreground">PIN을 잊었을 때 이 코드로 새 PIN을 만들 수 있습니다. 지금 한 번만 보여 드리니 종이에 적어 안전한 곳에 두세요.</p>
      <div className="selectable rounded-md bg-muted py-3 text-center font-mono text-2xl font-bold tracking-widest" data-testid="recovery-code">
        {code}
      </div>
      <p className="text-xs text-muted-foreground">PIN과 복구 코드를 모두 잃어버리면 프로그램 자료를 지우고 새로 설치해야 합니다.</p>
      <Button className="w-full" onClick={onDone}>
        적어 두었습니다
      </Button>
    </Frame>
  )
}

function Unlock({ waitMs, onRecovery }: { waitMs: number; onRecovery: (code: string) => void }): React.JSX.Element {
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [until, setUntil] = useState(() => (waitMs ? Date.now() + waitMs : 0))
  const [, tick] = useState(0)
  const [forgot, setForgot] = useState(false)
  const [code, setCode] = useState('')
  const [next, setNext] = useState('')
  const busy = useRef(false)

  useEffect(() => {
    if (!until) return
    const t = setInterval(() => (Date.now() >= until ? setUntil(0) : tick((n) => n + 1)), 500)
    return () => clearInterval(t)
  }, [until])
  const wait = until ? Math.max(0, Math.ceil((until - Date.now()) / 1000)) : 0

  const tryUnlock = async (v: string): Promise<void> => {
    if (busy.current || v.length !== 4) return
    busy.current = true
    try {
      const r = await invoke('lock:unlock', { pin: v })
      if (!r.ok) {
        setErr(r.error ?? 'PIN이 맞지 않습니다.')
        setPin('')
        if (r.waitMs) setUntil(Date.now() + r.waitMs)
      }
    } finally {
      busy.current = false
    }
  }
  const recover = async (): Promise<void> => {
    if (next.length !== 4) return setErr('새 PIN은 숫자 4자리입니다.')
    const r = await invoke('lock:recover', { code, newPin: next })
    if (r.ok && r.recovery) onRecovery(r.recovery)
    else {
      setErr(r.error ?? '복구하지 못했습니다.')
      if (r.waitMs) setUntil(Date.now() + r.waitMs)
    }
  }

  return (
    <Frame icon={<Lock className="size-5 text-primary" />} title="TeamHub 잠금">
      {forgot ? (
        <>
          <p className="text-sm text-muted-foreground">PIN을 만들 때 적어 둔 복구 코드를 입력하고 새 PIN을 정하세요.</p>
          <label className="block space-y-1">
            <span className="text-sm font-medium">복구 코드</span>
            <Input aria-label="복구 코드" className="text-center font-mono tracking-widest uppercase" value={code} maxLength={12} onChange={(e) => setCode(e.target.value)} autoFocus />
          </label>
          <PinInput label="새 PIN (숫자 4자리)" value={next} onChange={setNext} onEnter={() => void recover()} />
          <Button className="w-full" onClick={() => void recover()} disabled={wait > 0}>
            새 PIN 만들기
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">PIN 4자리를 입력하세요.</p>
          <PinInput
            label="PIN"
            value={pin}
            autoFocus
            onChange={(v) => {
              setPin(v)
              setErr('')
              if (v.length === 4 && !wait) void tryUnlock(v)
            }}
            onEnter={() => void tryUnlock(pin)}
          />
        </>
      )}
      {wait > 0 ? (
        <p className="text-sm text-urgent" role="alert">
          여러 번 틀렸습니다. {wait}초 뒤에 다시 입력할 수 있습니다.
        </p>
      ) : (
        err && (
          <p className="text-sm text-urgent" role="alert">
            {err}
          </p>
        )
      )}
      <button
        className="cursor-pointer text-xs text-primary hover:underline"
        onClick={() => {
          setForgot(!forgot)
          setErr('')
        }}
      >
        {forgot ? '← PIN 입력으로 돌아가기' : 'PIN을 잊었습니다'}
      </button>
    </Frame>
  )
}

/** With the lock turned on (settings), nothing of the program is shown until the PIN was entered. */
export function LockGate({ children }: { children: ReactNode }): React.JSX.Element {
  const st = useLock()
  const [recovery, setRecovery] = useState<string | null>(null)
  if (!st) return <Loading />
  if (recovery) return <RecoveryNote code={recovery} onDone={() => setRecovery(null)} />
  if (st.locked) return <Unlock waitMs={st.waitMs} onRecovery={setRecovery} />
  return <>{children}</>
}

/** Small windows with personal content (sticky memos, quick memo, launcher) while the program is locked. */
export function LockedSmall({ children }: { children: ReactNode }): React.JSX.Element {
  const st = useLock()
  if (!st) return <Loading />
  if (st.locked)
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-2 bg-background text-sm text-muted-foreground" data-testid="locked-small">
        <Lock className="size-5" />
        잠겨 있습니다. TeamHub 창에서 PIN을 입력하세요.
      </div>
    )
  return <>{children}</>
}
