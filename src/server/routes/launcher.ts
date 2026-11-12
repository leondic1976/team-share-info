import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import { newId, parseJson } from '../../node/sqlite'
import { isSafeTeamTarget, teamLauncherInputSchema, type TeamLauncherDto, type TeamLauncherKind } from '../../shared/schemas/launcher'
import type { SecurityProgramDto } from '../../shared/schemas/sysutil'
import type { ServerContext } from '../context'
import { badRequest, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { deleteAttachmentsOf, linkAttachments, registerAttachmentOwner } from './attachments'

interface ItemRow {
  id: string
  kind: TeamLauncherKind
  name: string
  target: string
  group_name: string
  sort: number
  blob_id: string | null
  file_name: string | null
}

const dto = (r: ItemRow): TeamLauncherDto => ({ id: r.id, kind: r.kind, name: r.name, target: r.target, groupName: r.group_name, sort: r.sort, attachmentId: r.blob_id, fileName: r.file_name })

/**
 * Team launcher (web addresses, shared folders, templates) and the list of security
 * programs the organization requires (6.13, 6.14). Admins manage; everyone reads.
 */
export function registerLauncherRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const admin = { preHandler: [guards.requireAuth, guards.requireAdmin] }
  const db = ctx.db
  // Team templates are for everyone in the team.
  registerAttachmentOwner('launcher', (d, id) => !!d.get('SELECT 1 FROM launcher_items WHERE id = ?', [id]))
  // Team launcher items are visible to every active member (broadcast is reserved, 13.7).
  const changed = (): void => ctx.hub.sendTo(db.all<{ id: string }>(`SELECT id FROM members WHERE status = 'active'`).map((m) => m.id), 'launcher.changed', {})

  app.get('/api/launcher', auth, async () => ok(db.all<ItemRow>('SELECT * FROM launcher_items ORDER BY group_name, sort, name').map(dto)))

  app.post('/api/admin/launcher', admin, async (req) => {
    const input = parse(teamLauncherInputSchema, req.body)
    const id = newId()
    const t = Date.now()
    let fileName: string | null = null
    db.tx(() => {
      if (input.kind === 'template') {
        const a = db.get<{ name: string }>(`SELECT name FROM attachments WHERE id = ? AND owner_type = 'pending' AND created_by = ?`, [input.attachmentId ?? '', req.member.id])
        if (!a) throw badRequest('양식 파일을 먼저 올리세요.')
        fileName = a.name
      }
      const sort = db.get<{ m: number }>('SELECT COALESCE(MAX(sort), 0) + 1 AS m FROM launcher_items WHERE group_name = ?', [input.groupName])?.m ?? 0
      db.run('INSERT INTO launcher_items (id, kind, name, target, group_name, sort, blob_id, file_name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        id,
        input.kind,
        input.name,
        input.kind === 'template' ? '' : input.target,
        input.groupName,
        sort,
        input.kind === 'template' ? (input.attachmentId ?? null) : null,
        fileName,
        req.member.id,
        t,
        t
      ])
      if (input.kind === 'template' && input.attachmentId) linkAttachments(ctx, [input.attachmentId], 'launcher', id, req.member.id)
    })
    logActivity(ctx, req, 'launcher.create', { type: 'launcher', id }, { kind: input.kind, name: input.name })
    changed()
    return ok(dto(db.get<ItemRow>('SELECT * FROM launcher_items WHERE id = ?', [id])!))
  })

  app.patch('/api/admin/launcher/:id', admin, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    const r = db.get<ItemRow>('SELECT * FROM launcher_items WHERE id = ?', [id])
    if (!r) throw notFound('공용 런처 항목')
    const p = parse(z.object({ name: z.string().trim().min(1).max(60).optional(), target: z.string().trim().max(1000).optional(), groupName: z.string().trim().max(30).optional() }), req.body)
    if (p.target !== undefined && r.kind !== 'template' && !isSafeTeamTarget(r.kind, p.target)) throw badRequest('주소나 경로가 올바르지 않거나 실행 파일입니다.')
    db.run('UPDATE launcher_items SET name = COALESCE(?, name), target = COALESCE(?, target), group_name = COALESCE(?, group_name), updated_at = ? WHERE id = ?', [p.name ?? null, r.kind === 'template' ? null : (p.target ?? null), p.groupName ?? null, Date.now(), id])
    logActivity(ctx, req, 'launcher.update', { type: 'launcher', id })
    changed()
    return ok(dto(db.get<ItemRow>('SELECT * FROM launcher_items WHERE id = ?', [id])!))
  })

  app.post('/api/admin/launcher/reorder', admin, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(z.string()).max(500) }), req.body)
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE launcher_items SET sort = ? WHERE id = ?', [i, id])))
    changed()
    return ok({ count: ids.length })
  })

  app.delete('/api/admin/launcher/:id', admin, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    if (!db.get('SELECT 1 FROM launcher_items WHERE id = ?', [id])) throw notFound('공용 런처 항목')
    db.tx(() => {
      deleteAttachmentsOf(ctx, 'launcher', id)
      db.run('DELETE FROM launcher_items WHERE id = ?', [id])
    })
    logActivity(ctx, req, 'launcher.delete', { type: 'launcher', id })
    changed()
    return ok({ id })
  })

  // ---------- security programs ----------
  const progDto = (r: { id: string; name: string; process_names: string; service_names: string }): SecurityProgramDto => ({
    id: r.id,
    name: r.name,
    processNames: parseJson<string[]>(r.process_names, []),
    serviceNames: parseJson<string[]>(r.service_names, [])
  })
  const names = z.array(z.string().trim().min(1).max(100).regex(/^[\w .()-]+$/, '프로세스·서비스 이름에 쓸 수 없는 문자가 있습니다.')).max(10)

  app.get('/api/security-programs', auth, async () => ok(db.all<{ id: string; name: string; process_names: string; service_names: string }>('SELECT * FROM security_programs ORDER BY name').map(progDto)))

  app.post('/api/admin/security-programs', admin, async (req) => {
    const i = parse(z.object({ name: z.string().trim().min(1).max(60), processNames: names.default([]), serviceNames: names.default([]) }), req.body)
    if (!i.processNames.length && !i.serviceNames.length) throw badRequest('프로세스 이름이나 서비스 이름을 하나 이상 입력하세요.')
    const id = newId()
    db.run('INSERT INTO security_programs (id, name, process_names, service_names, created_at) VALUES (?, ?, ?, ?, ?)', [id, i.name, JSON.stringify(i.processNames), JSON.stringify(i.serviceNames), Date.now()])
    logActivity(ctx, req, 'security_program.create', { type: 'security_program', id }, { name: i.name })
    ctx.hub.broadcast('settings.changed', { securityPrograms: true })
    return ok({ id })
  })

  app.delete('/api/admin/security-programs/:id', admin, async (req) => {
    const { id } = parse(z.object({ id: z.string() }), req.params)
    db.run('DELETE FROM security_programs WHERE id = ?', [id])
    logActivity(ctx, req, 'security_program.delete', { type: 'security_program', id })
    ctx.hub.broadcast('settings.changed', { securityPrograms: true })
    return ok({ id })
  })
}
