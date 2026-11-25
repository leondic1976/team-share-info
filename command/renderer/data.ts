import { useCallback, useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { CmdMaterial, CmdNotice, CommandState, Drill, Scenario, ScenarioBrief } from '../shared/types'
import type { CommandDrillPayload } from '../shared/events'
import { useHost } from './host'

export const QK = {
  state: ['command', 'state'] as const,
  notices: ['command', 'notices'] as const,
  materials: ['command', 'materials'] as const,
  scenarios: ['command', 'scenarios'] as const,
  scenario: (id: string) => ['command', 'scenario', id] as const,
  drill: (id: string) => ['command', 'drill', id] as const,
  role: (id: string) => ['command', 'role', id] as const
}

/** Keeps the module's data fresh: realtime events and reconnects refresh what is shown. */
export function useCommandLive(): void {
  const host = useHost()
  const qc = useQueryClient()
  useEffect(() => {
    const offs = [
      host.on('command.changed', () => void qc.invalidateQueries({ queryKey: ['command'] })),
      host.on('command.drill', (raw) => {
        const p = raw as CommandDrillPayload
        void qc.invalidateQueries({ queryKey: QK.drill(p.drillId) })
        void qc.invalidateQueries({ queryKey: QK.state })
      }),
      host.onReconnect(() => void qc.invalidateQueries({ queryKey: ['command'] }))
    ]
    return () => offs.forEach((o) => o())
  }, [host, qc])
}

export function useCommandState() {
  const host = useHost()
  const online = host.useOnline()
  return useQuery({ queryKey: QK.state, queryFn: () => host.api.get<CommandState>('/api/command'), enabled: online, placeholderData: (p) => p })
}
export function useNotices() {
  const host = useHost()
  return useQuery({ queryKey: QK.notices, queryFn: () => host.api.get<CmdNotice[]>('/api/command/notices'), enabled: host.useOnline(), placeholderData: (p) => p })
}
export function useMaterials() {
  const host = useHost()
  return useQuery({ queryKey: QK.materials, queryFn: () => host.api.get<CmdMaterial[]>('/api/command/materials'), enabled: host.useOnline(), placeholderData: (p) => p })
}
export function useScenarios(enabled: boolean) {
  const host = useHost()
  const online = host.useOnline()
  return useQuery({ queryKey: QK.scenarios, queryFn: () => host.api.get<ScenarioBrief[]>('/api/command/scenarios'), enabled: enabled && online })
}
export function useScenario(id: string | null) {
  const host = useHost()
  const online = host.useOnline()
  return useQuery({ queryKey: QK.scenario(id ?? ''), queryFn: () => host.api.get<Scenario>(`/api/command/scenarios/${id}`), enabled: !!id && online })
}
export function useDrill(id: string | null) {
  const host = useHost()
  const online = host.useOnline()
  return useQuery({ queryKey: QK.drill(id ?? ''), queryFn: () => host.api.get<Drill>(`/api/command/drills/${id}`), enabled: !!id && online, placeholderData: (p) => p })
}
export function useRoleDuty(id: string | null) {
  const host = useHost()
  return useQuery({ queryKey: QK.role(id ?? ''), queryFn: () => host.api.get<{ id: string; name: string; dutyHtml: string; path: string }>(`/api/command/roles/${id}`), enabled: !!id })
}

/** Runs a change against the server: busy while it runs, the error as text, data refreshed after. */
export function useAct(): { run: <T>(fn: () => Promise<T>, after?: (r: T) => void) => Promise<boolean>; busy: boolean; err: string; setErr: (s: string) => void } {
  const host = useHost()
  const qc = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, after?: (r: T) => void): Promise<boolean> => {
      setBusy(true)
      setErr('')
      try {
        const r = await fn()
        after?.(r)
        await qc.invalidateQueries({ queryKey: ['command'] })
        return true
      } catch (e) {
        setErr(host.errorMessage(e))
        return false
      } finally {
        setBusy(false)
      }
    },
    [host, qc]
  )
  return { run, busy, err, setErr }
}

/** The server's clock, ticking (deadlines and the drill clock follow the server PC). */
export function useServerNow(serverNow: number | undefined, everyMs = 1000): number {
  const [offset, setOffset] = useState(0)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (serverNow) setOffset(serverNow - Date.now())
  }, [serverNow])
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), everyMs)
    return () => window.clearInterval(t)
  }, [everyMs])
  return now + offset
}
