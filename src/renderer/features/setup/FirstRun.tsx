import { Server, MonitorSmartphone } from 'lucide-react'
import { SetupFrame } from './SetupFrame'

export function FirstRun({ onChoose }: { onChoose: (m: 'server' | 'client' | 'import') => void }): React.JSX.Element {
  return (
    <SetupFrame title="TeamHub 시작하기" subtitle="이 PC를 어떻게 사용할지 선택하세요. 나중에 설정에서 바꿀 수 있습니다." wide>
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          className="group cursor-pointer rounded-xl border-2 border-border bg-card p-6 text-left transition hover:border-primary"
          onClick={() => onChoose('client')}
        >
          <MonitorSmartphone className="mb-3 size-9 text-primary" />
          <div className="text-lg font-bold">서버에 접속</div>
          <p className="mt-1 text-sm text-muted-foreground">
            팀의 서버 PC 주소(IP)를 입력하고 사용 신청을 합니다. 대부분의 팀원은 이 방식을 선택합니다.
          </p>
        </button>
        <button
          className="group cursor-pointer rounded-xl border-2 border-border bg-card p-6 text-left transition hover:border-primary"
          onClick={() => onChoose('server')}
        >
          <Server className="mb-3 size-9 text-primary" />
          <div className="text-lg font-bold">이 PC를 서버로 사용</div>
          <p className="mt-1 text-sm text-muted-foreground">
            팀에서 한 대만 서버가 됩니다. 자료와 일정이 이 PC에 저장되고, 다른 팀원이 이 PC에 접속합니다.
          </p>
        </button>
      </div>
      <button className="mt-4 cursor-pointer text-sm text-primary hover:underline" onClick={() => onChoose('import')}>
        서버 PC를 바꾸나요? 기존 서버의 백업으로 이 PC를 서버로 만들기 →
      </button>
      <p className="mt-6 rounded-md bg-[var(--notice-bg)] px-3 py-2 text-sm text-[var(--notice-fg)]">
        ⚠ TeamHub는 가벼운 업무 정보 공유용입니다. 중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.
      </p>
    </SetupFrame>
  )
}
