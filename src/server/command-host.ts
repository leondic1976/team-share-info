/**
 * TeamHub as the host of the 긴급구조지휘대 module (command/): authentication, members, files,
 * realtime events and errors come from TeamHub; the module keeps its data in command.db next
 * to teamhub.db (the server PC stores and manages everything).
 */
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { registerCommandRoutes, type CommandServer } from '../../command/server/routes'
import type { CommandServerHost } from '../../command/server/host'
import type { ServerContext } from './context'
import { AppError } from './errors'
import { ERROR_CODES, type ErrorCode } from '../shared/constants'
import { ok } from './validate'
import { isOwnerRequest } from './auth'
import { listMembers } from './repos/members'
import { serverDeviceId } from './repos/devices'
import { deleteAttachmentsOf, linkAttachments, listAttachments, registerAttachmentOwner } from './routes/attachments'
import { logActivity } from './activity'
import { recordError } from './context'

export function registerCommand(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }, opts: { memory?: boolean } = {}): CommandServer {
  const host: CommandServerHost = {
    dataDir: opts.memory ? null : ctx.dataDir,
    requireAuth: guards.requireAuth,
    user: (req) => ({ id: req.member.id, name: req.member.name, isOwner: isOwnerRequest(ctx, req) }),
    members: () => {
      const owners = new Set(host.ownerIds())
      return listMembers(ctx.db).map((m) => ({
        id: m.id,
        name: m.nickname ? `${m.name}(${m.nickname})` : m.name,
        title: m.title ?? '',
        dept: (m.dept_path?.length ? m.dept_path.join(' > ') : m.dept_name) ?? '',
        // the 서무 mark everywhere a name is shown (an admin who is not the server PC's account)
        ...(m.role === 'admin' && !owners.has(m.id) ? { mark: '서무' } : {})
      }))
    },
    ownerIds: () => {
      const id = serverDeviceId(ctx.db)
      const r = id ? ctx.db.get<{ member_id: string }>('SELECT member_id FROM devices WHERE id = ?', [id]) : undefined
      return r ? [r.member_id] : []
    },
    attachments: {
      link: (ids, ownerType, ownerId, memberId) => linkAttachments(ctx, ids, ownerType, ownerId, memberId),
      list: (ownerType, ownerId) => listAttachments(ctx.db, ownerType, ownerId),
      remove: (ownerType, ownerId) => deleteAttachmentsOf(ctx, ownerType, ownerId),
      registerOwner: (ownerType, check) => registerAttachmentOwner(ownerType, (_db, ownerId, memberId) => check(ownerId, memberId))
    },
    emit: (memberIds, event, payload) => (memberIds ? ctx.hub.sendTo(memberIds, event, payload) : ctx.hub.broadcast(event, payload)),
    fail: (status, code, message) => new AppError((code in ERROR_CODES ? code : status === 404 ? 'NOT_FOUND' : status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST') as ErrorCode, message, status),
    ok: (data) => ok(data),
    log: (req, action, detail) => logActivity(ctx, req, action, null, detail),
    report: (message) => recordError(ctx, `command: ${message}`)
  }
  return registerCommandRoutes(app, host)
}
