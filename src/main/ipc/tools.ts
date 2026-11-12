import { BrowserWindow } from 'electron'
import { z } from 'zod'
import { handle } from './registry'
import { localDb } from '../localdb'
import { alarmInputSchema, memoInputSchema, snippetInputSchema } from '../../shared/schemas/tools'
import { tick, upcoming } from '../scheduler'
import {
  alarmPopupAction,
  broadcast,
  clipboardSettings,
  focusState,
  getAlarmPopup,
  memoChanged,
  openQuickMemo,
  saveCaptureFile,
  setClipboardSettings,
  setSticky,
  setStickyOnTop,
  showRemoteAlarm,
  startCapture,
  startFocus,
  stopFocus,
  writeClipboard
} from '../tools'

const ID = z.object({ id: z.string().min(1).max(64) })

/** IPC for personal tools (6.12). All data stays in the local DB. */
export function registerToolsIpc(): void {
  // memos
  handle('local:memos.list', z.object({ q: z.string().max(100).default('') }), ({ q }) => localDb().memos.list(q))
  handle('local:memos.get', ID, ({ id }) => localDb().memos.get(id))
  handle('local:memos.save', memoInputSchema, (i) => {
    const id = localDb().memos.save(i)
    memoChanged(id)
    return id
  })
  handle('local:memos.delete', ID, ({ id }) => {
    localDb().memos.delete(id)
    memoChanged(id, true)
  })
  handle('memo:sticky', z.object({ id: z.string(), on: z.boolean() }), ({ id, on }) => setSticky(id, on))
  handle('memo:onTop', z.object({ id: z.string(), on: z.boolean() }), ({ id, on }) => setStickyOnTop(id, on))
  handle('memo:quick', null, () => openQuickMemo())
  handle('memo:closeWindow', null, (_req, e) => BrowserWindow.fromWebContents(e.sender)?.close())

  // alarms
  handle('local:alarms.list', null, () => localDb().alarms.list())
  handle('local:alarms.save', alarmInputSchema, (i) => {
    const id = localDb().alarms.save(i)
    broadcast('alarms:changed', { id })
    tick()
    return id
  })
  handle('local:alarms.setEnabled', z.object({ id: z.string(), enabled: z.boolean() }), ({ id, enabled }) => {
    localDb().alarms.setEnabled(id, enabled)
    broadcast('alarms:changed', { id })
  })
  handle('local:alarms.delete', ID, ({ id }) => {
    localDb().alarms.delete(id)
    broadcast('alarms:changed', { id })
  })
  handle('alarm:popupGet', z.object({ pid: z.string() }), ({ pid }) => getAlarmPopup(pid))
  handle('alarm:popupAction', z.object({ pid: z.string(), action: z.enum(['dismiss', 'snooze']), minutes: z.number().int().min(1).max(120).optional() }), ({ pid, action, minutes }) =>
    alarmPopupAction(pid, action, minutes)
  )
  handle(
    'alarm:showRemote',
    z.object({ id: z.string(), fromName: z.string().max(100), title: z.string().max(100), body: z.string().max(500), fireAt: z.number() }),
    (a) => showRemoteAlarm(a)
  )
  handle('scheduler:upcoming', z.object({ from: z.number(), to: z.number() }), ({ from, to }) => upcoming(from, Math.min(to, from + 32 * 86400000)))

  // snippets
  handle('local:snippets.list', null, () => localDb().tools.snippets())
  handle('local:snippets.save', snippetInputSchema, (i) => localDb().tools.saveSnippet(i))
  handle('local:snippets.delete', ID, ({ id }) => localDb().tools.deleteSnippet(id))
  handle('local:snippets.use', ID, ({ id }) => localDb().tools.useSnippet(id))

  // clipboard
  handle('local:clipboard.list', null, () => localDb().tools.clipboard())
  handle('local:clipboard.delete', z.object({ id: z.string().nullable() }), ({ id }) => {
    localDb().tools.deleteClipboard(id)
    broadcast('clipboard:changed', { count: 0 })
  })
  handle('clipboard:getSettings', null, () => clipboardSettings())
  handle('clipboard:setSettings', z.object({ enabled: z.boolean(), clearOnExit: z.boolean() }), (s) => setClipboardSettings(s))
  handle('clipboard:write', z.object({ text: z.string().max(5_000_000).optional(), dataUrl: z.string().max(10_000_000).optional() }), (o) => writeClipboard(o))

  // favorites
  handle('local:favorites.list', null, () => localDb().tools.favorites())
  handle('local:favorites.toggle', z.object({ itemType: z.string().max(30), itemId: z.string().max(500), title: z.string().max(200), route: z.string().max(1000) }), (f) => {
    const on = localDb().tools.toggleFavorite(f)
    broadcast('favorites:changed', { count: localDb().tools.favorites().length })
    return on
  })

  // focus timer
  handle('focus:start', z.object({ minutes: z.number().int().min(1).max(180), kind: z.enum(['focus', 'break']) }), ({ minutes, kind }) => startFocus(minutes, kind))
  handle('focus:stop', null, () => stopFocus(false))
  handle('focus:state', null, () => ({ ...focusState(), today: localDb().tools.focusToday() }))

  // screen capture
  handle('capture:start', null, () => startCapture())
  handle('capture:saveFile', z.object({ dataUrl: z.string().max(20_000_000) }), ({ dataUrl }) => saveCaptureFile(dataUrl))
}
