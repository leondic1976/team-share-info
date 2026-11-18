import { PROTOCOL_VERSION } from '@shared/constants'
import { useConn } from '@renderer/app/conn-store'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

/** Admin PIN is kept in memory only, for the current app session. */
let adminPin = ''
export function setAdminPin(pin: string): void {
  adminPin = pin
}
export function hasAdminPin(): boolean {
  return !!adminPin
}

interface RequestOpts {
  method?: string
  body?: unknown
  rawBody?: BodyInit
  headers?: Record<string, string>
  query?: Record<string, string | number | boolean | undefined | null>
  signal?: AbortSignal
  baseUrl?: string
  noAuth?: boolean
}

export function buildUrl(path: string, query?: RequestOpts['query'], baseUrl?: string): string {
  const base = baseUrl ?? useConn.getState().serverUrl
  if (!base) throw new ApiError('NO_SERVER', '서버가 설정되지 않았습니다.', 0)
  const u = new URL(path, base)
  if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v))
  return u.toString()
}

export function authHeaders(): Record<string, string> {
  const c = useConn.getState()
  const h: Record<string, string> = { 'X-Protocol': String(PROTOCOL_VERSION), 'X-App-Version': c.appVersion }
  if (c.deviceId && c.deviceKey) h.Authorization = `Bearer ${c.deviceId}.${c.deviceKey}`
  if (c.winUser) h['X-Win-User'] = encodeURIComponent(c.winUser)
  if (c.pcUid) h['X-PC-Uid'] = c.pcUid
  if (adminPin) h['X-Admin-Pin'] = adminPin
  return h
}

export async function request<T>(path: string, opts: RequestOpts = {}): Promise<T> {
  const headers: Record<string, string> = { ...(opts.noAuth ? {} : authHeaders()), ...opts.headers }
  let body: BodyInit | undefined = opts.rawBody
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(opts.body)
  }
  let res: Response
  try {
    res = await fetch(buildUrl(path, opts.query, opts.baseUrl), { method: opts.method ?? 'GET', headers, body, signal: opts.signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new ApiError('NETWORK', '서버에 연결할 수 없습니다.', 0)
  }
  const text = await res.text()
  let json: { data?: T; error?: { code: string; message: string } } = {}
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    // non-JSON
  }
  if (!res.ok) {
    const code = json.error?.code ?? 'HTTP_' + res.status
    const message = json.error?.message ?? `요청이 실패했습니다 (${res.status})`
    if (code === 'UPDATE_REQUIRED') useConn.getState().setState('update-required')
    if (code === 'DEVICE_REVOKED' || code === 'MEMBER_SUSPENDED') useConn.getState().setState('rejected', message)
    throw new ApiError(code, message, res.status)
  }
  return json.data as T
}

export const api = {
  get: <T>(path: string, query?: RequestOpts['query']) => request<T>(path, { query }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' })
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message
  if (e instanceof Error) return e.message
  return String(e)
}
