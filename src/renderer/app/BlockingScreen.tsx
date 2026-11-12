import { useEffect, useState } from 'react'
import { Ban, Download, Loader2 } from 'lucide-react'
import { useConn } from './conn-store'
import { StatusBar } from './StatusBar'
import { Button } from '@renderer/components/ui/button'
import { invoke, onMain } from '@renderer/lib/bridge'
import type { UpdateState } from '@shared/ipc'

/** Full-screen states where the app cannot be used: device revoked or update required. */
export function BlockingScreen({ onReset }: { onReset: () => void }): React.JSX.Element {
  const { state, message, serverUrl } = useConn()
  const [upd, setUpd] = useState<UpdateState | null>(null)

  useEffect(() => {
    if (state !== 'update-required' || !serverUrl) return
    void invoke('update:check', { serverUrl, manual: true }).then(setUpd)
    return onMain('update:state', setUpd)
  }, [state, serverUrl])

  return (
    <div className="flex h-full flex-col">
      <div className="drag h-[44px] shrink-0" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
        {state === 'update-required' ? (
          <>
            <Download className="size-12 text-primary" />
            <h1 className="text-xl font-bold">업데이트가 필요합니다</h1>
            <p className="max-w-md text-sm text-muted-foreground">서버가 새 버전으로 바뀌었습니다. 새 버전을 설치해야 계속 사용할 수 있습니다.</p>
            {upd?.status === 'downloaded' ? (
              <Button onClick={() => void invoke('update:install')}>지금 설치하고 다시 시작</Button>
            ) : upd?.status === 'downloading' || upd?.status === 'checking' || upd?.status === 'available' ? (
              <p className="flex items-center gap-2 text-sm">
                <Loader2 className="size-4 animate-spin" /> 새 버전을 받는 중… {upd.percent ? `${upd.percent}%` : ''}
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                {upd?.message ?? '자동 업데이트를 사용할 수 없으면 관리자에게 받은 설치 파일로 다시 설치하세요.'}
                {serverUrl && (
                  <>
                    <br />
                    설치 파일: {serverUrl}/download
                  </>
                )}
              </p>
            )}
          </>
        ) : (
          <>
            <Ban className="size-12 text-urgent" />
            <h1 className="text-xl font-bold">사용이 중지되었습니다</h1>
            <p className="max-w-md text-sm text-muted-foreground">{message || '관리자가 이 PC의 사용을 중지했습니다.'}</p>
            <Button
              variant="outline"
              onClick={async () => {
                await invoke('conn:reset')
                onReset()
              }}
            >
              처음부터 다시 신청
            </Button>
          </>
        )}
      </div>
      <StatusBar />
    </div>
  )
}
