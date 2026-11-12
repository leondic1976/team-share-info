import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { createReadStream, existsSync } from 'node:fs'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import type { ServerContext } from '../context'
import { notFound } from '../errors'
import { parse, ok } from '../validate'
import { canSee } from '../scope'
import { addRef, assertName, blobAbsPath, checkUploadAllowed, contentDisposition, storeStream, type BlobRow } from '../storage/blobs'

export interface AttachmentDto {
  id: string
  name: string
  size: number
}

type OwnerCheck = (db: Db, ownerId: string, memberId: string) => boolean

/** Owner types that can carry attachments and how to check that a member may see the owner. */
export const ATTACHMENT_OWNERS: Record<string, OwnerCheck> = {
  notice: (db, id, m) => canSee(db, 'notices', 'notice', id, m)
}

export function registerAttachmentOwner(ownerType: string, check: OwnerCheck): void {
  ATTACHMENT_OWNERS[ownerType] = check
}

export function listAttachments(db: Db, ownerType: string, ownerId: string): AttachmentDto[] {
  return db.all<AttachmentDto>('SELECT id, name, size FROM attachments WHERE owner_type = ? AND owner_id = ? ORDER BY created_at', [ownerType, ownerId])
}

/** Attach previously uploaded (pending) files of this member to an owner item. */
export function linkAttachments(ctx: ServerContext, ids: string[], ownerType: string, ownerId: string, memberId: string): void {
  for (const id of new Set(ids)) {
    const a = ctx.db.get<{ blob_id: string }>(`SELECT blob_id FROM attachments WHERE id = ? AND owner_type = 'pending' AND created_by = ?`, [id, memberId])
    if (!a) continue
    ctx.db.run('UPDATE attachments SET owner_type = ?, owner_id = ?, updated_at = ? WHERE id = ?', [ownerType, ownerId, Date.now(), id])
  }
}

export function deleteAttachmentsOf(ctx: ServerContext, ownerType: string, ownerId: string): void {
  for (const a of ctx.db.all<{ id: string; blob_id: string }>('SELECT id, blob_id FROM attachments WHERE owner_type = ? AND owner_id = ?', [ownerType, ownerId])) {
    addRef(ctx, a.blob_id, -1)
    ctx.db.run('DELETE FROM attachments WHERE id = ?', [a.id])
  }
}

export function registerAttachmentRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }

  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
    scoped.post('/api/attachments', { ...auth, bodyLimit: 4 * 1024 * 1024 * 1024 }, async (req) => {
      const q = parse(z.object({ name: z.string().min(1).max(200), size: z.coerce.number().int().min(0).optional() }), req.query)
      const name = assertName(q.name)
      checkUploadAllowed(ctx, name, q.size)
      const blob = await storeStream(ctx, req.body as Readable)
      const id = newId()
      const t = Date.now()
      ctx.db.run(
        `INSERT INTO attachments (id, owner_type, owner_id, blob_id, name, size, created_by, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.member.id, blob.id, name, blob.size, req.member.id, t, t]
      )
      addRef(ctx, blob.id, 1)
      return ok({ id, name, size: blob.size } satisfies AttachmentDto)
    })
  })

  app.get('/api/attachments/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const a = ctx.db.get<{ owner_type: string; owner_id: string; blob_id: string; name: string; created_by: string }>(
      'SELECT owner_type, owner_id, blob_id, name, created_by FROM attachments WHERE id = ?',
      [id]
    )
    if (!a) throw notFound('첨부 파일')
    if (a.owner_type === 'pending') {
      if (a.created_by !== req.member.id) throw notFound('첨부 파일')
    } else {
      const check = ATTACHMENT_OWNERS[a.owner_type]
      if (!check || !check(ctx.db, a.owner_id, req.member.id)) throw notFound('첨부 파일')
    }
    const blob = ctx.db.get<BlobRow>('SELECT * FROM blobs WHERE id = ?', [a.blob_id])
    if (!blob || !existsSync(blobAbsPath(ctx, blob))) throw notFound('파일')
    const inline = (req.query as { inline?: string }).inline === '1'
    return reply
      .header('Content-Type', 'application/octet-stream')
      .header('Content-Length', String(blob.size))
      .header('Content-Disposition', contentDisposition(a.name, inline))
      .send(createReadStream(blobAbsPath(ctx, blob)))
  })
}
