import { MENU_PLUGINS } from '@renderer/app/menu'
import { usePrefs } from '@renderer/app/prefs-store'
import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Download, ExternalLink, FileUp, Loader2, Play, Puzzle, ShieldCheck, Trash2 } from 'lucide-react'
import { DOWNLOAD_SITE } from '@shared/constants'
import { compareVersions } from '@shared/semver'
import { PLUGIN_SORTS, sortCatalog, type PluginSort } from '@shared/plugin-stats'
import { PLUGIN_PERMISSIONS, type CatalogPlugin, type PluginManifest, type PluginPermission } from '@shared/schemas/plugins'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState } from '@renderer/components/EmptyState'
import { NamedIcon, PluginIcon } from '@renderer/components/NamedIcon'
import { invoke, onMain } from '@renderer/lib/bridge'

const SORT_KEY = 'teamhub.plugins.sort'

interface Pending {
  manifest: Pick<PluginManifest, 'id' | 'name' | 'version' | 'description' | 'author' | 'iconName' | 'permissions'>
  from: { kind: 'catalog'; id: string } | { kind: 'file'; path: string }
}

function Permissions({ list }: { list: PluginPermission[] }): React.JSX.Element {
  if (!list.length) return <p className="text-sm text-muted-foreground">특별한 권한을 쓰지 않습니다.</p>
  return (
    <ul className="space-y-1 text-sm">
      {list.map((p) => (
        <li key={p} className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-primary" /> {PLUGIN_PERMISSIONS[p]}
        </li>
      ))}
    </ul>
  )
}

