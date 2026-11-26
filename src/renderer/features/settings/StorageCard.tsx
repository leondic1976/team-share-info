import { useCallback, useEffect, useState } from 'react'
import { FolderInput, HardDrive, Loader2, RotateCcw, X } from 'lucide-react'
import type { StorageCheck, StorageInfo, StorageProgress } from '@shared/ipc'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Dialog } from '@renderer/components/Dialog'
import { invoke, onMain } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'

const fmt = (n: number): string => (n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)

const PHASE: Record<StorageProgress['phase'], string> = { stop: '서버를 잠시 멈추는 중…', copy: '복사하는 중…', verify: '복사한 자료를 확인하는 중…', start: '새 폴더에서 서버를 켜는 중…', cleanup: '이전 폴더를 정리하는 중…' }

/** Any failure of the bridge itself (main busy, a closed window) as a sentence, never a blank card. */
const errText = (e: unknown): string => `처리하지 못했습니다. 잠시 뒤 다시 해 보세요. (${e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)})`

function Progress({ p }: { p: StorageProgress | null }): React.JSX.Element {
  return (
    <div className="space-y-1 text-xs" data-testid="storage-progress" role="status">
      <div className="flex items-center gap-1.5">
        <Loader2 className="size-3.5 animate-spin" />
        {p ? PHASE[p.phase] : '준비하는 중…'}
        {p?.phase === 'copy' && p.totalBytes > 0 && <span className="text-muted-foreground">{` ${fmt(p.doneBytes)} / ${fmt(p.totalBytes)}`}</span>}
      </div>
      {p?.phase === 'copy' && p.totalBytes > 0 && (
        <div className="h-1.5 overflow-hidden rounded bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.min(100, (p.doneBytes / p.totalBytes) * 100)}%` }} />
        </div>
      )}
    </div>
  )
}

/**
 * 저장 위치 (6.20). `local`: personal data folder (settings, restarts the app).
 * `server`: the server's data folder (admin, server PC only, moved while the server pauses).
 * A move under way is known to main, so a card opened in the middle of one shows it too.
 */
