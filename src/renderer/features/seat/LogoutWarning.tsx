import { useEffect, useState } from 'react'
import { LogOut } from 'lucide-react'
import type { LogoutWarning as Warning } from '@shared/ipc'
import { Button } from '@renderer/components/ui/button'
import { invoke } from '@renderer/lib/bridge'

/**
 * Shared PC: the small always-on-top window shown one minute before the automatic logout
 * (#/popup/logout). The main process owns the countdown and closes this window when the round
 * is over (any input, 계속 사용, or the logout itself); this only shows what is left.
 */
export function LogoutWarning(): React.JSX.Element {
  const [w, setW] = useState<Warning | null>(null)

  useEffect(() => {
    let alive = true
    const read = (): void => void invoke('seat:logoutWarning').then((v) => alive && v && setW(v))
    read()
    const t = window.setInterval(read, 500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  const left = w ? (w.seconds >= 60 ? `${Math.floor(w.seconds / 60)}분${w.seconds % 60 ? ` ${w.seconds % 60}초` : ''}` : `${w.seconds}초`) : ''
  return (
    <div className="flex h-screen flex-col border-4 border-primary bg-background text-foreground" data-testid="logout-warning">
      <div className="flex items-center gap-2 bg-primary px-3 py-2 text-primary-foreground">
        <LogOut className="size-5" />
        <span className="font-bold">자동 로그아웃 알림</span>
      </div>
      <div className="min-h-0 flex-1 px-4 py-3">
        <p className="text-lg font-bold" role="alert">
          <span data-testid="logout-left">{left}</span> 뒤 자동 로그아웃됩니다
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          {w ? `${w.name} 님, ` : ''}한동안 사용하지 않아 사용자 선택 화면으로 돌아갑니다. 저장하지 않은 내용은 사라집니다. 계속 쓰려면 &quot;계속 사용&quot;을 누르세요.
        </p>
      </div>
      <div className="flex items-center border-t border-border px-3 py-2">
        <Button className="ml-auto" autoFocus onClick={() => void invoke('seat:stay')}>
          계속 사용
        </Button>
      </div>
    </div>
  )
}
