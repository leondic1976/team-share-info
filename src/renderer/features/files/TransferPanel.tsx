import { useEffect, useState } from 'react'
import { ArrowDown, ArrowUp, X, ChevronDown, ChevronUp, Check, AlertCircle, Pause } from 'lucide-react'
import type { TransferItem } from '@shared/ipc'
import { invoke, onMain } from '@renderer/lib/bridge'
import { formatSize } from '@renderer/components/Attachments'
import { Button } from '@renderer/components/ui/button'
import { cn } from '@renderer/lib/utils'
import { useQueryClient } from '@tanstack/react-query'
import { realtime } from '@renderer/lib/realtime'

/** Floating panel with upload/download progress (bottom right). */
export function TransferPanel(): React.JSX.Element | null {
  const qc = useQueryClient()
  const [items, setItems] = useState<TransferItem[]>([])
  const [open, setOpen] = useState(true)
  useEffect(() => {
    void invoke('transfer:list').then(setItems)
    const off = onMain('transfer:update', (list) => {
      setItems((prev) => {
        // Refresh file lists when an upload finishes.
        if (list.some((i) => i.status === 'done' && prev.find((p) => p.id === i.id)?.status !== 'done')) void qc.invalidateQueries({ queryKey: ['files'] })
        return list
      })
    })
    const offRe = realtime.onReconnect(() => void invoke('transfer:resume'))
    return () => {
      off()
      offRe()
    }
  }, [qc])
  if (!items.length) return null
  const active = items.filter((i) => i.status === 'running' || i.status === 'queued').length
  return (
    <div className="fixed right-4 bottom-16 z-40 w-96 rounded-lg border border-border bg-card shadow-xl" data-testid="transfer-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-sm font-semibold">
        전송 {active > 0 ? `${active}개 진행 중` : '완료'}
        <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={open ? '접기' : '펼치기'} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown /> : <ChevronUp />}
        </Button>
        <Button size="icon-sm" variant="ghost" aria-label="완료 항목 지우기" onClick={() => void invoke('transfer:clearDone')}>
          <X />
        </Button>
      </div>
      {open && (
        <div className="max-h-64 overflow-y-auto">
          {items
            .slice()
            .reverse()
            .map((i) => {
              const pct = i.size ? Math.floor((i.done / i.size) * 100) : i.status === 'done' ? 100 : 0
              return (
                <div key={i.id} className="border-b border-border px-3 py-2 text-xs last:border-0" data-testid="transfer-item" data-status={i.status}>
                  <div className="flex items-center gap-1.5">
                    {i.direction === 'up' ? <ArrowUp className="size-3.5 text-primary" /> : <ArrowDown className="size-3.5 text-success" />}
                    <span className="truncate font-medium">{i.name}</span>
                    <span className="ml-auto shrink-0 text-muted-foreground">
                      {i.status === 'done' ? (
                        <Check className="size-3.5 text-success" />
                      ) : i.status === 'error' ? (
                        <AlertCircle className="size-3.5 text-urgent" />
                      ) : i.status === 'paused' ? (
                        <Pause className="size-3.5 text-important" />
                      ) : i.status === 'cancelled' ? (
                        '취소됨'
                      ) : (
                        `${pct}%`
                      )}
                    </span>
                    {(i.status === 'running' || i.status === 'queued' || i.status === 'paused') && (
                      <button className="cursor-pointer" aria-label={`${i.name} 전송 취소`} onClick={() => void invoke('transfer:cancel', { id: i.id })}>
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded bg-muted">
                    <div className={cn('h-full', i.status === 'error' ? 'bg-urgent' : 'bg-primary')} style={{ width: `${pct}%` }} />
                  </div>
                  <div className="mt-0.5 text-muted-foreground">
                    {formatSize(i.done)} / {formatSize(i.size)}
                    {i.newVersion ? ' · 새 버전으로 등록' : ''}
                    {i.error ? ` · ${i.error}` : ''}
                  </div>
                </div>
              )
            })}
        </div>
      )}
    </div>
  )
}