export function StorageCard({ kind }: { kind: 'local' | 'server' }): React.JSX.Element | null {
  const [info, setInfo] = useState<StorageInfo | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [target, setTarget] = useState<{ to: string; check: StorageCheck } | null>(null)
  const [busy, setBusy] = useState(false)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<StorageProgress | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const load = useCallback(async (): Promise<StorageInfo | null> => {
    try {
      const i = await invoke('storage:info')
      setInfo(i)
      setLoadErr('')
      return i
    } catch (e) {
      setLoadErr(errText(e))
      return null
    }
  }, [])
  useEffect(() => {
    void load()
    return onMain('storage:progress', setProgress)
  }, [load])
  // a move started elsewhere (or before this screen was opened): follow it until it is over
  const elsewhere = !busy && !!info?.busy
  useEffect(() => {
    if (!elsewhere) return
    const t = setInterval(() => void load(), 1000)
    return () => clearInterval(t)
  }, [elsewhere, load])

  if (!info) {
    if (!loadErr) return null
    return (
      <Card data-testid={`storage-card-${kind}`}>
        <CardHeader>
          <CardTitle>{kind === 'local' ? '내 자료 저장 위치' : '서버 자료 저장 위치'}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-urgent" data-testid="storage-msg">
            {loadErr}
          </p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            <RotateCcw /> 다시 불러오기
          </Button>
        </CardContent>
      </Card>
    )
  }
  const cur = kind === 'local' ? info.local : info.server
  if (!cur) return null
  const locked = busy || checking || !!info.busy

  const choose = async (pick: () => Promise<string | null> | string | null): Promise<void> => {
    if (locked) return
    setMsg(null)
    setChecking(true)
    try {
      const to = await pick()
      if (!to) return // cancelled
      const check = await invoke(kind === 'local' ? 'storage:checkLocal' : 'storage:checkServer', { to })
      setTarget({ to, check })
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
    } finally {
      setChecking(false)
    }
  }
  const run = async (mode: 'move' | 'use'): Promise<void> => {
    if (!target || busy) return
    setBusy(true)
    setProgress(null)
    try {
      if (kind === 'local') {
        const r = await invoke('storage:changeLocal', { to: target.to, mode })
        setTarget(null)
        if (!r.ok) {
          setMsg({ ok: false, text: r.error ?? '바꾸지 못했습니다.' })
          setBusy(false)
        } else setMsg({ ok: true, text: '프로그램을 다시 시작해 자료를 옮깁니다…' })
        return
      }
      const r = await invoke('storage:moveServer', { to: target.to })
      setMsg(r.ok ? { ok: true, text: `서버 자료를 옮겼습니다: ${target.to}${r.warning ? ` (${r.warning})` : ''}` } : { ok: false, text: r.error ?? '옮기지 못했습니다.' })
      void invoke('storage:clearLastServer').catch(() => undefined)
      setTarget(null)
      setProgress(null)
      setBusy(false)
      void load()
    } catch (e) {
      setMsg({ ok: false, text: errText(e) })
      setTarget(null)
      setBusy(false)
      void load()
    }
  }

  const c = target?.check
  const title = kind === 'local' ? '내 자료 저장 위치' : '서버 자료 저장 위치'
  const lastNote = kind === 'local' ? info.last : msg ? null : info.lastServer
  return (
    <Card data-testid={`storage-card-${kind}`}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          {kind === 'local'
            ? '이 PC에만 저장되는 개인 자료(일정·다이어리·메모·노트·알람·확장 기능 자료·내 PC 백업 등)를 둘 폴더입니다. 새로 설치하면 D 드라이브(D:\\TeamHub\\Windows 계정)에 두고, D 드라이브가 없으면 프로그램 자료 폴더에 둡니다. 바꾸면 프로그램을 다시 시작하면서 지금 자료를 모두 새 폴더로 복사하고 검사한 뒤, 문제가 없을 때만 이전 폴더의 자료를 지웁니다.'
            : '공지·자료실 파일·대화·백업 등 팀이 함께 쓰는 자료를 둘 폴더입니다. 옮기는 동안 서버가 잠시 멈추고 팀원 연결이 끊겼다가 자동으로 다시 연결됩니다.'}
        </p>
        <div className="selectable rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="storage-dir">
          {cur.dir}
        </div>
        <p className="text-xs text-muted-foreground">
          사용량 {fmt(cur.bytes)}
          {kind === 'local' && info.local.isDefault && ' · 기본 위치'}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={locked} onClick={() => void choose(() => invoke('storage:pick', { kind }))} data-testid="storage-change">
            {checking ? <Loader2 className="animate-spin" /> : <FolderInput />} 폴더 바꾸기…
          </Button>
          {kind === 'local' && info.local.driveDir && (
            <Button variant="outline" disabled={locked} onClick={() => void choose(() => info.local.driveDir)} data-testid="storage-to-d">
              <HardDrive /> D 드라이브로 옮기기 (권장)
            </Button>
          )}
          {kind === 'local' && !info.local.isDefault && (
            <Button variant="ghost" disabled={locked} onClick={() => void choose(() => info.local.defaultDir)}>
              <RotateCcw /> 기본 위치로
            </Button>
          )}
        </div>
        {lastNote && (
          <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs', lastNote.ok ? 'bg-success/10 text-success' : 'bg-urgent/10 text-urgent')} data-testid="storage-last">
            <span className="flex-1 break-all">{lastNote.message}</span>
            <button
              className="cursor-pointer"
              aria-label="알림 닫기"
              onClick={() =>
                void invoke(kind === 'local' ? 'storage:clearLast' : 'storage:clearLastServer')
                  .then(load)
                  .catch(() => undefined)
              }
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {(busy || info.busy?.kind === kind) && !target && <Progress p={busy ? progress : (info.busy?.progress ?? null)} />}
        {elsewhere && info.busy?.kind !== kind && <p className="text-xs text-muted-foreground">{info.busy?.kind === 'server' ? '서버 자료를 옮기는 중입니다. 끝난 뒤에 바꿀 수 있습니다.' : '내 자료를 옮기려고 프로그램을 다시 시작하는 중입니다.'}</p>}
        {msg && (
          <p className={cn('text-xs break-all', msg.ok ? 'text-success' : 'text-urgent')} data-testid="storage-msg">
            {msg.text}
          </p>
        )}
      </CardContent>

      <Dialog
        open={!!target}
        onClose={() => !busy && setTarget(null)}
        title={title}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setTarget(null)}>
              {c?.ok ? '취소' : '닫기'}
            </Button>
            {c?.ok && !c.hasData && (
              <Button disabled={busy} onClick={() => void run('move')} data-testid="storage-confirm">
                {busy && <Loader2 className="animate-spin" />} {kind === 'local' ? '옮기고 다시 시작' : '옮기기'}
              </Button>
            )}
            {c?.ok && c.hasData && kind === 'local' && (
              <Button disabled={busy} onClick={() => void run('use')} data-testid="storage-use">
                그 폴더의 자료 쓰기
              </Button>
            )}
          </>
        }
      >
        {target && (
          <div className="space-y-3 text-sm" data-testid="storage-dialog">
            <div>
              <div className="text-xs text-muted-foreground">새 위치</div>
              <div className="selectable font-mono text-xs break-all">{target.to}</div>
            </div>
            {!c?.ok && (
              <p className="text-urgent" data-testid="storage-check-error">
                {c?.error ?? '그 폴더로는 옮길 수 없습니다.'}
              </p>
            )}
            {c?.ok && !c.hasData && (
              <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                <li>
                  옮길 자료 {fmt(c.needBytes)}
                  {c.freeBytes !== null && ` · 새 위치의 빈 공간 ${fmt(c.freeBytes)}`}
                </li>
                <li>새 폴더에 복사한 뒤 내용을 확인하고, 문제가 없을 때만 이전 폴더의 자료를 지웁니다. 실패하면 이전 위치를 그대로 씁니다.</li>
                {kind === 'local' ? (
                  <li>프로그램이 닫혔다가 다시 시작됩니다. 작성 중인 글은 먼저 저장하세요. 옮기는 동안 작은 안내 창이 뜨면 닫지 말고 기다리세요.</li>
                ) : (
                  <li>옮기는 동안(자료 양에 따라 몇 초~몇 분) 팀원은 서버에 연결할 수 없습니다. 끝날 때까지 프로그램을 끄지 마세요.</li>
                )}
              </ul>
            )}
            {c?.ok && c.hasData && (
              <p className="text-muted-foreground">
                그 폴더에 이미 TeamHub 자료가 있습니다. <b>그 폴더의 자료 쓰기</b>를 누르면 그 자료로 바꿔 씁니다(지금 자료는 지금 폴더에 그대로 남습니다). 지금 자료를 옮기려면 빈 폴더를 고르세요.
              </p>
            )}
            {busy && kind === 'server' && <Progress p={progress} />}
          </div>
        )}
      </Dialog>
    </Card>
  )
}
