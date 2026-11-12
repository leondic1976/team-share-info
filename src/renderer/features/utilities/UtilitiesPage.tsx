import { useState } from 'react'
import { Calculator, Gauge, Network, Settings2, ShieldCheck, Trash2 } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { CalcTools } from './CalcTools'
import { NetworkTab, ResourcesTab, SecurityTab, SettingsShortcutsTab, TempTab } from './SysTabs'

/** PC utilities (6.14). Everything runs on this PC; nothing is sent to the server. */
export const UTILITY_TABS: { key: string; label: string; icon: typeof Calculator; render: () => React.JSX.Element }[] = [
  { key: 'resources', label: 'PC 자원', icon: Gauge, render: () => <ResourcesTab /> },
  { key: 'security', label: '보안 점검', icon: ShieldCheck, render: () => <SecurityTab /> },
  { key: 'network', label: '네트워크 진단', icon: Network, render: () => <NetworkTab /> },
  { key: 'temp', label: '임시 파일 정리', icon: Trash2, render: () => <TempTab /> },
  { key: 'settings', label: 'Windows 설정', icon: Settings2, render: () => <SettingsShortcutsTab /> },
  { key: 'calc', label: '계산 도구', icon: Calculator, render: () => <CalcTools /> }
]

export function UtilitiesPage(): React.JSX.Element {
  const [tab, setTab] = useState(UTILITY_TABS[0].key)
  const cur = UTILITY_TABS.find((t) => t.key === tab) ?? UTILITY_TABS[0]
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="유틸리티" description="이 PC에서만 동작하며 결과는 다른 사람에게 보내지 않습니다." />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2" role="tablist">
        {UTILITY_TABS.map((t) => (
          <Button key={t.key} role="tab" aria-selected={tab === t.key} size="sm" variant={tab === t.key ? 'default' : 'ghost'} onClick={() => setTab(t.key)}>
            <t.icon /> {t.label}
          </Button>
        ))}
      </div>
      <cur.render />
    </div>
  )
}
