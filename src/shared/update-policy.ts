import { compareVersions, SEMVER_RE } from './semver'

/**
 * Which update a PC may take (지시 125-①). A member PC that is newer than the server it is
 * connected to can break things (the server DB and API belong to the server's version), so a
 * member PC never installs a version newer than the server PC runs. The server PC itself, and a
 * PC with no server, take the newest version as before.
 *
 * Pure: the updater (src/main/updater.ts) probes the feeds and the server, this decides.
 */

export type UpdateSource = 'web' | 'lan'

/** One feed's answer: unreachable, or reachable with the version it offers (null = nothing offered). */
export interface FeedProbe {
  source: UpdateSource
  feed: string
  reachable: boolean
  version: string | null
}

/**
 * A newer version exists but this PC waits for the server PC.
 *  - basis 'server': the version the server reports (or reported at the last connection)
 *  - basis 'lan': the server's version is unknown; the newest version registered on the server PC
 */
export interface HeldBack {
  version: string
  limit: string
  basis: 'server' | 'lan'
}

export type UpdatePick =
  | { kind: 'offer'; feed: string; source: UpdateSource; version: string; heldBack?: HeldBack }
  | { kind: 'none'; source?: UpdateSource; heldBack?: HeldBack }
  | { kind: 'unreachable' }

export interface UpdatePolicyInput {
  /** version installed on this PC */
  current: string
  /** feeds in order of preference (a tie goes to the earlier one) */
  probes: FeedProbe[]
  /** this PC is connected (or asking to join) as a member PC, not the server PC */
  memberPc: boolean
  /** version the connected server runs; null when unknown (offline, no answer) */
  serverVersion: string | null
}

const valid = (v: string | null | undefined): v is string => !!v && SEMVER_RE.test(v.trim())

/** The highest version a member PC may install, and what it is based on; null = no limit. */
export function updateLimit(i: Pick<UpdatePolicyInput, 'probes' | 'memberPc' | 'serverVersion'>): { limit: string; basis: HeldBack['basis'] } | null {
  if (!i.memberPc) return null
  if (valid(i.serverVersion)) return { limit: i.serverVersion.trim(), basis: 'server' }
  // server version unknown: at least never go past what the server PC itself offers
  const lan = i.probes.find((p) => p.source === 'lan' && p.reachable && valid(p.version))
  return lan?.version ? { limit: lan.version, basis: 'lan' } : null
}

/** Choose what to offer: the newest version among the reachable feeds that the limit allows. */
export function pickUpdate(i: UpdatePolicyInput): UpdatePick {
  const reachable = i.probes.filter((p) => p.reachable)
  if (!reachable.length) return { kind: 'unreachable' }
  const cap = updateLimit(i)
  let best: FeedProbe | null = null
  let top: string | null = null
  for (const p of reachable) {
    if (!valid(p.version)) continue
    if (!top || compareVersions(p.version, top) > 0) top = p.version
    if (cap && compareVersions(p.version, cap.limit) > 0) continue
    if (!best || compareVersions(p.version, best.version!) > 0) best = p
  }
  const heldBack: HeldBack | undefined =
    cap && top && compareVersions(top, cap.limit) > 0 && compareVersions(top, i.current) > 0 ? { version: top, limit: cap.limit, basis: cap.basis } : undefined
  const extra = heldBack ? { heldBack } : {}
  if (best && compareVersions(best.version!, i.current) > 0) return { kind: 'offer', feed: best.feed, source: best.source, version: best.version!, ...extra }
  return { kind: 'none', source: best?.source ?? reachable[0]!.source, ...extra }
}

/** Korean text for a held-back update (settings card, blocking screen). */
export function heldBackText(h: HeldBack): string {
  return h.basis === 'server'
    ? `새 버전(${h.version})이 있지만 서버 PC가 아직 ${h.limit}입니다. 서버 PC가 먼저 업데이트하면 자동으로 받습니다.`
    : `새 버전(${h.version})이 있지만 서버 PC에는 아직 ${h.limit}까지만 있습니다. 서버 PC가 먼저 업데이트하면 자동으로 받습니다.`
}

/** Shown on the server PC while a newer version waits there: member PCs wait for this PC. */
export const SERVER_PC_UPDATE_NOTE = '팀원 PC들은 서버 PC보다 새 버전을 설치하지 않습니다. 이 PC를 업데이트하면 팀원 PC들도 다음 확인 때 자동으로 받습니다.'
