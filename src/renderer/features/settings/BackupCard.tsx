import { useCallback, useEffect, useState } from 'react'
import { DatabaseBackup, Download, FolderOpen, History, Loader2, Lock, Trash2, Upload, X } from 'lucide-react'
import type { LocalBackupInfo, LocalSnapshot } from '@shared/ipc'
import { LOCAL_BACKUP_KEEP_MAX, LOCAL_BACKUP_KEEP_MIN } from '@shared/constants'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Dialog } from '@renderer/components/Dialog'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'
import { useSession } from '@renderer/app/session-store'

const fmt = (n: number): string => (n < 1024 ** 2 ? `${Math.max(1, Math.round(n / 1024))} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`)
const p2 = (n: number): string => String(n).padStart(2, '0')
const when = (at: number): string => {
  const d = new Date(at)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const KIND: Record<LocalSnapshot['kind'], string> = { auto: '자동', manual: '직접', safety: '복구 직전' }

type Ask = { kind: 'restore'; snap: LocalSnapshot } | { kind: 'delete'; snap: LocalSnapshot } | { kind: 'import' }

/**
 * Settings: 내 자료 백업 · 복구 - the personal data of this PC (local DB). A snapshot is made
 * once a day by itself; any snapshot can be restored. Exporting to / importing from a file
 * of the user's choice is here too.
 */
export function BackupCard(): React.JSX.Element {
  const app = useSession((s) => s.app)
  const [info, setInfo] = useState<LocalBackupInfo | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [keep, setKeep] = useState('')
  const [ask, setAsk] = useState<Ask | null>(null)
  const [askErr, setAskErr] = useState('')

  const load = useCallback(async () => {
    const i = await invoke('local:backup.info')
    setInfo(i)
    setKeep(String(i.keep))
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setMsg(null)
    try {
      await fn()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : '하지 못했습니다.' })
    } finally {
      setBusy(false)
    }
  }
  const backupNow = (): Promise<void> =>
    run(async () => {
      const r = await invoke('local:backup.now')
      setMsg(r.ok ? { ok: true, text: '지금 자료를 백업했습니다.' } : { ok: false, text: r.error ?? '백업하지 못했습니다.' })
      await load()
    })
  const saveKeep = (): Promise<void> =>
    run(async () => {
      const n = Number(keep)
      if (!Number.isInteger(n) || n < LOCAL_BACKUP_KEEP_MIN || n > LOCAL_BACKUP_KEEP_MAX) {
        setMsg({ ok: false, text: `보관 개수는 ${LOCAL_BACKUP_KEEP_MIN}~${LOCAL_BACKUP_KEEP_MAX}개입니다.` })
        return
      }
      await invoke('local:backup.setKeep', { keep: n })
      setMsg({ ok: true, text: `자동 백업을 최근 ${n}개까지 보관합니다.` })
      await load()
    })
  const exportFile = (): Promise<void> =>
    run(async () => {
      const r = await invoke('local:export')
      if (r.ok) setMsg({ ok: true, text: `내보냈습니다: ${r.path}` })
      else if (r.error) setMsg({ ok: false, text: `내보내지 못했습니다: ${r.error}` })
    })
  const openAsk = (a: Ask): void => {
    setAsk(a)
    setAskErr('')
  }
  /** Carry out what the window asks; a refusal is shown in the window itself. */
  const confirmAsk = async (): Promise<void> => {
    if (!ask || busy) return
    setBusy(true)
    setAskErr('')
    try {
      if (ask.kind === 'delete') {
        const r = await invoke('local:backup.delete', { id: ask.snap.id })
        if (!r.ok) return setAskErr(r.error ?? '지우지 못했습니다.')
        setMsg({ ok: true, text: `${when(ask.snap.at)} 백업을 지웠습니다.` })
        setAsk(null)
        await load()
        return
      }
      if (ask.kind === 'restore') {
        const r = await invoke('local:backup.restore', { id: ask.snap.id })
        if (!r.ok) return setAskErr(r.error ?? '복구하지 못했습니다.')
      } else {
        const r = await invoke('local:import')
        if (!r.ok) {
          // (no error: the file window was closed without choosing)
          if (r.error) setAskErr(r.error)
          else setAsk(null)
          return
        }
      }
      setAsk(null)
      setMsg({ ok: true, text: '프로그램을 다시 시작해 복구합니다…' })
    } catch (e) {
      setAskErr(e instanceof Error ? e.message : '하지 못했습니다.')
    } finally {
      setBusy(false)
    }
  }

  const snaps = info?.snapshots ?? []
  return (
    <Card data-testid="backup-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-1.5">
          <Lock className="size-4 text-personal" /> 내 자료 백업 · 복구
        </CardTitle>
        <span className="text-xs text-muted-foreground">하루 한 번 자동 백업</span>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          개인 일정·다이어리·메모·노트·알람 등 개인 자료는 이 PC에만 저장되며 서버로 보내지 않습니다. 하루에 한 번 자동으로 백업해 두므로, 잘못 지웠거나 자료가 이상해졌을 때 백업한 때의 상태로 되돌릴 수 있습니다. 팀 자료(공지·자료실·대화 등)는 서버에 있고 여기서 바뀌지
          않습니다.
        </p>
        <div>
          <div className="text-xs text-muted-foreground">개인 자료 파일</div>
          <div className="selectable rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="local-db-path">
            {app?.localDbPath}
          </div>
        </div>
        {info && (
          <div>
            <div className="text-xs text-muted-foreground">백업 보관 폴더</div>
            <div className="selectable rounded-md bg-muted px-3 py-2 font-mono text-xs break-all" data-testid="backup-dir">
              {info.dir}
            </div>
            <p className="mt-1 text-xs text-muted-foreground" data-testid="backup-status">
              {info.lastAt ? `마지막 백업 ${when(info.lastAt)}` : '아직 백업이 없습니다'} · 백업 {snaps.length}개 · 사용량 {fmt(info.totalBytes)}
            </p>
          </div>
        )}
        {info?.note && (
          <p className="rounded-md bg-urgent/10 px-3 py-2 text-xs text-urgent" role="alert" data-testid="backup-note">
            자동 백업을 하지 못했습니다. {info.note}
          </p>
        )}
        {info?.restore && (
          <div className={cn('flex items-start gap-2 rounded-md px-3 py-2 text-xs', info.restore.ok ? 'bg-success/10 text-success' : 'bg-urgent/10 text-urgent')} data-testid="backup-restore-result">
            <span className="flex-1">{info.restore.message}</span>
            <button className="cursor-pointer" aria-label="알림 닫기" onClick={() => void invoke('local:backup.dismiss').then(load)}>
              <X className="size-3.5" />
            </button>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy} onClick={() => void backupNow()} data-testid="backup-now">
            {busy ? <Loader2 className="animate-spin" /> : <DatabaseBackup />} 지금 백업
          </Button>
          <Button variant="outline" onClick={() => void invoke('local:backup.openFolder')}>
            <FolderOpen /> 폴더 열기
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => void exportFile()}>
            <Download /> 파일로 내보내기
          </Button>
          <Button variant="outline" disabled={busy} onClick={() => openAsk({ kind: 'import' })}>
            <Upload /> 파일에서 가져오기
          </Button>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium">백업 목록</div>
          {snaps.length ? (
            <ul className="max-h-64 divide-y divide-border overflow-y-auto rounded-md border border-border text-sm" data-testid="backup-rows">
              {snaps.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5" data-testid={`backup-row-${s.kind}`}>
                  <span className="tabular-nums">{when(s.at)}</span>
                  <Badge variant={s.kind === 'auto' ? 'muted' : s.kind === 'manual' ? 'default' : 'important'}>{KIND[s.kind]}</Badge>
                  <span className="text-xs text-muted-foreground">{fmt(s.bytes)}</span>
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" disabled={busy} onClick={() => openAsk({ kind: 'restore', snap: s })}>
                      <History /> 이 백업으로 복구
                    </Button>
                    <Button size="sm" variant="ghost" className="text-urgent" disabled={busy} onClick={() => openAsk({ kind: 'delete', snap: s })}>
                      <Trash2 /> 지우기
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-md border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">아직 백업이 없습니다. 프로그램을 켜 두면 하루 안에 첫 백업이 만들어집니다. 지금 만들려면 &quot;지금 백업&quot;을 누르세요.</p>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <label className="space-y-1">
            <span className="block text-xs text-muted-foreground">
              자동 백업 보관 개수 ({LOCAL_BACKUP_KEEP_MIN}~{LOCAL_BACKUP_KEEP_MAX}개)
            </span>
            <Input aria-label="자동 백업 보관 개수" type="number" min={LOCAL_BACKUP_KEEP_MIN} max={LOCAL_BACKUP_KEEP_MAX} className="w-24" value={keep} onChange={(e) => setKeep(e.target.value)} />
          </label>
          <Button variant="outline" disabled={busy} onClick={() => void saveKeep()}>
            개수 바꾸기
          </Button>
        </div>

        {msg && (
          <p className={cn('text-xs', msg.ok ? 'text-success' : 'text-urgent')} data-testid="backup-msg">
            {msg.text}
          </p>
        )}

        <div className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground" role="note">
          <b className="text-foreground">알아 둘 점</b>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            <li>자동 백업은 지난 백업 뒤로 자료가 바뀌었을 때만 만들고, 정한 개수를 넘으면 오래된 것부터 지웁니다. &quot;지금 백업&quot;으로 직접 만든 것은 지울 때까지 남고, 복구 직전에 만든 것은 최근 3개가 남습니다.</li>
            <li>백업에 들어가지 않는 것: 서버 접속 정보(기기 키·기억한 서버 - 새 PC에서는 관리자에게 다시 승인받는 것이 안전합니다), 내 파일의 파일 자체(내 PC의 파일이며 태그·색인만 들어갑니다), 설치한 확장 기능(다시 설치할 수 있습니다).</li>
            <li>백업 파일을 다른 PC로 가져가 복구하면 개인 자료(다이어리·메모·노트·개인 일정·알람 등)는 그대로 돌아옵니다. 서버가 꺼져 있을 때 보려고 보관해 둔 팀 자료 사본은 옮겨지지 않고 서버에서 다시 받습니다.</li>
            <li>백업은 같은 드라이브에 있으므로 디스크 고장에는 대비하지 못합니다. 중요한 자료는 &quot;파일로 내보내기&quot;로 다른 곳에도 보관하세요.</li>
          </ul>
        </div>
      </CardContent>

      <Dialog
        open={!!ask}
        onClose={() => !busy && setAsk(null)}
        title={ask?.kind === 'delete' ? '백업 지우기' : ask?.kind === 'import' ? '파일에서 가져오기' : '이 백업으로 복구'}
        footer={
          <>
            <Button variant="ghost" disabled={busy} onClick={() => setAsk(null)}>
              취소
            </Button>
            <Button variant={ask?.kind === 'delete' ? 'destructive' : 'default'} disabled={busy} onClick={() => void confirmAsk()} data-testid="backup-ask-ok">
              {busy && <Loader2 className="animate-spin" />}
              {ask?.kind === 'delete' ? '지우기' : ask?.kind === 'import' ? '파일 고르기' : '복구하고 다시 시작'}
            </Button>
          </>
        }
      >
        {ask && (
          <div className="space-y-3 text-sm" data-testid="backup-ask">
            {ask.kind === 'delete' ? (
              <p>
                <b>{when(ask.snap.at)}</b> 백업({KIND[ask.snap.kind]}, {fmt(ask.snap.bytes)})을 지웁니다. 지운 백업은 되돌릴 수 없습니다. 지금 쓰는 자료에는 영향이 없습니다.
              </p>
            ) : (
              <>
                <p>
                  {ask.kind === 'restore' ? (
                    <>
                      개인 자료를 <b>{when(ask.snap.at)}</b> 백업의 상태로 되돌립니다.
                    </>
                  ) : (
                    <>내보내 둔 파일(.db)을 골라 개인 자료를 그 파일의 내용으로 바꿉니다.</>
                  )}
                </p>
                <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                  <li>먼저 지금 자료를 따로 백업합니다(백업 목록의 &quot;복구 직전&quot;). 복구한 뒤 마음이 바뀌면 그 백업으로 다시 되돌릴 수 있습니다.</li>
                  <li>그다음 프로그램이 닫혔다가 고른 자료로 다시 시작됩니다. 작성 중인 글은 먼저 저장하세요.</li>
                  <li>{ask.kind === 'restore' ? '그 백업 뒤에' : '그 파일을 만든 뒤에'} 쓴 개인 자료는 화면에서 사라집니다(복구 직전 백업에는 남아 있습니다).</li>
                  <li>서버의 자료(공지·자료실·대화 등)와 서버 접속은 바뀌지 않습니다.</li>
                  <li>파일이 손상되었거나 복구에 실패하면 지금 자료를 그대로 씁니다.</li>
                </ul>
              </>
            )}
            {askErr && (
              <p className="text-urgent" role="alert">
                {askErr}
              </p>
            )}
          </div>
        )}
      </Dialog>
    </Card>
  )
}
