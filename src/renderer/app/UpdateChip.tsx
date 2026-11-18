import { useEffect, useState } from 'react'
import { Download, RotateCcw } from 'lucide-react'
import type { UpdateState } from '@shared/ipc'
import { invoke, onMain } from '@renderer/lib/bridge'

/**
 * Small blue box right of the search box, shown only while there is something to say about a
 * new version: found, downloading, ready (click to install), or installing by itself in a
 * few seconds (found right after the program started).
 */
export function UpdateChip(): React.JSX.Element | null {
  const [upd, setUpd] = useState<UpdateState | null>(null)
  const [, tick] = useState(0)
  useEffect(() => {
    void invoke('update:getState').then(setUpd)
    return onMain('update:state', setUpd)
  }, [])
  const auto = upd?.status === 'downloaded' ? upd.autoInstallAt : undefined
  useEffect(() => {
    if (!auto) return
    const t = setInterval(() => tick((n) => n + 1), 500)
    return () => clearInterval(t)
  }, [auto])
  if (!upd || (upd.status !== 'available' && upd.status !== 'downloading' && upd.status !== 'downloaded')) return null

  const v = upd.version ? `v${upd.version}` : '새 버전'
  const left = auto ? Math.max(0, Math.ceil((auto - Date.now()) / 1000)) : 0
  const box = 'th-update-chip no-drag flex h-8 shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-semibold whitespace-nowrap text-primary-foreground'

  if (upd.status === 'downloaded' && auto)
    return (
      <div className={box} role="status" data-testid="update-chip">
        {/* key: the text slides in again whenever the message changes */}
        <span key="auto" className="flex items-center gap-1.5">
          <RotateCcw className="size-3.5 animate-spin [animation-duration:2.5s]" aria-hidden />
          {v} 자동 업데이트 {left}초 전
        </span>
        <button className="cursor-pointer rounded bg-white/20 px-1.5 py-0.5 hover:bg-white/30" onClick={() => void invoke('update:install')}>
          지금
        </button>
        <button className="cursor-pointer rounded px-1 py-0.5 underline-offset-2 hover:underline" onClick={() => void invoke('update:postpone').then(setUpd)}>
          나중에
        </button>
      </div>
    )
  if (upd.status === 'downloaded')
    return (
      <button className={`${box} cursor-pointer hover:brightness-110`} onClick={() => void invoke('update:install')} title="누르면 설치하고 다시 시작합니다" data-testid="update-chip">
        <span key="ready" className="flex items-center gap-1.5">
          <Download className="size-3.5 animate-bounce" aria-hidden />새 버전 {v} 준비됨 · 눌러서 업데이트
        </span>
      </button>
    )
  if (upd.status === 'downloading')
    return (
      <div className={box} role="status" data-testid="update-chip">
        <span key="down" className="flex items-center gap-1.5">
          <Download className="size-3.5 animate-pulse" aria-hidden />새 버전 {v} 받는 중 {upd.percent ?? 0}%
        </span>
      </div>
    )
  return (
    <button className={`${box} cursor-pointer hover:brightness-110`} onClick={() => void invoke('update:download').then(setUpd)} title="누르면 내려받습니다" data-testid="update-chip">
      <span key="avail" className="flex items-center gap-1.5">
        <Download className="size-3.5 animate-bounce" aria-hidden />새 버전 {v} 나왔어요 · 눌러서 받기
      </span>
    </button>
  )
}
