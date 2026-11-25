import { describe, it, expect, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { go, launch, runWizard, type Launched } from './helpers'

/**
 * 지시 102: the X of the tray cards did nothing. Cause: another program's always-on-top alert
 * window in the same corner (KakaoTalk, class EVA_Window_Dblclk, transparent and layered) covered
 * the cards and took the clicks. The test puts such a window over the card, checks that it really
 * takes the point, then clicks X with the real OS mouse (SetCursorPos + mouse_event).
 */

const USER32 = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class M {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(P p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
}
'@
[M]::SetProcessDPIAware() | Out-Null
`

function ps(script: string): string {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', USER32 + script]).toString().trim()
}

/** The top-level window that gets the mouse at a physical screen point. */
function rootAt(x: number, y: number): string {
  return ps(`$p = New-Object M+P; $p.X = ${Math.round(x)}; $p.Y = ${Math.round(y)}; [M]::GetAncestor([M]::WindowFromPoint($p), 2).ToString()`)
}

function move(x: number, y: number): void {
  ps(`[M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null`)
}

function click(x: number, y: number): void {
  ps(`[M]::SetCursorPos(${Math.round(x)}, ${Math.round(y)}) | Out-Null; Start-Sleep -Milliseconds 100; [M]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 60; [M]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)`)
}

describe('tray cards', () => {
  let a: Launched
  afterAll(async () => {
    await a?.close()
  })

  it('X closes the card although another always-on-top window covers it', async () => {
    a = await launch({ profile: 'e2e-tray' })
    await a.page.waitForTimeout(1500)
    const find = () => a.app.windows().find((w) => w.url().includes('/popup/preview') && !w.isClosed())
    await a.page.evaluate(() => window.teamhub.invoke('notify:toast', { title: '카드 E2E', body: '닫기 확인', key: 'k0' }))
    await expect.poll(() => !!find(), { timeout: 15000 }).toBe(true)
    const w = find()!
    await expect.poll(() => w.getByTestId('preview-card').count(), { timeout: 10000 }).toBe(1)

    // the bottom right corner of another monitor when there is one (an installed TeamHub may show its own cards on the primary one),
    // then a transparent always-on-top window over the cards, shown after them, like KakaoTalk's alert
    const info = await a.app.evaluate(async ({ BrowserWindow, screen }) => {
      const pw = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup/preview'))!
      const d = screen.getAllDisplays().find((x) => x.id !== screen.getPrimaryDisplay().id) ?? screen.getPrimaryDisplay()
      const b = pw.getBounds()
      pw.setBounds({ x: d.workArea.x + d.workArea.width - b.width - 12, y: d.workArea.y + d.workArea.height - b.height - 12, width: b.width, height: b.height })
      const cover = new BrowserWindow({ ...pw.getBounds(), frame: false, transparent: true, focusable: false, skipTaskbar: true, alwaysOnTop: true, show: false, resizable: false })
      cover.setAlwaysOnTop(true, 'pop-up-menu')
      await cover.loadURL('data:text/html,<body style="background:rgba(0,0,0,0.02);margin:0"></body>')
      cover.showInactive()
      ;(globalThis as unknown as { __cover: typeof cover }).__cover = cover
      const h = (x: Electron.BrowserWindow) => x.getNativeWindowHandle().readBigUInt64LE().toString()
      return { cb: pw.getContentBounds(), preview: h(pw), cover: h(cover) }
    })
    await w.waitForTimeout(500)
    const box = (await w.locator('button[aria-label="닫기"]').first().boundingBox())!
    const card = (await w.getByTestId('preview-card').first().boundingBox())!
    const x = info.cb.x + box.x + box.width / 2
    const y = info.cb.y + box.y + box.height / 2

    // away from the cards the covering window takes the point: this is the reported state
    move(info.cb.x - 60, info.cb.y - 60)
    await w.waitForTimeout(400)
    // (the cards take the top back every few seconds, so the covering window is raised right before each look)
    await expect
      .poll(
        async () => {
          await a.app.evaluate(() => (globalThis as unknown as { __cover: Electron.BrowserWindow }).__cover.moveTop())
          return rootAt(x, y)
        },
        { timeout: 10000 }
      )
      .toBe(info.cover)

    // a person moves onto the card, reads it, goes to X and clicks
    move(info.cb.x + card.x + card.width / 2, info.cb.y + card.y + card.height / 2)
    await w.waitForTimeout(1000)
    expect(rootAt(x, y)).toBe(info.preview)
    move(x, y)
    await w.waitForTimeout(500)
    click(x, y)
    await expect
      .poll(() => a.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((x) => x.webContents.getURL().includes('/popup/preview') && x.isVisible())), { timeout: 5000 })
      .toBe(false)
    await a.app.evaluate(() => (globalThis as unknown as { __cover: Electron.BrowserWindow }).__cover.destroy())
  }, 120000)

  it('설정 → 미리보기 위치: the top right corner, and back to the bottom right', async () => {
    await a.close()
    a = await launch({ profile: 'e2e-tray-corner' })
    await runWizard(a.page, '47431')
    await go(a.page, '/settings')
    const where = () =>
      a.app.evaluate(({ BrowserWindow, screen }) => {
        const pw = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('/popup/preview') && x.isVisible())
        if (!pw) return null
        const b = pw.getBounds()
        const wa = screen.getPrimaryDisplay().workArea
        return { top: b.y - wa.y, bottom: wa.y + wa.height - (b.y + b.height), right: wa.x + wa.width - (b.x + b.width) }
      })
    await a.page.getByRole('radio', { name: '오른쪽 위' }).click()
    await a.page.getByRole('button', { name: '시험 알림' }).click()
    await expect.poll(where, { timeout: 10000 }).toEqual(expect.objectContaining({ top: 40, right: 12 }))
    const card = a.app.windows().find((w) => w.url().includes('/popup/preview'))!
    await expect.poll(() => card.getByTestId('preview-card').filter({ hasText: 'TeamHub 시험 알림' }).count()).toBe(1)
    // changed while the card is shown: it moves within a few seconds
    await a.page.getByRole('radio', { name: '오른쪽 아래' }).click()
    await expect.poll(where, { timeout: 8000 }).toEqual(expect.objectContaining({ bottom: 12, right: 12 }))
    await card.locator('button[aria-label="닫기"]').first().click()
    await expect.poll(where, { timeout: 5000 }).toBe(null)
  }, 120000)
})
