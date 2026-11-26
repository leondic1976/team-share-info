import { create } from 'zustand'
import type { Hello } from '@shared/schemas/auth'
import { isOnline, useConn } from '@renderer/app/conn-store'
import { ApiError, request } from './api'
import { invoke } from './bridge'
import { queryClient } from './query-client'
import { realtime } from './realtime'

/**
 * Outbox (13.11): new things written for the server while the server PC is off - a message,
 * a post, a work request - are kept on this PC (sealed) and sent in the order they were
 * written as soon as the server answers again.
 *
 * Only *new* items go through here. Changing or deleting something that exists already
 * needs the server: two people changing the same item while apart would overwrite each
 * other without anyone noticing.
 *
 * Each item is sent with its id as X-Idempotency-Key, so an answer lost on the way does not
 * make the server do it twice.
 */
export interface OutboxEntry {
  id: string
  kind: string
  label: string
  method: 'POST' | 'PUT'
  path: string
  body: unknown
  state: 'waiting' | 'failed'
  error: string
  createdAt: number
}

interface OutboxStore {
  items: OutboxEntry[]
  /** short message for the top bar ("kept, will be sent", "3 sent") */
  flash: string
  sending: boolean
}

export const useOutbox = create<OutboxStore>(() => ({ items: [], flash: '', sending: false }))

let flashTimer: number | null = null
function flash(text: string): void {
  useOutbox.setState({ flash: text })
  if (flashTimer) window.clearTimeout(flashTimer)
  flashTimer = window.setTimeout(() => useOutbox.setState({ flash: '' }), 6000)
}

const owner = (): string | null => useConn.getState().memberId

export async function loadOutbox(): Promise<void> {
  const me = owner()
  if (!me) {
    useOutbox.setState({ items: [] })
    return
  }
  try {
    const rows = await invoke('local:outbox.list', { owner: me })
    const items: OutboxEntry[] = []
    for (const r of rows) {
      try {
        const b = JSON.parse(r.body) as { method: 'POST' | 'PUT'; path: string; body: unknown }
        items.push({ id: r.id, kind: r.kind, label: r.label, method: b.method, path: b.path, body: b.body, state: r.state, error: r.error, createdAt: r.createdAt })
      } catch {
        void invoke('local:outbox.remove', { id: r.id })
      }
    }
    useOutbox.setState({ items })
  } catch {
    // local DB busy: the next load shows them
  }
}

const serverKnowsKeys = (): boolean => !!queryClient.getQueryData<Hello>(['hello', useConn.getState().serverUrl])?.caps?.includes('idem')
const isNetwork = (e: unknown): boolean => e instanceof ApiError && (e.code === 'NETWORK' || e.status >= 500)

export interface SendSpec {
  /** what it is, for the pending views (e.g. 'chat.message') */
  kind: string
  /** one line shown in the outbox list */
  label: string
  method?: 'POST' | 'PUT'
  path: string
  /**
   * Kept and sent as it is, so the writer's confirmation of personal information (`piiAck`,
   * src/renderer/lib/pii.ts) goes with an item sent later. An item kept without it that the
   * server refuses is asked about when it is sent (src/renderer/lib/api.ts).
   */
  body: unknown
}

export type SendResult<T> = { queued: false; data: T } | { queued: true }

/**
 * Send to the server now; when it cannot be reached, keep it and send it later.
 * Server refusals (validation, permission) are thrown as usual.
 */
export async function sendOrQueue<T = unknown>(spec: SendSpec): Promise<SendResult<T>> {
  const id = crypto.randomUUID()
  const method = spec.method ?? 'POST'
  if (isOnline()) {
    try {
      const data = await request<T>(spec.path, { method, body: spec.body, headers: serverKnowsKeys() ? { 'X-Idempotency-Key': id } : undefined })
      return { queued: false, data }
    } catch (e) {
      if (!isNetwork(e)) throw e
    }
  }
  const me = owner()
  const kept = me ? await invoke('local:outbox.add', { id, owner: me, kind: spec.kind, label: spec.label.slice(0, 200), body: JSON.stringify({ method, path: spec.path, body: spec.body }) }).catch(() => false) : false
  if (!kept) throw new ApiError('OUTBOX', '서버에 연결되어 있지 않고 이 PC에 보관하지도 못했습니다. 서버에 연결된 뒤 다시 시도하세요.', 0)
  await loadOutbox()
  flash('서버에 연결되면 자동으로 보냅니다.')
  // a short network blip while "online": try again soon instead of waiting for a reconnect
  if (isOnline()) window.setTimeout(() => void flushOutbox(), 5000)
  return { queued: true }
}

let flushing = false
/** Send what is waiting, oldest first. Stops at the first sign that the server is gone again. */
export async function flushOutbox(): Promise<void> {
  if (flushing || !isOnline()) return
  if (!useOutbox.getState().items.some((i) => i.state === 'waiting')) return
  flushing = true
  useOutbox.setState({ sending: true })
  let sent = 0
  try {
    // asked fresh: also tells whether this server version understands the key
    const hello = await request<Hello>('/api/hello', { noAuth: true })
    const keyed = !!hello.caps?.includes('idem')
    for (const it of useOutbox.getState().items) {
      if (it.state !== 'waiting') continue
      try {
        await request(it.path, { method: it.method, body: it.body, headers: keyed ? { 'X-Idempotency-Key': it.id } : undefined })
        await invoke('local:outbox.remove', { id: it.id })
        sent++
      } catch (e) {
        if (isNetwork(e) || !isOnline()) break
        // refused by the server (no longer allowed, the board was removed, ...): kept for the writer to see
        await invoke('local:outbox.update', { id: it.id, state: 'failed', error: e instanceof Error ? e.message.slice(0, 500) : '보내지 못했습니다.' })
      }
    }
  } catch {
    // server gone again: the next reconnect continues
  } finally {
    flushing = false
    await loadOutbox()
    useOutbox.setState({ sending: false })
    if (sent) {
      void queryClient.invalidateQueries()
      const failed = useOutbox.getState().items.filter((i) => i.state === 'failed').length
      flash(failed ? `보관해 둔 ${sent}건을 보냈습니다. ${failed}건은 보내지 못했습니다.` : `보관해 둔 ${sent}건을 서버에 보냈습니다.`)
    } else if (useOutbox.getState().items.some((i) => i.state === 'failed')) flash('보내지 못한 것이 있습니다. 위쪽 연결 표시를 눌러 확인하세요.')
  }
}

export async function retryOutbox(id: string): Promise<void> {
  await invoke('local:outbox.update', { id, state: 'waiting', error: '' })
  await loadOutbox()
  void flushOutbox()
}

export async function discardOutbox(id: string): Promise<void> {
  await invoke('local:outbox.remove', { id })
  await loadOutbox()
}

realtime.onReconnect(() => void loadOutbox().then(flushOutbox))
