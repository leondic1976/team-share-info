import { Construction } from 'lucide-react'
import { EmptyState } from '@renderer/components/EmptyState'
import { PageHeader } from '@renderer/components/PageHeader'

export function ComingSoon({ title }: { title: string }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PageHeader title={title} />
      <EmptyState icon={Construction} title="준비 중입니다" description="이 기능은 다음 업데이트에서 제공됩니다." />
    </div>
  )
}
