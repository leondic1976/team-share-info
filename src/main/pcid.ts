import { net } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import log from 'electron-log/main'
import { PC_UID_RE } from '../shared/constants'
import { installIdFrom } from '../node/feedback'
import { pcName } from './netinfo'
import { userDataPath } from './paths'

/**
 * Identity of this installed PC, kept in the app data folder (not in the personal DB, which
 * can be exported to another PC):
 *  - uid: the unique value of the PC. Made once, soon after the first start, from the network
 *    card address (MAC), the office-network address and the internet address, mixed with
 *    random bytes and hashed. The addresses themselves are neither stored nor sent. The server
 *    uses it to recognise a PC that asks to join again (no second account), the feedback board
 *    to tell writers apart.
 *  - role: server PC or member PC. Decided at the first setup and never changed afterwards;
 *    using the PC the other way needs a fresh installation (app data removed).
 */
export type PcRole = 'server' | 'client'

interface PcIdentity {
  uid?: string
  /** Hash of the network card the uid was made on, to notice app data copied to another PC. */
  card?: string
  pcName?: string
  createdAt?: number
  role?: PcRole
  roleAt?: number
}

const FILE = (): string => userDataPath('pc-identity.json')
const VIRTUAL_RE = /(vethernet|virtualbox|vmware|hyper-v|wsl|docker|tap|tun|vpn|zerotier|tailscale|bluetooth)/i
let cache: PcIdentity | undefined

function read(): PcIdentity {
  if (cache) return cache
  cache = {}
  try {
    if (existsSync(FILE())) cache = JSON.parse(readFileSync(FILE(), 'utf8')) as PcIdentity
  } catch (e) {
    log.error('[pcid] cannot read pc-identity.json', e)
  }
  return cache
}

function write(next: PcIdentity): void {
  cache = next
  writeFileSync(FILE(), JSON.stringify(next, null, 2))
}

const cardHash = (mac: string): string => createHash('sha256').update(`teamhub-card:${mac.toLowerCase()}`).digest('hex').slice(0, 16)

/** Network cards and office-network addresses of this PC, real adapters before virtual ones. */
function cards(): { mac: string; lanIp: string }[] {
  const all: { mac: string; lanIp: string; virtual: boolean }[] = []
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal || a.family !== 'IPv4' || a.mac === '00:00:00:00:00:00') continue
      all.push({ mac: a.mac, lanIp: a.address, virtual: VIRTUAL_RE.test(name) || a.address.startsWith('169.254.') })
    }
  }
  return all.sort((x, y) => Number(x.virtual) - Number(y.virtual))
}

/** This PC's address as the internet sees it; '' when it cannot be asked (closed network). */
async function wanIp(): Promise<string> {
  if (process.env.TEAMHUB_E2E) return ''
  try {
    const r = await net.fetch('https://api.ipify.org', { signal: AbortSignal.timeout(4000), cache: 'no-store' })
    const t = r.ok ? (await r.text()).trim() : ''
    return /^[0-9a-f.:]{3,45}$/i.test(t) ? t : ''
  } catch {
    return ''
  }
}

/** The stored value still belongs to this PC (same network card, or at least the same PC name). */
function own(id: PcIdentity): boolean {
  if (!id.uid || !PC_UID_RE.test(id.uid)) return false
  if (!id.card) return true
  const mine = cards().map((c) => cardHash(c.mac))
  // no card at all right now (cable out, adapter off) says nothing about a copy
  return mine.length === 0 || mine.includes(id.card) || id.pcName === pcName()
}

/** The unique value if it was made already. */
export function pcUid(): string | null {
  const id = read()
  return own(id) ? id.uid! : null
}

let making: Promise<string> | null = null
/** The unique value of this PC; made now if this is the first time. */
export function ensurePcUid(): Promise<string> {
  const have = pcUid()
  if (have) return Promise.resolve(have)
  making ??= (async () => {
    const before = read()
    if (before.uid) log.warn('[pcid] app data belongs to another PC (network card and PC name differ): a new unique value is made')
    const card = cards()[0] ?? { mac: '', lanIp: '' }
    const uid = installIdFrom({ ...card, wanIp: await wanIp() })
    write({ ...read(), uid, card: card.mac ? cardHash(card.mac) : undefined, pcName: pcName(), createdAt: Date.now() })
    log.info(`[pcid] unique value of this PC: ${uid}`)
    return uid
  })().finally(() => (making = null))
  return making
}

export function lockedRole(): PcRole | null {
  return read().role ?? null
}

/** Fix the role of this PC. The first call decides; later calls with the other role are refused (false). */
export function lockRole(role: PcRole): boolean {
  const id = read()
  if (id.role) return id.role === role
  write({ ...id, role, roleAt: Date.now() })
  log.info(`[pcid] this PC is a ${role === 'server' ? 'server' : 'member'} PC from now on`)
  return true
}

export const roleRefusal = (wanted: PcRole): string =>
  wanted === 'server'
    ? '이 PC는 일반용(팀원) PC로 설치되어 서버로 쓸 수 없습니다. 서버로 쓰려면 프로그램과 프로그램 자료를 지우고 새로 설치해야 합니다.'
    : '이 PC는 서버용 PC로 설치되어 일반용(팀원) PC로 쓸 수 없습니다. 팀원 PC로 쓰려면 프로그램과 프로그램 자료를 지우고 새로 설치해야 합니다.'
