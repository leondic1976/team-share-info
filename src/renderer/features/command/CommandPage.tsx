import { Construction, Siren } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { EmptyState } from '@renderer/components/EmptyState'

/**
 * 긴급구조지휘대 (지시 79, 2026-11-25): the place for running, training, exercising and learning
 * 긴급구조통제단 and 긴급구조현장지휘대(지휘반), with the material their operation needs. It belongs to
 * the program but stands on its own. The user will describe its content later; until then it
 * says it is being made.
 */
export function CommandPage(): React.JSX.Element {
  return (
    <div className="flex h-full flex-col" data-testid="command-page">
      <PageHeader
        title={
          <span className="flex items-center gap-2 text-urgent">
            <Siren className="size-5" aria-hidden /> 긴급구조지휘대
          </span>
        }
        description="긴급구조통제단 및 긴급구조현장지휘대(지휘반)의 운영·훈련·연습·숙지를 위한 곳입니다."
      />
      <EmptyState
        icon={Construction}
        title="제작 중입니다"
        description="긴급구조통제단과 긴급구조현장지휘대(지휘반)를 운영하고 훈련·연습·숙지하는 곳으로, 운용에 필요한 자료도 이곳에 둘 수 있게 준비하고 있습니다. 내용은 다음 업데이트에서 채워집니다."
      />
    </div>
  )
}
