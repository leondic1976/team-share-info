import { useState } from 'react'
import { KeyRound, Lock, LockOpen } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { invoke } from '@renderer/lib/bridge'
import { useLock } from '@renderer/features/lock/LockGate'
import { cn } from '@renderer/lib/utils'

const only4 = (v: string): string => v.replace(/\D/g, '').slice(0, 4)

function Pin({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }): React.JSX.Element {
  return (
    <label className="space-y-1">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <Input aria-label={label} type="password" inputMode="numeric" autoComplete="off" maxLength={4} className="w-28" value={value} onChange={(e) => onChange(only4(e.target.value))} />
    </label>
  )
}

/** Settings: the optional program lock - make a PIN (on), change it, lock now, remove it (off). */
export function LockCard(): React.JSX.Element | null {
  const st = useLock()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [recovery, setRecovery] = useState<string | null>(null)
  if (!st) return null
  const reset = (): void => {
    setA('')
    setB('')
  }
  const fail = (text: string): void => setMsg({ ok: false, text })

  const create = async (): Promise<void> => {
    if (a.length !== 4) return fail('PIN은 숫자 4자리입니다.')
    if (a !== b) return fail('두 번 입력한 PIN이 다릅니다.')
    const r = await invoke('lock:create', { pin: a })
    if (!r.ok) return fail(r.error ?? 'PIN을 만들지 못했습니다.')
    setRecovery(r.recovery ?? null)
    setMsg({ ok: true, text: '잠금 PIN을 켰습니다. 다음에 프로그램을 시작할 때부터 PIN을 묻습니다.' })
    reset()
  }
  const change = async (): Promise<void> => {
    if (b.length !== 4) return fail('새 PIN은 숫자 4자리입니다.')
    const r = await invoke('lock:change', { oldPin: a, newPin: b })
    setMsg(r.ok ? { ok: true, text: 'PIN을 바꿨습니다.' } : { ok: false, text: r.error ?? '바꾸지 못했습니다.' })
    if (r.ok) reset()
  }
  const remove = async (): Promise<void> => {
    if (a.length !== 4) return fail('잠금을 끄려면 지금 PIN을 입력하세요.')
    const r = await invoke('lock:remove', { pin: a })
    setMsg(r.ok ? { ok: true, text: '잠금 PIN을 껐습니다.' } : { ok: false, text: r.error ?? '끄지 못했습니다.' })
    if (r.ok) {
      reset()
      setRecovery(null)
    }
  }

  return (
    <Card data-testid="lock-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Lock className="size-4" /> 잠금 PIN (선택)
        </CardTitle>
        <span className="text-xs text-muted-foreground">{st.hasPin ? '사용 중' : '사용 안 함'}</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          켜 두면 프로그램을 시작할 때와 Windows를 잠갔다가 돌아왔을 때 숫자 4자리 PIN을 묻습니다. 다른 사람이 이 PC에서 TeamHub를 열어 보지 못하게 하려면 사용하세요.
        </p>
        {st.hasPin ? (
          <div className="flex flex-wrap items-end gap-2">
            <Pin label="지금 PIN" value={a} onChange={setA} />
            <Pin label="새 PIN" value={b} onChange={setB} />
            <Button variant="outline" onClick={() => void change()}>
              <KeyRound /> PIN 바꾸기
            </Button>
            <Button variant="outline" onClick={() => void remove()}>
              <LockOpen /> 잠금 끄기
            </Button>
            <Button variant="outline" className="ml-auto" onClick={() => void invoke('lock:now')}>
              <Lock /> 지금 잠그기
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Pin label="새 PIN (숫자 4자리)" value={a} onChange={setA} />
            <Pin label="새 PIN 다시 입력" value={b} onChange={setB} />
            <Button variant="outline" onClick={() => void create()}>
              <KeyRound /> 잠금 PIN 켜기
            </Button>
          </div>
        )}
        {recovery && (
          <div className="rounded-md border border-border px-3 py-2 text-sm" role="note">
            <b>복구 코드를 적어 두세요.</b> PIN을 잊었을 때 이 코드로 새 PIN을 만듭니다. 지금 한 번만 보여 드립니다.
            <div className="selectable mt-1 font-mono text-lg font-bold tracking-widest" data-testid="recovery-code">
              {recovery}
            </div>
            <span className="text-xs text-muted-foreground">PIN과 복구 코드를 모두 잃어버리면 프로그램 자료를 지우고 새로 설치해야 합니다.</span>
          </div>
        )}
        {msg && <p className={cn('text-xs', msg.ok ? 'text-success' : 'text-urgent')}>{msg.text}</p>}
      </CardContent>
    </Card>
  )
}
