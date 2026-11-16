/**
 * Settings → 배경화면 (100 built-in designs, own pictures, readability guard) and
 * one-click install of the plugins shipped with the app.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from 'playwright-core'
import { go, launch, runWizard, type Launched } from './helpers'

const PORT = '47914'

/** 64×64 BMP, left half black and right half white: the harshest picture for the guard. */
function harshPicture(file: string): void {
  const w = 64
  const h = 64
  const row = Buffer.alloc(w * 3)
  for (let x = w / 2; x < w; x++) row.fill(255, x * 3, x * 3 + 3)
  const head = Buffer.alloc(54)
  head.write('BM')
  head.writeUInt32LE(54 + row.length * h, 2)
  head.writeUInt32LE(54, 10)
  head.writeUInt32LE(40, 14)
  head.writeInt32LE(w, 18)
  head.writeInt32LE(h, 22)
  head.writeUInt16LE(1, 26)
  head.writeUInt16LE(24, 28)
  head.writeUInt32LE(row.length * h, 34)
  writeFileSync(file, Buffer.concat([head, ...Array.from({ length: h }, () => row)]))
}

const layer = (p: Page): Promise<{ veil: number; hasClass: boolean } | null> =>
  p.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-testid=wallpaper]')
    return el ? { veil: Number(el.dataset.veil), hasClass: document.documentElement.classList.contains('has-wallpaper') } : null
  })
const cap = async (p: Page): Promise<number> => Number(/최대 (\d+)%/.exec((await p.getByTestId('wallpaper-strength').textContent()) ?? '')?.[1])

