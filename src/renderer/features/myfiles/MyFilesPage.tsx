import { useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { FolderTree, Search, Tags } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { ExplorerTab } from './ExplorerTab'
import { SearchTab } from './SearchTab'
import { OrganizeTab } from './OrganizeTab'

type Tab = 'explorer' | 'search' | 'organize'

/** Personal files (6.18 ①②③): explorer, fast search, tags & virtual folders. All local. */
export function MyFilesPage(): React.JSX.Element {
  const { tab: t } = useParams()
  const navigate = useNavigate()
  const tab: Tab = t === 'search' || t === 'organize' ? t : 'explorer'
  const [under, setUnder] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  const timer = useRef<number | null>(null)
  const notify = (s: string): void => {
    setMsg(s)
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setMsg(''), 4000)
  }
  const tabs: { key: Tab; label: string; icon: typeof Search }[] = [
    { key: 'explorer', label: '탐색기', icon: FolderTree },
    { key: 'search', label: '빠른 검색', icon: Search },
    { key: 'organize', label: '태그·가상 폴더', icon: Tags }
  ]
  return (
    <div className="flex h-full flex-col">
      <PageHeader title="내 파일" description="이 PC의 파일을 찾고 정리합니다. 태그·가상 폴더·색인은 이 PC에만 저장됩니다." />
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-2" role="tablist">
        {tabs.map((x) => (
          <Button key={x.key} role="tab" aria-selected={tab === x.key} size="sm" variant={tab === x.key ? 'default' : 'ghost'} onClick={() => navigate(`/myfiles/${x.key}`)}>
            <x.icon /> {x.label}
          </Button>
        ))}
        {msg && (
          <span className="ml-auto self-center text-sm text-primary" role="status">
            {msg}
          </span>
        )}
      </div>
      {tab === 'explorer' && (
        <ExplorerTab
          notify={notify}
          onSearchHere={(d) => {
            setUnder(d)
            navigate('/myfiles/search')
          }}
        />
      )}
      {tab === 'search' && <SearchTab notify={notify} under={under} clearUnder={() => setUnder(null)} />}
      {tab === 'organize' && <OrganizeTab notify={notify} />}
    </div>
  )
}
