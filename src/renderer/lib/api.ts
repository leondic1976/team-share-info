import { PROTOCOL_VERSION } from '@shared/constants'
import { isPiiRefusal, piiMessage } from '@shared/pii'
import { useConn } from '@renderer/app/conn-store'

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    /** `error.details` of the answer, when the server sent any */
    readonly details?: unknown
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
  let json: { data?: T; error?: { code: string; message: string; details?: unknown } } = {}
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
    const details = json.error?.details
    // the server found personal information that was not confirmed here (e.g. its rules are newer,
    // or the item was kept by an older version): ask now, the way the PC asks before sending
    if (code === 'PII_UNCONFIRMED' && isPiiRefusal(details) && !hasPiiAck(opts)) {
      if (!window.confirm(piiMessage(details.found, '받는 사람 모두가 보게 되며,'))) throw new ApiError('PII_CANCELLED', '보내지 않았습니다.', 0)
      return request<T>(path, withPiiAck(opts))
    }
    throw new ApiError(code, message, res.status, details)
  }
  return json.data as T
}

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function hasPiiAck(opts: RequestOpts): boolean {
  return (plainObject(opts.body) && opts.body.piiAck === true) || opts.query?.piiAck === 1
}
/** The same request with the writer's confirmation: in the JSON body, else in the query. */
function withPiiAck(opts: RequestOpts): RequestOpts {
  return plainObject(opts.body) ? { ...opts, body: { ...opts.body, piiAck: true } } : { ...opts, query: { ...opts.query, piiAck: 1 } }
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
