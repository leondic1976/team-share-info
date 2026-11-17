import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { LedgerChangedPayload } from '@shared/schemas/ledger'
import { invoke } from '@renderer/lib/bridge'
import { realtime } from '@renderer/lib/realtime'
import { inDoNotDisturb } from '@renderer/app/prefs-store'

/** The menu count is refreshed at most this often while somebody keeps typing in a ledger. */
const REFRESH_MS = 8000

/**
 * 관리대장 alerts: a toast when a ledger is shared with me (new ledger, or I was added to
 * its audience), and the count on the 관리대장 menu of ledgers others changed since I last
 * opened them (`me.ledgerUnseen`).
 */
export function useLedgerAlerts(myId: string | undefined): void {
  const qc = useQueryClient()
  useEffect(() => {
    if (!myId) return
    let timer: ReturnType<typeof setTimeout> | null = null
    let last = 0
    const refresh = (now: boolean): void => {
      const run = (): void => {
        timer = null
        last = Date.now()
        void qc.invalidateQueries({ queryKey: ['me'] })
      }
      if (now || Date.now() - last > REFRESH_MS) {
        if (timer) clearTimeout(timer)
        run()
      } else if (!timer) timer = setTimeout(run, REFRESH_MS - (Date.now() - last))
    }
    const off = realtime.on('ledger.changed', (raw) => {
      const p = raw as LedgerChangedPayload
      if (p.byId === myId && !p.shared) return
      if (p.shared && p.byId !== myId && !inDoNotDisturb()) void invoke('notify:toast', { title: `관리대장 공유 · ${p.byName ?? ''}`, body: `“${p.name ?? ''}” 대장을 함께 쓰게 되었습니다.`, route: '/ledger' })
      // every save of an editor arrives here: the count does not need to follow each one at once
      refresh(!!p.shared || !!p.deleted || p.version === undefined)
    })
    const offRe = realtime.onReconnect(() => refresh(true))
    return () => {
      off()
      offRe()
      if (timer) clearTimeout(timer)
    }
  }, [myId, qc])
}
