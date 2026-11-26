import { useNavigate } from 'react-router-dom'
import { format, formatDistanceToNow } from 'date-fns'
import { ko } from 'date-fns/locale'
import { AlertTriangle, DatabaseBackup, HardDrive, Settings } from 'lucide-react'
import type { BackupHealth } from '@shared/schemas/settings'
import { Button } from '@renderer/components/ui/button'

/** The drive or share a path starts with, for the warning text ("D:", "\\nas\share"). */
function driveOf(p: string): string {
  const unc = /^\\\\[^\\]+\\[^\\]+/.exec(p)
  if (unc) return unc[0]
  const d = /^[a-z]:/i.exec(p)
  return d ? d[0].toUpperCase() : p
}

/**
 * Warnings about the server backups (관리 → 백업·복구 and 서버 상태): on the same drive as the
 * server data, failed last time, or no successful backup for more than 2 days.
 */
export function BackupHealthNotice({ health, dataDir, showOpen }: { health: BackupHealth; dataDir?: string; showOpen?: boolean }): React.JSX.Element | null {
  const navigate = useNavigate()
  const h = health
  if (!h.sameDrive && !h.failed && !h.stale) return null
  const toSettings = (
    <Button size="sm" variant="outline" onClick={() => navigate('/admin/settings', { state: { focus: 'backup' } })}>
      <Settings /> 백업 위치 바꾸기
    </Button>
  )
  return (
    <div className="space-y-2" data-testid="backup-health">
      {(h.failed || h.stale) && (
        <div className="flex items-start gap-2 rounded-md border border-urgent/40 bg-urgent/10 px-3 py-2 text-sm" role="alert" data-testid="backup-warn-failed">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-urgent" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold text-urgent">
              {h.failed ? '마지막 백업이 실패했습니다' : h.lastAt ? `마지막으로 성공한 백업이 ${formatDistanceToNow(h.lastAt, { locale: ko })} 전입니다` : '아직 성공한 백업이 없습니다'}
            </p>
            {h.failed && (
              <p className="selectable break-all">
                {h.lastErrorAt ? `${format(h.lastErrorAt, 'yyyy-MM-dd HH:mm')} · ` : ''}오류: {h.lastError}
              </p>
            )}
            <p className="text-muted-foreground">
              {h.failed
                ? '백업 위치로 정한 드라이브·USB·NAS가 연결되어 있고 쓸 수 있는지 확인한 뒤 지금 백업을 눌러 보세요. 위치가 없어졌다면 백업 위치를 바꾸세요.'
                : '자동 백업은 매일 정한 시각에 서버 PC가 켜져 있을 때 합니다. 지금 백업을 누르고, 서버 PC를 꺼 두는 날이 많다면 백업 시각을 켜져 있는 시간으로 바꾸세요.'}
              {h.failed && h.lastAt ? ` 마지막으로 성공한 백업: ${format(h.lastAt, 'yyyy-MM-dd HH:mm')}.` : ''}
            </p>
            {/* "백업 위치 바꾸기" once: the same-drive warning below has it too */}
            {(showOpen || (h.failed && !h.sameDrive)) && (
              <div className="flex gap-2 pt-0.5">
                {showOpen && (
                  <Button size="sm" variant="outline" onClick={() => navigate('/admin/backup')}>
                    <DatabaseBackup /> 백업·복구 열기
                  </Button>
                )}
                {h.failed && !h.sameDrive && toSettings}
              </div>
            )}
          </div>
        </div>
      )}
      {h.sameDrive && (
        <div className="flex items-start gap-2 rounded-md border border-important/40 bg-important/10 px-3 py-2 text-sm" role="alert" data-testid="backup-warn-same-drive">
          <HardDrive className="mt-0.5 size-4 shrink-0 text-important" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="font-semibold text-important">백업이 서버 자료와 같은 드라이브에 있습니다</p>
            <p>
              {h.isDefault
                ? '백업 위치를 정하지 않아 서버 자료 폴더 안에 백업하고 있습니다.'
                : `백업 위치(${driveOf(h.root)})가 서버 자료${dataDir ? `(${driveOf(dataDir)})` : ''}와 같은 드라이브입니다.`}{' '}
              이 드라이브가 고장 나면 서버 자료와 백업을 함께 잃습니다.
            </p>
            <p className="text-muted-foreground">조직·운영 설정 → 백업의 백업 위치를 다른 드라이브, NAS(공유 폴더) 또는 USB 드라이브로 정하세요.</p>
            <div className="pt-0.5">{toSettings}</div>
          </div>
        </div>
      )}
    </div>
  )
}
