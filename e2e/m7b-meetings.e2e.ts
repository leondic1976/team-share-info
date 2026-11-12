import { describe, it, expect, afterAll } from 'vitest'
import type { ElectronApplication, Page } from 'playwright-core'
import { go, joinAndApprove, launch, runWizard, type Launched } from './helpers'

const PORT = '47905'
const FAKE = { TEAMHUB_FAKE_MEDIA: '1' }

async function windowWith(app: ElectronApplication, frag: string, timeout = 20000): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => w.url().includes(frag) && !w.isClosed()), { timeout, interval: 500 }).toBe(true)
  const w = app.windows().find((x) => x.url().includes(frag) && !x.isClosed())!
  await w.waitForLoadState('domcontentloaded')
  w.on('dialog', (d) => void d.accept())
  return w
}
const playing = (p: Page, testId: string): Promise<number> => p.evaluate((t) => Math.max(0, ...[...document.querySelectorAll<HTMLVideoElement>(`[data-testid="${t}"]`)].map((v) => v.videoWidth)), testId)

describe('M7-B meetings: 1:1 video call, screen sharing, chat (same PC, two profiles)', () => {
  let a: Launched
  let b: Launched
  let roomA: Page
  let roomB: Page
  let meetingId = ''
  afterAll(async () => {
    await b?.close()
    await a?.close()
  })

  it('setup', async () => {
    a = await launch({ profile: 'e2e-m7ba', env: FAKE })
    await runWizard(a.page, PORT)
    b = await launch({ profile: 'e2e-m7bb', env: FAKE })
    await joinAndApprove(a.page, b.page, PORT, '팀원B')
    for (const x of [a, b])
      await x.app.evaluate(({ app }) => {
        const g = globalThis as unknown as { __diag: { gone: unknown[]; lag: number } }
        g.__diag = { gone: [], lag: 0 }
        app.on('child-process-gone', (_e, d) => g.__diag.gone.push(d))
        app.on('render-process-gone', (_e, _w, d) => g.__diag.gone.push(d))
        let last = Date.now()
        setInterval(() => {
          const now = Date.now()
          g.__diag.lag = Math.max(g.__diag.lag, now - last - 100)
          last = now
        }, 100)
      })
  }, 90000)

  it('A starts a meeting with B; B gets an invite pop-up', async () => {
    const bId = await b.page.evaluate(async () => (await window.teamhub.invoke('conn:get', undefined as never)).memberId)
    meetingId = await a.page.evaluate(async (to) => {
      const c = await window.teamhub.invoke('conn:get', undefined as never)
      const r = await fetch(`${c.serverUrl}/api/meetings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.deviceId}.${c.deviceKey}`, 'X-Win-User': encodeURIComponent(c.winUser), 'X-Protocol': '1' },
        body: JSON.stringify({ title: '1:1 통화E2E', mode: 'video', scope: { type: 'members', groupIds: [], memberIds: [to] } })
      })
      const id = (await r.json()).data.id as string
      await window.teamhub.invoke('meeting:open', { id })
      return id
    }, bId)
    roomA = await windowWith(a.app, '/popup/meeting/')
    await roomA.getByTestId('meeting-lobby').waitFor()
    await roomA.getByRole('button', { name: '참가', exact: true }).click()
    await roomA.getByTestId('meeting-room').waitFor()
    // listed on A's meetings page
    await go(a.page, '/meetings')
    await expect.poll(() => a.page.getByTestId('live-meeting').count(), { timeout: 10000 }).toBe(1)

    const invite = await windowWith(b.app, '/popup/invite/')
    await expect.poll(() => invite.getByTestId('meeting-invite').textContent()).toContain('1:1 통화E2E')
    await invite.getByRole('button', { name: '참가' }).click()
    roomB = await windowWith(b.app, `/popup/meeting/${meetingId}`)
    await roomB.getByTestId('meeting-lobby').waitFor()
    await roomB.getByRole('button', { name: '참가', exact: true }).click()
    await roomB.getByTestId('meeting-room').waitFor()
  }, 60000)

  it('both sides receive each other’s video', async () => {
    await expect.poll(() => roomA.getByTestId('tile-peer').count(), { timeout: 20000 }).toBe(1)
    await expect.poll(() => roomB.getByTestId('tile-peer').count(), { timeout: 20000 }).toBe(1)
    const diag = (p: Page) =>
      p.evaluate(async () => {
        const r = (window as unknown as { __teamhubRoom?: { peers: Map<string, { pc: RTCPeerConnection; streams: Map<string, MediaStream> }>; local: MediaStream } }).__teamhubRoom
        if (!r) return 'no room'
        const peers = []
        for (const x of r.peers.values()) {
          const st: string[] = []
          ;(await x.pc.getStats()).forEach((s: { type: string; kind?: string; bytesSent?: number; bytesReceived?: number; framesDecoded?: number; framesEncoded?: number }) => {
            if (s.type === 'outbound-rtp') st.push(`out:${s.kind}:${s.bytesSent}:${s.framesEncoded ?? ''}`)
            if (s.type === 'inbound-rtp') st.push(`in:${s.kind}:${s.bytesReceived}:${s.framesDecoded ?? ''}`)
          })
          peers.push({
            c: x.pc.connectionState,
            i: `${x.pc.iceConnectionState}/${x.pc.iceGatheringState}`,
            s: x.pc.signalingState,
            cand: [...(await x.pc.getStats()).values()].filter((s: { type: string }) => s.type === 'local-candidate' || s.type === 'remote-candidate').map((s: { type: string; address?: string; protocol?: string }) => `${s.type[0]}:${s.address}:${s.protocol}`),
            tx: x.pc.getTransceivers().map((t) => `${t.mid}:${t.direction}:${t.currentDirection}:${t.sender.track?.readyState ?? 'none'}`),
            streams: [...x.streams.values()].map((m) => m.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted ? 'muted' : 'flow'}`)),
            st
          })
        }
        return JSON.stringify({ sig: (r as unknown as { stats: unknown }).stats, local: r.local.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.enabled}`), peers })
      })
    try {
      const t0 = Date.now()
      await expect.poll(() => playing(roomA, 'video-peer'), { timeout: 30000, interval: 250 }).toBeGreaterThan(0)
      const tA = Date.now() - t0
      await expect.poll(() => playing(roomB, 'video-peer'), { timeout: 30000, interval: 250 }).toBeGreaterThan(0)
      const crashes = (await b.app.evaluate(() => (globalThis as unknown as { __diag: { gone: unknown[] } }).__diag.gone.length)) + (await a.app.evaluate(() => (globalThis as unknown as { __diag: { gone: unknown[] } }).__diag.gone.length))
      console.log(`[e2e] video arrives: A ${tA} ms, B ${Date.now() - t0} ms after both tiles; child process crashes: ${crashes}`)
    } catch (e) {
      console.log('[diag A]', await diag(roomA))
      console.log('[diag B]', await diag(roomB))
      for (const [n, x] of [['A', a], ['B', b]] as const)
        console.log(`[diag main ${n}]`, JSON.stringify(await x.app.evaluate(({ BrowserWindow }) => ({ ...(globalThis as unknown as { __diag: object }).__diag, wins: BrowserWindow.getAllWindows().map((w) => w.webContents.getURL().replace(/^.*#/, '')) }))))
      throw e
    }
    expect(await roomB.getByTestId('tile-peer').getAttribute('data-name')).toBe('서버관리자')
  }, 60000)

  const framesFromPeer = (p: Page): Promise<number> =>
    p.evaluate(async () => {
      const r = (window as unknown as { __teamhubRoom?: { peers: Map<string, { pc: RTCPeerConnection }> } }).__teamhubRoom!
      let n = 0
      for (const x of r.peers.values()) (await x.pc.getStats()).forEach((s: { type: string; kind?: string; framesDecoded?: number }) => s.type === 'inbound-rtp' && s.kind === 'video' && (n += s.framesDecoded ?? 0))
      return n
    })
  const videoFlows = async (p: Page): Promise<boolean> => {
    const f0 = await framesFromPeer(p)
    await p.waitForTimeout(1500)
    return (await framesFromPeer(p)) > f0 + 5
  }

  it('B’s camera is lost (device ended): it comes back for A by itself', async () => {
    await roomB.evaluate(() => {
      const t = (window as unknown as { __teamhubRoom: { local: MediaStream } }).__teamhubRoom.local.getVideoTracks()[0]
      t.stop()
      t.dispatchEvent(new Event('ended')) // what Chromium fires when a device goes away
    })
    await expect.poll(() => roomB.evaluate(() => (window as unknown as { __teamhubRoom: { local: MediaStream } }).__teamhubRoom.local.getVideoTracks().map((t) => t.readyState).join()), { timeout: 15000 }).toBe('live')
    await expect.poll(() => videoFlows(roomA), { timeout: 30000, interval: 500 }).toBe(true)
  }, 60000)

  it('a rebuilt connection (reset signal) carries video again', async () => {
    const bId = (await b.page.evaluate(async () => (await window.teamhub.invoke('conn:get', undefined as never)).memberId))!
    await roomA.evaluate((id) => {
      const r = (window as unknown as { __teamhubRoom: { send(to: string, d: unknown): void; rebuild(id: string): void } }).__teamhubRoom
      r.send(id, { kind: 'reset' })
      r.rebuild(id)
    }, bId)
    await expect.poll(() => videoFlows(roomA), { timeout: 30000, interval: 500 }).toBe(true)
    await expect.poll(() => videoFlows(roomB), { timeout: 30000, interval: 500 }).toBe(true)
  }, 60000)

  it('A shares the screen; B sees it', async () => {
    await roomA.getByRole('button', { name: '화면 공유' }).click()
    await roomA.getByTestId('screen-picker').locator('button').first().waitFor({ timeout: 15000 })
    await roomA.getByTestId('screen-picker').locator('button').first().click()
    await expect.poll(() => playing(roomA, 'video-screen'), { timeout: 20000, interval: 1000 }).toBeGreaterThan(0)
    await expect.poll(() => playing(roomB, 'video-screen'), { timeout: 30000, interval: 1000 }).toBeGreaterThan(0)
    expect(await roomB.getByText('서버관리자 화면 공유 중').count()).toBe(1)
    await roomA.getByRole('button', { name: '공유 중지' }).click()
    await expect.poll(() => roomB.getByTestId('video-screen').count(), { timeout: 15000 }).toBe(0)
  }, 90000)

  it('meeting chat and mute state reach the other side', async () => {
    await roomA.getByRole('button', { name: '회의 대화' }).click()
    await roomA.getByLabel('회의 대화 입력').fill('자료 보이시나요?')
    await roomA.getByLabel('회의 대화 입력').press('Enter')
    await roomB.getByRole('button', { name: '회의 대화' }).click()
    await expect.poll(() => roomB.getByTestId('meeting-chat').textContent()).toContain('자료 보이시나요?')
    await roomB.getByRole('button', { name: '마이크 끄기' }).click()
    await roomA.getByRole('button', { name: '참가자' }).click()
    await expect.poll(() => roomA.getByTestId('tile-peer').locator('svg.text-red-400').count(), { timeout: 10000 }).toBe(1)
  })

  it('B leaves, A ends the meeting', async () => {
    await roomB.getByRole('button', { name: '나가기' }).click()
    await expect.poll(() => roomA.getByTestId('tile-peer').count(), { timeout: 15000 }).toBe(0)
    await roomA.getByRole('button', { name: '회의 끝내기' }).click()
    await roomA.getByTestId('meeting-ended').waitFor({ timeout: 10000 })
    await go(a.page, '/meetings')
    await expect.poll(() => a.page.getByTestId('live-meeting').count(), { timeout: 10000 }).toBe(0)
  }, 60000)
})
