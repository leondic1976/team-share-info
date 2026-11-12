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
      p.evaluate(() => {
        const r = (window as unknown as { __teamhubRoom?: { peers: Map<string, { pc: RTCPeerConnection; streams: Map<string, MediaStream> }>; local: MediaStream } }).__teamhubRoom
        if (!r) return 'no room'
        return JSON.stringify({ local: r.local.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.enabled}`), peers: [...r.peers.values()].map((x) => ({ c: x.pc.connectionState, i: x.pc.iceConnectionState, s: x.pc.signalingState, streams: [...x.streams.values()].map((m) => m.getTracks().map((t) => `${t.kind}:${t.readyState}:${t.muted}`)) })) })
      })
    await new Promise((r) => setTimeout(r, 8000))
    console.log('[diag A]', await diag(roomA))
    console.log('[diag B]', await diag(roomB))
    await expect.poll(() => playing(roomA, 'video-peer'), { timeout: 30000, interval: 1000 }).toBeGreaterThan(0)
    await expect.poll(() => playing(roomB, 'video-peer'), { timeout: 30000, interval: 1000 }).toBeGreaterThan(0)
    expect(await roomB.getByTestId('tile-peer').getAttribute('data-name')).toBe('서버관리자')
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
