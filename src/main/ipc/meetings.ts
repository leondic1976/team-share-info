import { z } from 'zod'
import { handle } from './registry'
import { captureSources, chooseSource, closeInvite, getInvite, hideShareBorder, openMeetingWindow, showInvite, showShareBorder } from '../meetings'

/** IPC for meetings (6.17): windows, invite pop-ups, screen picker and share border. */
export function registerMeetingIpc(): void {
  handle('meeting:open', z.object({ id: z.string() }), ({ id }) => openMeetingWindow(id))
  handle('meeting:sources', null, () => captureSources())
  handle('meeting:chooseSource', z.object({ id: z.string().max(200), audio: z.boolean() }), ({ id, audio }) => chooseSource(id, audio))
  handle('meeting:border', z.object({ on: z.boolean(), displayId: z.string().nullable().optional() }), ({ on, displayId }) => (on ? showShareBorder(displayId ?? null) : hideShareBorder()))
  handle('meeting:invite', z.object({ id: z.string(), title: z.string().max(100), mode: z.enum(['video', 'screen']), hostName: z.string().max(100) }), (p) => showInvite(p))
  handle('meeting:inviteGet', z.object({ id: z.string() }), ({ id }) => getInvite(id))
  handle('meeting:inviteClose', z.object({ id: z.string(), accept: z.boolean() }), ({ id, accept }) => closeInvite(id, accept))
}
