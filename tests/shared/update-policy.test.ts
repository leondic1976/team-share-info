import { describe, it, expect } from 'vitest'
import { heldBackText, pickUpdate, updateLimit, type FeedProbe } from '../../src/shared/update-policy'

const WEB = 'https://site/updates/'
const LAN = 'http://10.0.0.5:47800/updates/'
const web = (version: string | null, reachable = true): FeedProbe => ({ source: 'web', feed: WEB, reachable, version })
const lan = (version: string | null, reachable = true): FeedProbe => ({ source: 'lan', feed: LAN, reachable, version })

describe('update policy (지시 125-①)', () => {
  it('member PC: a web version newer than the server is held back', () => {
    const p = pickUpdate({ current: '1.11.0', probes: [web('1.12.0'), lan(null)], memberPc: true, serverVersion: '1.11.2' })
    expect(p).toEqual({ kind: 'none', source: 'web', heldBack: { version: '1.12.0', limit: '1.11.2', basis: 'server' } })
    if (p.kind === 'none') expect(heldBackText(p.heldBack!)).toBe('새 버전(1.12.0)이 있지만 서버 PC가 아직 1.11.2입니다. 서버 PC가 먼저 업데이트하면 자동으로 받습니다.')
  })

  it('member PC: the server PC feed still offers what the server allows while the site is ahead', () => {
    const p = pickUpdate({ current: '1.10.0', probes: [web('1.12.0'), lan('1.11.2')], memberPc: true, serverVersion: '1.11.2' })
    expect(p).toEqual({ kind: 'offer', feed: LAN, source: 'lan', version: '1.11.2', heldBack: { version: '1.12.0', limit: '1.11.2', basis: 'server' } })
  })

  it('member PC: once the server runs the new version it is taken (the site wins a tie)', () => {
    const p = pickUpdate({ current: '1.11.2', probes: [web('1.12.0'), lan('1.12.0')], memberPc: true, serverVersion: '1.12.0' })
    expect(p).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
  })

  it('member PC: a release registered on the server PC ahead of the server itself is held back too', () => {
    const p = pickUpdate({ current: '1.11.2', probes: [web(null), lan('1.13.0')], memberPc: true, serverVersion: '1.11.2' })
    expect(p).toMatchObject({ kind: 'none', heldBack: { version: '1.13.0', limit: '1.11.2' } })
  })

  it('member PC already at the server version: nothing to do, nothing held when nothing is newer', () => {
    expect(pickUpdate({ current: '1.12.0', probes: [web('1.12.0'), lan(null)], memberPc: true, serverVersion: '1.12.0' })).toEqual({ kind: 'none', source: 'web' })
    // installed by hand past the server: no downgrade, no message
    expect(pickUpdate({ current: '1.13.0', probes: [web('1.13.0')], memberPc: true, serverVersion: '1.12.0' })).toEqual({ kind: 'none', source: 'web' })
  })

  it('server version unknown: never past the server PC feed when it answers', () => {
    const p = pickUpdate({ current: '1.10.0', probes: [web('1.12.0'), lan('1.11.2')], memberPc: true, serverVersion: null })
    expect(p).toEqual({ kind: 'offer', feed: LAN, source: 'lan', version: '1.11.2', heldBack: { version: '1.12.0', limit: '1.11.2', basis: 'lan' } })
    expect(heldBackText({ version: '1.12.0', limit: '1.11.2', basis: 'lan' })).toContain('서버 PC에는 아직 1.11.2까지만')
  })

  it('server version unknown and the server PC feed silent or empty: as before (newest of the site)', () => {
    expect(pickUpdate({ current: '1.10.0', probes: [web('1.12.0'), lan(null, false)], memberPc: true, serverVersion: null })).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
    expect(pickUpdate({ current: '1.10.0', probes: [web('1.12.0'), lan(null)], memberPc: true, serverVersion: null })).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
    expect(pickUpdate({ current: '1.10.0', probes: [web('1.12.0')], memberPc: true, serverVersion: 'garbage' })).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
  })

  it('server PC: takes the newest version, never limited', () => {
    expect(pickUpdate({ current: '1.11.2', probes: [web('1.12.0'), lan('1.11.2')], memberPc: false, serverVersion: '1.11.2' })).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
    expect(updateLimit({ probes: [lan('1.11.2')], memberPc: false, serverVersion: '1.11.2' })).toBeNull()
  })

  it('no server configured: the site as before', () => {
    expect(pickUpdate({ current: '1.11.2', probes: [web('1.12.0')], memberPc: false, serverVersion: null })).toEqual({ kind: 'offer', feed: WEB, source: 'web', version: '1.12.0' })
    expect(pickUpdate({ current: '1.12.0', probes: [web('1.12.0')], memberPc: false, serverVersion: null })).toEqual({ kind: 'none', source: 'web' })
  })

  it('no feed answers: unreachable; a site that answers without a release: none', () => {
    expect(pickUpdate({ current: '1.0.0', probes: [web(null, false), lan(null, false)], memberPc: true, serverVersion: '1.0.0' })).toEqual({ kind: 'unreachable' })
    expect(pickUpdate({ current: '1.0.0', probes: [web(null, false), lan(null)], memberPc: true, serverVersion: '1.0.0' })).toEqual({ kind: 'none', source: 'lan' })
  })
})
