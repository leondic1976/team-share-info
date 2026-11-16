import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Download, ExternalLink, FileUp, Loader2, Play, Puzzle, ShieldCheck, Trash2 } from 'lucide-react'
import { DOWNLOAD_SITE } from '@shared/constants'
import { compareVersions } from '@shared/semver'
import { PLUGIN_PERMISSIONS, type CatalogPlugin, type PluginManifest, type PluginPermission } from '@shared/schemas/plugins'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Switch } from '@renderer/components/ui/switch'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Dialog, confirmDialog } from '@renderer/components/Dialog'
import { EmptyState } from '@renderer/components/EmptyState'
import { invoke, onMain } from '@renderer/lib/bridge'

interface Pending {
  manifest: Pick<PluginManifest, 'id' | 'name' | 'version' | 'description' | 'author' | 'icon' | 'permissions'>
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
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">설치된 확장 기능</h2>
          {!installed.data?.length && <EmptyState icon={Puzzle} title="설치된 확장 기능이 없습니다" description="아래 목록에서 설치하세요." />}
          <div className="grid gap-3 lg:grid-cols-2" data-testid="installed-plugins">
            {installed.data?.map((p) => {
              const latest = catalog.data?.data?.find((c) => c.id === p.manifest.id)
              const update = latest && compareVersions(latest.version, p.manifest.version) > 0
              return (
                <Card key={p.manifest.id} data-testid="installed-plugin">
                  <CardContent className="flex gap-3 p-4">
                    <span className="text-3xl">{p.manifest.icon}</span>
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
                        <Button
                          size="sm"
                          variant="ghost"
                          className="ml-auto"
                          onClick={() => confirmDialog(`${p.manifest.name}을(를) 지울까요? 이 PC에 저장된 확장 기능 데이터도 지워집니다.`) && void invoke('plugins:uninstall', { id: p.manifest.id })}
                        >
                          <Trash2 /> 제거
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
            {(() => {
              const rest = (catalog.data?.data ?? []).filter((c) => c.builtin && !have.has(c.id))
              return rest.length > 1 ? (
                <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={() => void installNow(rest)}>
                  <Download /> 기본 제공 모두 설치
                </Button>
              ) : null
            })()}
          </div>
          {catalog.isLoading && <Loader2 className="animate-spin" />}
          {catalog.data && !catalog.data.ok && <p className="text-sm text-muted-foreground">목록을 불러오지 못했습니다(인터넷 연결 필요). 폐쇄망에서는 받은 .thplugin 파일로 설치하세요. {catalog.data.error}</p>}
          <div className="grid gap-3 lg:grid-cols-2" data-testid="plugin-catalog">
            {catalog.data?.data?.map((c) => {
              const ins = have.get(c.id)
              return (
                <Card key={c.id} data-testid="catalog-plugin">
                  <CardContent className="flex gap-3 p-4">
                    <span className="text-3xl">{c.icon}</span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-semibold">
                        {c.name} <span className="text-xs font-normal text-muted-foreground">v{c.version} · {c.author} · {c.builtin ? '기본 제공' : '다운로드 사이트'}</span>
                      </p>
                      <p className="text-sm text-muted-foreground">{c.description}</p>
                      {c.features && (
                        <ul className="list-inside list-disc text-xs text-muted-foreground">
                          {c.features.slice(0, 5).map((f) => (
                            <li key={f}>{f}</li>
                          ))}
                        </ul>
                      )}
                      <div className="pt-1">
                        {ins ? (
                          <span className="text-xs text-muted-foreground">설치됨 v{ins.manifest.version}</span>
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
              <span className="text-4xl">{pending.manifest.icon}</span>
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
