import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { handle } from './registry'
import { closeUrgentPopup, getPopupPayload, openUrgentIds, showToast, showUrgentPopup, syncUrgentPopups } from '../notifications'
import { getMainWindow, showMainWindow } from '../windows/main-window'
import { dismissPreview, openPreview, previewItems, previewRead } from '../preview'

const urgentSchema = z.object({
  id: z.string(),
  title: z.string(),
  bodyHtml: z.string(),
  authorName: z.string(),
  requireAck: z.boolean(),
  replyOptions: z.array(z.string()),
  publishedAt: z.number(),
  level: z.enum(['urgent', 'important', 'normal'])
})

export function registerNotifyIpc(): void {
  handle('notify:urgent', urgentSchema, (p) => showUrgentPopup(p))
  handle('notify:closeUrgent', z.object({ id: z.string() }), ({ id }) => {
    closeUrgentPopup(id)
    // Tell the main window so it can refresh notice state.
    getMainWindow()?.webContents.send('popup:closed', { id })
  })
  handle('notify:openUrgent', null, () => openUrgentIds())
  handle('notify:syncUrgent', z.object({ ids: z.array(z.string().max(100)).max(500) }), ({ ids }) => {
    const closed = syncUrgentPopups(ids)
    if (closed.length) getMainWindow()?.webContents.send('popup:closed', { id: closed[0]! })
    return closed
  })
  handle('notify:toast', z.object({ title: z.string().max(200), body: z.string().max(500), route: z.string().max(200).optional(), key: z.string().max(64).optional(), kind: z.enum(['message', 'alert']).optional() }), (o) => showToast(o))
  handle('popup:get', z.object({ id: z.string() }), ({ id }) => getPopupPayload(id))
  handle('preview:list', null, () => previewItems())
  handle('preview:open', z.object({ key: z.string().max(64) }), ({ key }) => openPreview(key))
  handle('preview:dismiss', z.object({ key: z.string().max(64).nullable() }), ({ key }) => dismissPreview(key))
  handle('preview:read', z.object({ key: z.string().max(64) }), ({ key }) => previewRead(key))
  handle('window:showMain', z.object({ path: z.string().max(200).optional() }), ({ path }) => {
    showMainWindow()
    if (path) getMainWindow()?.webContents.send('app:navigate', { path })
  })
  handle('window:inFront', null, (_r, e) => {
    const w = BrowserWindow.fromWebContents(e.sender)
    return !!w && w.isVisible() && !w.isMinimized() && w.isFocused()
  })
  handle('window:flash', z.object({ on: z.boolean() }), ({ on }, e) => {
    BrowserWindow.fromWebContents(e.sender)?.flashFrame(on)
  })
}