/** 확장 기능: installed plugins, the catalog of the download site, install from a file. */
export function PluginsPage(): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const installed = useQuery({ queryKey: ['local', 'plugins'], queryFn: () => invoke('plugins:list'), networkMode: 'always' })
  const catalog = useQuery({ queryKey: ['local', 'plugin-catalog'], queryFn: () => invoke('plugins:catalog'), networkMode: 'always', staleTime: 300_000 })
  // Download counts come from an external counter and are optional: without the internet the
  // result is empty, nothing is shown and installing works the same.
  const catalogIds = (catalog.data?.data ?? []).map((c) => c.id)
  const counts = useQuery({
    queryKey: ['local', 'plugin-counts', catalogIds.join(',')],
    queryFn: () => invoke('plugins:downloadCounts', { ids: catalogIds }).catch(() => ({}) as Record<string, number>),
    networkMode: 'always',
    enabled: catalogIds.length > 0,
    staleTime: 300_000,
    retry: false
  })
  const [sort, setSort] = useState<PluginSort>(() => {
    try {
      const s = localStorage.getItem(SORT_KEY)
      return s && s in PLUGIN_SORTS ? (s as PluginSort) : 'popular'
    } catch {
      return 'popular'
    }
  })
  const chooseSort = (s: PluginSort): void => {
    setSort(s)
    try {
      localStorage.setItem(SORT_KEY, s)
    } catch {
      // the choice just lasts until the window closes
    }
  }
  // extensions that are a left-menu item of their own (식사 신청) are not offered or listed here
  const gallery = sortCatalog(catalog.data?.data ?? [], sort, counts.data ?? {}).filter((c) => !MENU_PLUGINS[c.id])
  const mine = (installed.data ?? []).filter((p) => !MENU_PLUGINS[p.manifest.id])
  // 관리대장 is part of the program: it cannot be uninstalled, but it can be taken off this PC's menu (ledgers are kept)
  const { hiddenMenus, update: updatePrefs } = usePrefs()
  const ledgerOff = hiddenMenus.includes('ledger')
  useEffect(() => onMain('plugins:changed', () => void qc.invalidateQueries({ queryKey: ['local', 'plugins'] })), [qc])
  const have = new Map((installed.data ?? []).map((p) => [p.manifest.id, p]))
  const askCatalog = (c: CatalogPlugin): void => setPending({ manifest: c, from: { kind: 'catalog', id: c.id } })
  /** Plugins shipped with TeamHub install with one click: no download, no questions. */
  const installNow = async (list: CatalogPlugin[]): Promise<void> => {
    setBusy(true)
    const done: string[] = []
    let error = ''
    for (const c of list) {
      const r = await invoke('plugins:installCatalog', { id: c.id, builtin: true })
      if (r.ok) done.push(c.name)
      else error = r.error ?? '설치하지 못했습니다.'
    }
    setBusy(false)
    void qc.invalidateQueries({ queryKey: ['local', 'plugins'] })
    setMsg(error || `${done.join(', ')}을(를) 설치했습니다. 왼쪽 메뉴 "확장 기능" 아래에 나타납니다.`)
  }

  // teamhub://plugins/install?id=… from the download site opens this confirmation.
  const installParam = params.get('install')
  useEffect(() => {
    if (!installParam || !catalog.data) return
    const c = catalog.data.data?.find((x) => x.id === installParam)
    if (c) askCatalog(c)
    else setMsg('다운로드 사이트의 확장 기능 목록에서 찾지 못했습니다.')
    setParams({}, { replace: true })
  }, [installParam, catalog.data, setParams])

  const confirm = async (): Promise<void> => {
    if (!pending) return
    setBusy(true)
    const r = pending.from.kind === 'catalog' ? await invoke('plugins:installCatalog', { id: pending.from.id }) : await invoke('plugins:installFile', { path: pending.from.path })
    setBusy(false)
    if (r.ok) {
      setMsg(`${pending.manifest.name} ${pending.manifest.version}을(를) 설치했습니다. 왼쪽 메뉴 "확장 기능" 아래에 나타납니다.`)
      setPending(null)
      void qc.invalidateQueries({ queryKey: ['local', 'plugins'] })
    } else setMsg(r.error ?? '설치하지 못했습니다.')
  }
  const remove = async (m: Pick<PluginManifest, 'id' | 'name'>): Promise<void> => {
    if (!confirmDialog(`${m.name}을(를) 삭제할까요? 이 PC에 저장된 확장 기능 데이터도 지워집니다.`)) return
    setBusy(true)
    try {
      await invoke('plugins:uninstall', { id: m.id })
      setMsg(`${m.name}을(를) 삭제했습니다. 필요하면 다시 설치할 수 있습니다.`)
    } catch (e) {
      setMsg(`삭제하지 못했습니다. ${e instanceof Error ? e.message : String(e)}`)
    }
    setBusy(false)
    void qc.invalidateQueries({ queryKey: ['local', 'plugins'] })
  }
  const fromFile = async (): Promise<void> => {
    const r = await invoke('plugins:pickFile')
    if (r.ok && r.manifest && r.path) setPending({ manifest: r.manifest, from: { kind: 'file', path: r.path } })
    else if (r.error) setMsg(r.error)
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="확장 기능"
        description="TeamHub에 기능을 더합니다. 확장 기능은 이 PC에만 설치되고, 격리된 화면에서 허락한 권한만 씁니다."
        actions={
          <>
            <Button size="sm" variant="outline" onClick={() => void fromFile()}>
              <FileUp /> 파일에서 설치
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void invoke('app:openExternal', { url: `${DOWNLOAD_SITE}plugins.html` })}>
              <ExternalLink /> 확장 기능 사이트
            </Button>
          </>
        }
      />
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-5">
        {msg && (
          <p className="text-sm text-primary" role="status">
            {msg}
          </p>
        )}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">기본으로 들어 있는 기능</h2>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card data-testid="builtin-ledger">
              <CardContent className="flex gap-3 p-4">
                <NamedIcon name="notebook-tabs" className="size-8 text-primary" />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-semibold">
                    관리대장 <span className="text-xs font-normal text-muted-foreground">{ledgerOff ? '삭제함 (왼쪽 메뉴에 없음)' : '설치 없이 바로 사용'}</span>
                  </p>
                  <p className="text-sm text-muted-foreground">엑셀처럼 쓰는 대장 관리. 개인용·팀용·지정자용 대장, 수식, 엑셀 가져오기·저장.</p>
                  <div className="flex items-center gap-2 pt-1">
                    {ledgerOff ? (
                      <Button size="sm" onClick={() => void updatePrefs({ hiddenMenus: hiddenMenus.filter((k) => k !== 'ledger') })} data-testid="ledger-restore">
                        <Download /> 다시 추가
                      </Button>
                    ) : (
                      <>
                        <Button size="sm" onClick={() => navigate('/ledger')}>
                          <Play /> 열기
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="ml-auto border-urgent/50 text-urgent hover:bg-urgent/10"
                          data-testid="ledger-remove"
                          onClick={() => {
                            if (confirmDialog('관리대장을 이 PC의 왼쪽 메뉴에서 삭제할까요? 만들어 둔 대장(개인용·팀용)은 지워지지 않으며, 여기서 [다시 추가]를 누르면 그대로 다시 쓸 수 있습니다.')) void updatePrefs({ hiddenMenus: [...hiddenMenus, 'ledger'] })
                          }}
                        >
                          <Trash2 /> 삭제
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">설치된 확장 기능</h2>
          {!mine.length && <EmptyState icon={Puzzle} title="설치된 확장 기능이 없습니다" description="아래 목록에서 설치하세요." />}
          <div className="grid gap-3 lg:grid-cols-2" data-testid="installed-plugins">
            {mine.map((p) => {
              const latest = catalog.data?.data?.find((c) => c.id === p.manifest.id)
              const update = latest && compareVersions(latest.version, p.manifest.version) > 0
              return (
                <Card key={p.manifest.id} data-testid="installed-plugin">
                  <CardContent className="flex gap-3 p-4">
                    <PluginIcon manifest={p.manifest} className="size-8 text-primary" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-semibold">
                        {p.manifest.name} <span className="text-xs font-normal text-muted-foreground">v{p.manifest.version} · {p.source === 'catalog' ? '사이트' : p.source === 'builtin' ? '기본 제공' : '파일'} · {format(p.installedAt, 'yyyy-MM-dd')}</span>
                      </p>
                      <p className="text-sm text-muted-foreground">{p.manifest.description}</p>
                      <div className="flex flex-wrap items-center gap-2 pt-1">
                        <Button size="sm" disabled={!p.enabled} onClick={() => navigate(`/plugins/${p.manifest.id}`)}>
                          <Play /> 열기
                        </Button>
                        {update && (
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => (latest.builtin ? void installNow([latest]) : askCatalog(latest))}>
                            <Download /> v{latest.version}로 업데이트
                          </Button>
                        )}
                        <Switch checked={p.enabled} onCheckedChange={(v) => void invoke('plugins:setEnabled', { id: p.manifest.id, enabled: v })} label="사용" />
                        <Button size="sm" variant="outline" className="ml-auto text-urgent" disabled={busy} data-testid="plugin-remove" onClick={() => void remove(p.manifest)}>
                          <Trash2 /> 삭제
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h2 className="text-sm font-semibold text-muted-foreground">확장 기능 모음</h2>
            <span className="text-xs text-muted-foreground">기본 제공은 인터넷 없이 바로 설치됩니다.</span>
            <span className="ml-auto" />
            <label className="flex items-center gap-1 text-xs text-muted-foreground">
              정렬
              <select className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground" value={sort} data-testid="catalog-sort" onChange={(e) => chooseSort(e.target.value as PluginSort)}>
                {(Object.keys(PLUGIN_SORTS) as PluginSort[]).map((s) => (
                  <option key={s} value={s}>
                    {PLUGIN_SORTS[s]}
                  </option>
                ))}
              </select>
            </label>
            {(() => {
              const rest = (catalog.data?.data ?? []).filter((c) => c.builtin && !have.has(c.id) && !MENU_PLUGINS[c.id])
              return rest.length > 1 ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => void installNow(rest)}>
                  <Download /> 기본 제공 모두 설치
                </Button>
              ) : null
            })()}
          </div>
          {catalog.isLoading && <Loader2 className="animate-spin" />}
          {catalog.data && !catalog.data.ok && <p className="text-sm text-muted-foreground">목록을 불러오지 못했습니다(인터넷 연결 필요). 폐쇄망에서는 받은 .thplugin 파일로 설치하세요. {catalog.data.error}</p>}
          <div className="grid gap-3 lg:grid-cols-2" data-testid="plugin-catalog">
            {gallery.map((c) => {
              const ins = have.get(c.id)
              const downloads = counts.data?.[c.id]
              return (
                <Card key={c.id} data-testid="catalog-plugin">
                  <CardContent className="flex gap-3 p-4">
                    <PluginIcon manifest={c} className="size-8 text-primary" />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-semibold">
                        {c.name} <span className="text-xs font-normal text-muted-foreground">v{c.version} · {c.author} · {c.builtin ? '기본 제공' : '다운로드 사이트'}</span>
                      </p>
                      {(downloads !== undefined || c.updated) && (
                        <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground" data-testid="catalog-stats">
                          {downloads !== undefined && (
                            <span className="inline-flex items-center gap-1">
                              <Download className="size-3" /> 다운로드 {downloads.toLocaleString('ko-KR')}회
                            </span>
                          )}
                          {c.updated && <span>{c.updated} 갱신</span>}
                        </p>
                      )}
                      <p className="text-sm text-muted-foreground">{c.description}</p>
                      {c.features && (
                        <ul className="list-inside list-disc text-xs text-muted-foreground">
                          {c.features.slice(0, 5).map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                      <div className="flex items-center gap-2 pt-1">
                        {ins ? (
                          <>
                            <span className="text-xs text-muted-foreground">설치됨 v{ins.manifest.version}</span>
                            <Button size="sm" variant="outline" className="text-urgent" disabled={busy} data-testid="catalog-remove" onClick={() => void remove(ins.manifest)}>
                              <Trash2 /> 삭제
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" disabled={busy} onClick={() => (c.builtin ? void installNow([c]) : askCatalog(c))}>
                            <Download /> {c.builtin ? '바로 설치' : '설치'}
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )
            })}
          </div>
        </section>
      </div>
      <Dialog
        open={!!pending}
        onClose={() => setPending(null)}
        title="확장 기능 설치"
        footer={
          <>
            <Button variant="outline" onClick={() => setPending(null)}>
              취소
            </Button>
            <Button disabled={busy} onClick={() => void confirm()}>
              {busy && <Loader2 className="animate-spin" />} 설치
            </Button>
          </>
        }
      >
        {pending && (
          <div className="space-y-3" data-testid="plugin-confirm">
            <div className="flex items-center gap-3">
              <PluginIcon manifest={pending.manifest} className="size-10 text-primary" />
              <div>
                <p className="font-semibold">
                  {pending.manifest.name} v{pending.manifest.version}
                </p>
                <p className="text-xs text-muted-foreground">{pending.manifest.author || '만든 사람 표시 없음'} · {pending.from.kind === 'catalog' ? '다운로드 사이트' : '파일'}</p>
              </div>
            </div>
            <p className="text-sm">{pending.manifest.description}</p>
            <div>
              <p className="mb-1 text-sm font-semibold">이 확장 기능이 쓰는 권한</p>
              <Permissions list={pending.manifest.permissions} />
            </div>
            <p className="text-xs text-muted-foreground">확장 기능은 인터넷·파일·다른 프로그램에 직접 접근할 수 없고, 위 권한 안에서만 TeamHub 기능을 씁니다. 믿을 수 있는 곳에서 받은 것만 설치하세요.</p>
          </div>
        )}
      </Dialog>
    </div>
  )
}
