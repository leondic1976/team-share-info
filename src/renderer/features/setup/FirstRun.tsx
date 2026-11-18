import { useEffect, useState } from 'react'
import { Server, MonitorSmartphone, Lock } from 'lucide-react'
import { SetupFrame } from './SetupFrame'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import type { ConnInfo } from '@shared/ipc'

export function FirstRun({ onChoose }: { onChoose: (m: 'server' | 'client' | 'import') => void }): React.JSX.Element {
  // Server PC or member PC is decided once; a PC that was set up before can only be set up the same way again.
  const [locked, setLocked] = useState<ConnInfo['lockedRole']>(null)
  useEffect(() => {
    void invoke('conn:get').then((c) => setLocked(c.lockedRole))
  }, [])
  const card = (off: boolean): string =>
    cn('group rounded-xl border-2 border-border bg-card p-6 text-left transition', off ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:border-primary')

  return (
    <SetupFrame
      title="TeamHub 시작하기"
      subtitle={locked ? '이 PC는 처음 설정한 용도로만 사용할 수 있습니다.' : '이 PC를 어떻게 사용할지 선택하세요. 한 번 정하면 나중에 바꿀 수 없습니다.'}
      wide
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <button className={card(locked === 'server')} disabled={locked === 'server'} onClick={() => onChoose('client')}>
          <MonitorSmartphone className="mb-3 size-9 text-primary" />
          <div className="text-lg font-bold">서버에 접속 (일반용 PC)</div>
          <p className="mt-1 text-sm text-muted-foreground">
            팀의 서버 PC 주소(IP)를 입력하고 사용 신청을 합니다. 대부분의 팀원은 이 방식을 선택합니다.
          </p>
        </button>
        <button className={card(locked === 'client')} disabled={locked === 'client'} onClick={() => onChoose('server')}>
          <Server className="mb-3 size-9 text-primary" />
          <div className="text-lg font-bold">이 PC를 서버로 사용 (서버용 PC)</div>
          <p className="mt-1 text-sm text-muted-foreground">
            팀에서 한 대만 서버가 됩니다. 자료와 일정이 이 PC에 저장되고, 다른 팀원이 이 PC에 접속합니다.
          </p>
        </button>
      </div>
      {locked !== 'client' && (
        <button className="mt-4 cursor-pointer text-sm text-primary hover:underline" onClick={() => onChoose('import')}>
          서버 PC를 바꾸나요? 기존 서버의 백업으로 이 PC를 서버로 만들기 →
        </button>
      )}
      {locked && (
        <p className="mt-4 flex items-start gap-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground" data-testid="role-locked">
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            이 PC는 <b className="text-foreground">{locked === 'server' ? '서버용 PC' : '일반용(팀원) PC'}</b>로 설치되었습니다. 서버용과 일반용은 서로 바꿀 수 없습니다. 다른 용도로 쓰려면 프로그램과
            프로그램 자료를 지우고 새로 설치해야 합니다.
          </span>
        </p>
      )}
      <p className="mt-6 rounded-md bg-[var(--notice-bg)] px-3 py-2 text-sm text-[var(--notice-fg)]">
        ⚠ TeamHub는 가벼운 업무 정보 공유용입니다. 중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.
      </p>
    </SetupFrame>
  )
}