describe('wallpaper and built-in plugins', () => {
  let a: Launched
  const tmp = mkdtempSync(join(tmpdir(), 'teamhub-wp-'))
  afterAll(async () => {
    await a?.close()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('offers 100 wallpapers in categories; choosing one shows it behind a veil', async () => {
    a = await launch({ profile: 'e2e-wp' })
    a.page.on('dialog', (d) => void d.accept())
    await runWizard(a.page, PORT)
    await go(a.page, '/settings')
    await a.page.getByRole('radio', { name: '밝게' }).click()
    const card = a.page.getByTestId('wallpaper-card')
    expect(await card.getByTestId('wallpaper-option').count()).toBe(100)
    expect(await layer(a.page)).toBeNull()
    for (const tab of ['예쁜', '남성용', '재미', '스타·무대', '코믹', '자연', '심플', '계절·기념일']) {
      await card.getByRole('tab', { name: tab, exact: true }).click()
      expect(await card.getByTestId('wallpaper-option').count()).toBeGreaterThanOrEqual(10)
    }
    await card.getByRole('tab', { name: '예쁜', exact: true }).click()
    await card.getByRole('button', { name: '배경 벚꽃 물결' }).click()
    await expect.poll(() => layer(a.page)).toMatchObject({ hasClass: true })
    expect(await card.getByTestId('wallpaper-current').textContent()).toBe('벚꽃 물결')
    // a light design in the light theme may show strongly
    expect(await cap(a.page)).toBeGreaterThan(50)
    await card.getByTestId('wallpaper-guard').waitFor()
  }, 120000)

  it('the guard limits the strength per wallpaper and theme, whatever the slider says', async () => {
    const card = a.page.getByTestId('wallpaper-card')
    await card.getByLabel('배경 진하기').fill('100')
    const lightCap = await cap(a.page)
    expect((await layer(a.page))!.veil).toBeCloseTo(1 - lightCap / 100, 2)
    // the same light design under the dark theme: much less may show
    await a.page.getByRole('radio', { name: '어둡게' }).click()
    await expect.poll(() => cap(a.page)).toBeLessThan(lightCap)
    const darkCap = await cap(a.page)
    expect((await layer(a.page))!.veil).toBeGreaterThanOrEqual(1 - darkCap / 100 - 0.011)
    expect((await layer(a.page))!.veil).toBeGreaterThan(0.5)
    // text really is light-on-dark with enough contrast: measured from the rendered colours
    const ratio = await a.page.evaluate(() => {
      const lum = (c: string): number => {
        const [r, g, b] = (c.match(/[\d.]+/g) ?? []).slice(0, 3).map((v) => {
          const s = Number(v) / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        })
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
      }
      const probe = document.createElement('span')
      probe.className = 'text-muted-foreground'
      document.body.append(probe)
      const fg = lum(getComputedStyle(probe).color)
      probe.remove()
      // worst case for the dark theme: a white wallpaper pixel under the veil
      const veil = Number(document.querySelector<HTMLElement>('[data-testid=wallpaper]')!.dataset.veil)
      const bgc = [15, 23, 42].map((v) => v * veil + 255 * (1 - veil))
      const bg = lum(`rgb(${bgc.join(',')})`)
      return (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
    })
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    await a.page.getByRole('radio', { name: '밝게' }).click()
  }, 120000)

  it('own picture: added, measured, strongly limited when harsh, blur available; kept after a restart; "사용 안 함" removes it', async () => {
    const card = a.page.getByTestId('wallpaper-card')
    const file = join(tmp, 'harsh.bmp')
    harshPicture(file)
    await card.getByRole('tab', { name: /내 그림/ }).click()
    await card.getByLabel('배경 그림 파일').setInputFiles(file)
    await expect.poll(() => card.getByTestId('wallpaper-custom').count(), { timeout: 15000 }).toBe(1)
    await expect.poll(() => card.getByTestId('wallpaper-current').textContent()).toBe('harsh')
    await expect.poll(() => layer(a.page), { timeout: 10000 }).not.toBeNull()
    // black and white picture: the veil must stay thick in both themes
    expect(await cap(a.page)).toBeLessThanOrEqual(40)
    expect((await layer(a.page))!.veil).toBeGreaterThanOrEqual(0.6)
    await card.getByLabel('배경 흐리게').fill('8')
    await a.close({ keepData: true })
    a = await launch({ profile: 'e2e-wp', userData: a.userData })
    a.page.on('dialog', (d) => void d.accept())
    await a.page.getByTestId('conn-state').filter({ hasText: '서버 연결됨' }).waitFor({ timeout: 30000 })
    await expect.poll(() => layer(a.page), { timeout: 15000 }).toMatchObject({ hasClass: true })
    await go(a.page, '/settings')
    const card2 = a.page.getByTestId('wallpaper-card')
    expect(await card2.getByTestId('wallpaper-current').textContent()).toBe('harsh')
    await card2.getByRole('button', { name: '사용 안 함' }).click()
    await expect.poll(() => layer(a.page)).toBeNull()
    expect(await a.page.evaluate(() => document.documentElement.classList.contains('has-wallpaper'))).toBe(false)
  }, 120000)

  it('plugins shipped with the app install with one click, without the download site', async () => {
    await go(a.page, '/plugins')
    const cards = a.page.getByTestId('catalog-plugin')
    await expect.poll(() => cards.count(), { timeout: 20000 }).toBeGreaterThanOrEqual(2)
    const ladder = cards.filter({ hasText: '사다리타기' })
    expect(await ladder.textContent()).toContain('기본 제공')
    await ladder.getByRole('button', { name: '바로 설치' }).click()
    await expect.poll(() => a.page.getByTestId('installed-plugin').count(), { timeout: 15000 }).toBe(1)
    expect(await a.page.getByTestId('installed-plugin').textContent()).toContain('기본 제공')
    await expect.poll(() => a.page.getByRole('navigation', { name: '주 메뉴' }).getByRole('link', { name: '사다리타기' }).count()).toBe(1)
    // the rest in one go would need a second uninstalled built-in; install the remaining one directly
    await cards.filter({ hasText: '스마트 대장' }).getByRole('button', { name: '바로 설치' }).click()
    await expect.poll(() => a.page.getByTestId('installed-plugin').count(), { timeout: 15000 }).toBe(2)
  }, 120000)
})
