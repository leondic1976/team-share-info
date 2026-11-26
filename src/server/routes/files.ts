import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import type { Db } from '../../node/sqlite'
import { LIMITS } from '../../shared/constants'
import {
  folderCreateSchema,
  folderPatchSchema,
  uploadCreateSchema,
  type FileDto,
  type FileVersionDto,
  type FolderDto,
  type FolderView,
  type TrashItemDto
} from '../../shared/schemas/files'
import type { ServerContext } from '../context'
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { audienceOf, canSee, inGroupWhere, scopeDto, setScope, visibleWhere } from '../scope'
import { addRef, adoptFile, assertName, blobAbsPath, checkUploadAllowed, contentDisposition, filesRoot, sweepUnreferenced, type BlobRow } from '../storage/blobs'
import { choseongOr } from '../choseong'

interface FolderRow {
  id: string
  parent_id: string | null
  root_id: string
  name: string
  scope_type: string
  write_policy: 'all' | 'owner'
  created_by: string
  created_by_name: string
  updated_at: number
  deleted_at: number | null
}

interface FileRow {
  id: string
  folder_id: string
  root_id: string
  name: string
  current_version_id: string | null
  size: number
  version_count: number
  locked_by: string | null
  locked_by_name: string | null
  locked_at: number | null
  created_by: string
  created_by_name: string
  updated_by: string | null
  updated_by_name: string | null
  created_at: number
  updated_at: number
  deleted_at: number | null
}

const FOLDER_SELECT = `SELECT f.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS created_by_name FROM folders f JOIN members m ON m.id = f.created_by`
const FILE_SELECT = `SELECT x.*, CASE WHEN IFNULL(LENGTH(c.nickname), 0) = 0 THEN c.name ELSE c.name || char(40) || c.nickname || char(41) END AS created_by_name, CASE WHEN IFNULL(LENGTH(u.nickname), 0) = 0 THEN u.name ELSE u.name || char(40) || u.nickname || char(41) END AS updated_by_name, CASE WHEN IFNULL(LENGTH(l.nickname), 0) = 0 THEN l.name ELSE l.name || char(40) || l.nickname || char(41) END AS locked_by_name
  FROM files x JOIN members c ON c.id = x.created_by LEFT JOIN members u ON u.id = x.updated_by LEFT JOIN members l ON l.id = x.locked_by`

const TRASH_DAYS = 30
const STALE_UPLOAD_MS = 7 * 86400000

type Actor = { id: string; role: string }

export function registerFileRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const auth = { preHandler: guards.requireAuth }
  const db = ctx.db
  const uploadsDir = (): string => {
    const d = join(filesRoot(ctx), 'uploads')
    mkdirSync(d, { recursive: true })
    return d
  }

  const rootOf = (rootId: string): FolderRow | undefined => db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ? AND f.deleted_at IS NULL`, [rootId])
  const rootVisible = (rootId: string, actor: Actor): boolean => canSee(db, 'folders', 'folder', rootId, actor.id)
  const canManageRoot = (root: FolderRow, actor: Actor): boolean => root.created_by === actor.id || actor.role === 'admin'
  const canWriteRoot = (root: FolderRow, actor: Actor): boolean => root.write_policy === 'all' || canManageRoot(root, actor)

  const toFolder = (r: FolderRow, actor: Actor): FolderDto => {
    const root = r.parent_id ? rootOf(r.root_id) ?? r : r
    return {
      id: r.id,
      parentId: r.parent_id,
      rootId: r.root_id,
      name: r.name,
      scope: scopeDto(db, 'folder', r.root_id, root.scope_type),
      writePolicy: root.write_policy,
      createdBy: r.created_by,
      createdByName: r.created_by_name,
      canWrite: canWriteRoot(root, actor),
      canManage: canManageRoot(root, actor) || r.created_by === actor.id,
      updatedAt: r.updated_at
    }
  }
  const toFile = (r: FileRow): FileDto => ({
    id: r.id,
    folderId: r.folder_id,
    name: r.name,
    size: r.size,
    versionCount: r.version_count,
    currentVersionId: r.current_version_id,
    lockedBy: r.locked_by,
    lockedByName: r.locked_by_name,
    lockedAt: r.locked_at,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    updatedBy: r.updated_by,
    updatedByName: r.updated_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })

  /** A folder is alive only if it and all its ancestors are not in the trash. */
  const folderAlive = (folderId: string): boolean => {
    let cur = db.get<{ parent_id: string | null; deleted_at: number | null }>('SELECT parent_id, deleted_at FROM folders WHERE id = ?', [folderId])
    let guard = 0
    while (cur && guard++ < 50) {
      if (cur.deleted_at) return false
      if (!cur.parent_id) return true
      cur = db.get('SELECT parent_id, deleted_at FROM folders WHERE id = ?', [cur.parent_id])
    }
    return false
  }
  /** Load a live folder the viewer may see (404 otherwise, 13.9). */
  const loadFolder = (req: FastifyRequest, id: string): FolderRow => {
    const f = db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ? AND f.deleted_at IS NULL`, [id])
    if (!f || !rootVisible(f.root_id, req.member) || !folderAlive(f.id)) throw notFound('폴더')
    return f
  }
  const loadFile = (req: FastifyRequest, id: string, includeDeleted = false): FileRow => {
    const f = db.get<FileRow>(`${FILE_SELECT} WHERE x.id = ? ${includeDeleted ? '' : 'AND x.deleted_at IS NULL'}`, [id])
    if (!f || !rootVisible(f.root_id, req.member) || (!includeDeleted && !folderAlive(f.folder_id))) throw notFound('파일')
    return f
  }
  const notifyRoot = (rootId: string, extra: string[] = []): void => {
    ctx.hub.sendTo([...audienceOf(db, 'folders', 'folder', rootId), ...extra], 'file.changed', { rootId })
  }

  const breadcrumb = (f: FolderRow): { id: string; name: string }[] => {
    const out: { id: string; name: string }[] = []
    let cur: FolderRow | undefined = f
    let guard = 0
    while (cur && guard++ < 50) {
      out.unshift({ id: cur.id, name: cur.name })
      cur = cur.parent_id ? db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [cur.parent_id]) : undefined
    }
    return out
  }

  /** Folder view: top level (visible root folders) or the contents of a folder. */
  app.get('/api/files/view', auth, async (req) => {
    const q = parse(z.object({ folderId: z.string().optional(), groupId: z.string().optional() }), req.query)
    if (!q.folderId) {
      const w = visibleWhere('f', 'folder', req.member.id)
      const params: string[] = [...w.params]
      let extra = ''
      if (q.groupId) {
        extra = ` AND ${inGroupWhere('f', 'folder')}`
        params.push(q.groupId)
      }
      const roots = db.all<FolderRow>(`${FOLDER_SELECT} WHERE f.parent_id IS NULL AND f.deleted_at IS NULL AND ${w.sql}${extra} ORDER BY f.name`, params)
      const view: FolderView = { folder: null, breadcrumb: [], folders: roots.map((r) => toFolder(r, req.member)), files: [] }
      return ok(view)
    }
    const f = loadFolder(req, q.folderId)
    const view: FolderView = {
      folder: toFolder(f, req.member),
      breadcrumb: breadcrumb(f),
      folders: db.all<FolderRow>(`${FOLDER_SELECT} WHERE f.parent_id = ? AND f.deleted_at IS NULL ORDER BY f.name`, [f.id]).map((r) => toFolder(r, req.member)),
      files: db.all<FileRow>(`${FILE_SELECT} WHERE x.folder_id = ? AND x.deleted_at IS NULL ORDER BY x.name`, [f.id]).map(toFile)
    }
    return ok(view)
  })

  /** Search and recent files across visible folders. */
  app.get('/api/files/search', auth, async (req) => {
    const q = parse(z.object({ q: z.string().max(100).default(''), recent: z.coerce.boolean().default(false), groupId: z.string().optional() }), req.query)
    const w = visibleWhere('r', 'folder', req.member.id)
    const where = ['x.deleted_at IS NULL', 'r.deleted_at IS NULL', w.sql]
    const params: (string | number)[] = [...w.params]
    if (q.q.trim()) {
      const c = choseongOr(q.q, ['x.name'])
      where.push(`(x.name LIKE ?${c.sql})`)
      params.push(`%${q.q.trim()}%`, ...c.params)
    }
    if (q.groupId) {
      where.push(inGroupWhere('r', 'folder'))
      params.push(q.groupId)
    }
    const rows = db.all<FileRow & { path_folder: string }>(
      `${FILE_SELECT} JOIN folders r ON r.id = x.root_id JOIN folders pf ON pf.id = x.folder_id
       WHERE ${where.join(' AND ')} ORDER BY x.updated_at DESC LIMIT ${q.recent ? 30 : 200}`,
      params
    )
    return ok(
      rows.filter((r) => folderAlive(r.folder_id)).map((r) => {
        const f = db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [r.folder_id])
        return { ...toFile(r), path: f ? breadcrumb(f).map((b) => b.name).join(' / ') : '' }
      })
    )
  })

  app.post('/api/folders', auth, async (req) => {
    const input = parse(folderCreateSchema, req.body)
    const id = newId()
    const t = Date.now()
    if (input.parentId) {
      const parent = loadFolder(req, input.parentId)
      const root = rootOf(parent.root_id)!
      if (!canWriteRoot(root, req.member)) throw forbidden('이 폴더에 쓸 권한이 없습니다.')
      if (db.get(`SELECT 1 FROM folders WHERE parent_id = ? AND name = ? AND deleted_at IS NULL`, [parent.id, input.name])) throw conflict('같은 이름의 폴더가 있습니다.')
      db.run(
        `INSERT INTO folders (id, parent_id, root_id, name, scope_type, write_policy, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, parent.id, parent.root_id, input.name, root.scope_type, root.write_policy, req.member.id, t, t]
      )
      logActivity(ctx, req, 'folder.create', { type: 'folder', id }, { name: input.name })
      notifyRoot(parent.root_id)
    } else {
      const scope = input.scope ?? { type: 'team' as const, groupIds: [], memberIds: [] }
      db.tx(() => {
        db.run(
          `INSERT INTO folders (id, parent_id, root_id, name, scope_type, write_policy, created_by, created_at, updated_at) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
          [id, id, input.name, scope.type, input.writePolicy, req.member.id, t, t]
        )
        setScope(db, 'folder', id, scope, req.member)
      })
      logActivity(ctx, req, 'folder.create', { type: 'folder', id }, { name: input.name, root: true })
      notifyRoot(id)
    }
    return ok(toFolder(db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [id])!, req.member))
  })

  app.patch('/api/folders/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFolder(req, id)
    const root = rootOf(f.root_id)!
    const p = parse(folderPatchSchema, req.body)
    if (!(canManageRoot(root, req.member) || f.created_by === req.member.id)) throw forbidden('폴더를 만든 사람만 바꿀 수 있습니다.')
    const before = audienceOf(db, 'folders', 'folder', f.root_id)
    db.tx(() => {
      if (p.name) db.run('UPDATE folders SET name = ?, updated_at = ? WHERE id = ?', [p.name, Date.now(), id])
      if (!f.parent_id && (p.scope || p.writePolicy)) {
        if (!canManageRoot(root, req.member)) throw forbidden()
        if (p.scope) {
          db.run('UPDATE folders SET scope_type = ? WHERE root_id = ?', [p.scope.type, id])
          setScope(db, 'folder', id, p.scope, req.member)
        }
        if (p.writePolicy) db.run('UPDATE folders SET write_policy = ? WHERE root_id = ?', [p.writePolicy, id])
      }
    })
    logActivity(ctx, req, 'folder.update', { type: 'folder', id }, p)
    ctx.hub.sendTo([...before, ...audienceOf(db, 'folders', 'folder', f.root_id)], 'file.changed', { rootId: f.root_id })
    return ok(toFolder(db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [id])!, req.member))
  })

  /** Move a folder and everything inside it to the trash (30 days). */
  app.delete('/api/folders/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFolder(req, id)
    const root = rootOf(f.root_id)!
    if (!(canManageRoot(root, req.member) || f.created_by === req.member.id)) throw forbidden('폴더를 만든 사람만 지울 수 있습니다.')
    const t = Date.now()
    db.run('UPDATE folders SET deleted_at = ?, deleted_by = ? WHERE id = ?', [t, req.member.id, id])
    logActivity(ctx, req, 'folder.delete', { type: 'folder', id }, { name: f.name })
    notifyRoot(f.root_id)
    return ok({ id })
  })

  app.get('/api/files/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    const versions = db.all<{ id: string; version_no: number; size: number; note: string | null; created_by: string; name: string; created_at: number }>(
      `SELECT v.id, v.version_no, v.size, v.note, v.created_by, m.name, v.created_at FROM file_versions v JOIN members m ON m.id = v.created_by WHERE v.file_id = ? ORDER BY v.version_no DESC`,
      [id]
    )
    const folder = db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [f.folder_id])!
    return ok({
      file: toFile(f),
      path: breadcrumb(folder).map((b) => b.name).join(' / '),
      versions: versions.map((v): FileVersionDto => ({ id: v.id, versionNo: v.version_no, size: v.size, note: v.note, createdBy: v.created_by, createdByName: v.name, createdAt: v.created_at })),
      canWrite: canWriteRoot(rootOf(f.root_id)!, req.member),
      canDelete: f.created_by === req.member.id || canManageRoot(rootOf(f.root_id)!, req.member)
    })
  })

  // ---- resumable uploads (M4-2): create -> PUT chunks at offset -> complete ----
  app.post('/api/uploads', auth, async (req) => {
    const input = parse(uploadCreateSchema, req.body)
    const name = assertName(input.name)
    const folder = loadFolder(req, input.folderId)
    const root = rootOf(folder.root_id)!
    if (!canWriteRoot(root, req.member)) throw forbidden('이 폴더에 올릴 권한이 없습니다.')
    checkUploadAllowed(ctx, name, input.size)
    if (input.fileId) {
      const file = loadFile(req, input.fileId)
      if (file.locked_by && file.locked_by !== req.member.id) throw new AppError('LOCKED', `${file.locked_by_name}님이 편집 중입니다.`, 423)
    }
    const id = newId()
    const t = Date.now()
    const temp = join(uploadsDir(), `${id}.part`)
    createWriteStream(temp).end()
    db.run(
      `INSERT INTO uploads (id, name, size, folder_id, file_id, note, received_bytes, temp_path, state, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'active', ?, ?, ?)`,
      [id, name, input.size, folder.id, input.fileId ?? null, input.note || null, temp, req.member.id, t, t]
    )
    return ok({ id, received: 0, size: input.size, chunkSize: LIMITS.uploadChunkBytes })
  })

  interface UploadRow {
    id: string
    name: string
    size: number
    folder_id: string
    file_id: string | null
    note: string | null
    received_bytes: number
    temp_path: string
    state: string
    created_by: string
  }
  interface UploadResult {
    file: FileDto
    sha256: string
    newVersion: boolean
  }
  /** The chunk being written for an upload right now. */
  const writing = new Map<string, { done: Promise<void>; abort: () => void }>()
  /** Uploads being hashed and registered; a repeated "complete" waits for the first one. */
  const completing = new Map<string, Promise<UploadResult>>()
  /**
   * A client that asks for the position or sends another chunk has given up on the chunk it was
   * sending (timeout, dropped connection). End that request and wait until its bytes are on disk,
   * so the position we report is final and two requests never append to the same file.
   */
  const settle = async (id: string): Promise<void> => {
    for (let cur = writing.get(id); cur; cur = writing.get(id)) {
      cur.abort()
      await cur.done
    }
  }

  const loadUpload = (req: FastifyRequest, id: string): UploadRow => {
    const u = db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', [id])
    if (!u || u.created_by !== req.member.id || u.state !== 'active') throw notFound('업로드')
    // The file on disk is the source of truth for the received size.
    const onDisk = existsSync(u.temp_path) ? statSync(u.temp_path).size : 0
    if (onDisk !== u.received_bytes) {
      db.run('UPDATE uploads SET received_bytes = ? WHERE id = ?', [onDisk, id])
      u.received_bytes = onDisk
    }
    return u
  }

  /** Where to continue. Also answers for an upload that finished while the client was cut off. */
  app.get('/api/uploads/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    await settle(id)
    await completing.get(id)?.catch(() => undefined)
    const row = db.get<UploadRow>('SELECT * FROM uploads WHERE id = ?', [id])
    if (row && row.created_by === req.member.id && row.state === 'done' && row.file_id) {
      return ok({ id, state: 'done', received: row.size, size: row.size, chunkSize: LIMITS.uploadChunkBytes, fileId: row.file_id })
    }
    const u = loadUpload(req, id)
    return ok({ id: u.id, state: 'active', received: u.received_bytes, size: u.size, chunkSize: LIMITS.uploadChunkBytes })
  })

  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
    scoped.put('/api/uploads/:id', { ...auth, bodyLimit: LIMITS.uploadChunkBytes + 1024 }, async (req) => {
      const { id } = req.params as { id: string }
      await settle(id)
      const u = loadUpload(req, id)
      const { offset } = parse(z.object({ offset: z.coerce.number().int().min(0) }), req.query)
      if (offset !== u.received_bytes) throw new AppError('CONFLICT', `offset mismatch: server has ${u.received_bytes}`, 409)
      let written = 0
      const body = req.body as Readable
      const out = createWriteStream(u.temp_path, { flags: 'a' })
      const closed = new Promise<void>((r) => out.once('close', () => r()))
      const work = pipeline(
        body,
        async function* (src: AsyncIterable<Buffer>) {
          for await (const chunk of src) {
            written += chunk.length
            if (u.received_bytes + written > u.size) throw badRequest('파일 크기를 넘었습니다.')
            yield chunk
          }
        },
        out
      )
      const entry = { done: work.then(() => closed, () => closed), abort: () => void body.destroy(new Error('superseded')) }
      writing.set(id, entry)
      try {
        await work
      } catch (e) {
        if (e instanceof AppError) throw e
        // The connection dropped in the middle of a chunk: what arrived stays, the client continues from there.
        throw new AppError('CONFLICT', '전송이 끊겼습니다. 이어서 보내 주세요.', 409)
      } finally {
        await entry.done
        if (writing.get(id) === entry) writing.delete(id)
      }
      const received = u.received_bytes + written
      db.run('UPDATE uploads SET received_bytes = ?, updated_at = ? WHERE id = ?', [received, Date.now(), u.id])
      return ok({ id: u.id, received, size: u.size })
    })
  })

  const finishUpload = async (req: FastifyRequest, u: UploadRow): Promise<UploadResult> => {
    const folder = loadFolder(req, u.folder_id)
    // Same name in the same folder = new version of that file (6.6).
    const findTarget = (): FileRow | undefined =>
      (u.file_id ? db.get<FileRow>(`${FILE_SELECT} WHERE x.id = ? AND x.deleted_at IS NULL`, [u.file_id]) : undefined) ||
      db.get<FileRow>(`${FILE_SELECT} WHERE x.folder_id = ? AND x.name = ? AND x.deleted_at IS NULL`, [folder.id, u.name])
    // checked before the received file is moved into the store, so a refused upload can be completed later
    const locked = findTarget()
    if (locked?.locked_by && locked.locked_by !== req.member.id) throw new AppError('LOCKED', `${locked.locked_by_name}님이 편집 중입니다.`, 423)
    const hash = createHash('sha256')
    for await (const c of createReadStream(u.temp_path)) hash.update(c as Buffer)
    const sha = hash.digest('hex')
    const blob = adoptFile(ctx, u.temp_path, sha, u.size)
    const t = Date.now()
    const target = findTarget()
    let fileId: string
    db.tx(() => {
      if (target) {
        if (target.locked_by && target.locked_by !== req.member.id) throw new AppError('LOCKED', `${target.locked_by_name}님이 편집 중입니다.`, 423)
        fileId = target.id
        const vid = newId()
        const no = target.version_count + 1
        db.run('INSERT INTO file_versions (id, file_id, version_no, blob_id, size, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [vid, fileId, no, blob.id, u.size, u.note, req.member.id, t])
        db.run('UPDATE files SET current_version_id = ?, size = ?, version_count = ?, updated_by = ?, updated_at = ? WHERE id = ?', [vid, u.size, no, req.member.id, t, fileId])
      } else {
        fileId = newId()
        const vid = newId()
        db.run(
          `INSERT INTO files (id, folder_id, root_id, name, current_version_id, size, version_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [fileId, folder.id, folder.root_id, u.name, vid, u.size, req.member.id, req.member.id, t, t]
        )
        db.run('INSERT INTO file_versions (id, file_id, version_no, blob_id, size, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)', [vid, fileId, blob.id, u.size, u.note, req.member.id, t])
      }
      addRef(ctx, blob.id, 1)
      // file_id now names the resulting file, for a client that lost the answer and asks again
      db.run(`UPDATE uploads SET state = 'done', file_id = ?, updated_at = ? WHERE id = ?`, [fileId, t, u.id])
    })
    logActivity(ctx, req, target ? 'file.version' : 'file.upload', { type: 'file', id: fileId! }, { name: u.name, size: u.size })
    notifyRoot(folder.root_id)
    return { file: toFile(db.get<FileRow>(`${FILE_SELECT} WHERE x.id = ?`, [fileId!])!), sha256: sha, newVersion: !!target }
  }

  app.post('/api/uploads/:id/complete', auth, async (req) => {
    const { id } = req.params as { id: string }
    await settle(id)
    // hashing a large file takes a while; a retry joins the run that is already going
    const running = completing.get(id)
    if (running) return ok(await running)
    const u = loadUpload(req, id)
    if (u.received_bytes !== u.size) throw badRequest(`아직 다 받지 못했습니다 (${u.received_bytes}/${u.size}).`)
    const p = finishUpload(req, u).finally(() => completing.delete(id))
    completing.set(id, p)
    return ok(await p)
  })

  app.delete('/api/uploads/:id', auth, async (req) => {
    await settle((req.params as { id: string }).id)
    const u = loadUpload(req, (req.params as { id: string }).id)
    rmSync(u.temp_path, { force: true })
    db.run(`UPDATE uploads SET state = 'aborted', updated_at = ? WHERE id = ?`, [Date.now(), u.id])
    return ok({ id: u.id })
  })

  /** Download with HTTP Range support (resumable downloads, 13.13 streams only). */
  app.get('/api/files/:id/download', auth, async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = parse(z.object({ version: z.string().optional(), inline: z.string().optional() }), req.query)
    const f = loadFile(req, id)
    const vid = q.version ?? f.current_version_id
    const v = db.get<{ id: string; blob_id: string; size: number }>('SELECT id, blob_id, size FROM file_versions WHERE id = ? AND file_id = ?', [vid, id])
    if (!v) throw notFound('버전')
    const blob = db.get<BlobRow>('SELECT * FROM blobs WHERE id = ?', [v.blob_id])
    if (!blob || !existsSync(blobAbsPath(ctx, blob))) throw notFound('파일')
    return sendRange(
      req,
      reply,
      blobAbsPath(ctx, blob),
      v.size,
      f.name,
      q.inline === '1',
      () => {
        db.run('INSERT INTO file_downloads (id, file_id, file_version_id, member_id, at) VALUES (?, ?, ?, ?, ?)', [newId(), id, v.id, req.member.id, Date.now()])
      },
      `"${blob.sha256}"`
    )
  })

  app.get('/api/files/:id/downloads', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    if (f.created_by !== req.member.id && !canManageRoot(rootOf(f.root_id)!, req.member)) throw forbidden()
    return ok(
      db.all<{ name: string; at: number; version_no: number }>(
        `SELECT m.name, d.at, v.version_no FROM file_downloads d JOIN members m ON m.id = d.member_id JOIN file_versions v ON v.id = d.file_version_id WHERE d.file_id = ? ORDER BY d.at DESC LIMIT 200`,
        [id]
      )
    )
  })

  app.post('/api/files/:id/lock', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    if (!canWriteRoot(rootOf(f.root_id)!, req.member)) throw forbidden()
    if (f.locked_by && f.locked_by !== req.member.id) throw new AppError('LOCKED', `${f.locked_by_name}님이 이미 편집 중입니다.`, 423)
    db.run('UPDATE files SET locked_by = ?, locked_at = ? WHERE id = ?', [req.member.id, Date.now(), id])
    logActivity(ctx, req, 'file.lock', { type: 'file', id })
    notifyRoot(f.root_id)
    return ok({ id })
  })

  app.delete('/api/files/:id/lock', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    if (f.locked_by && f.locked_by !== req.member.id && !canManageRoot(rootOf(f.root_id)!, req.member)) throw forbidden('편집 중인 사람만 풀 수 있습니다.')
    db.run('UPDATE files SET locked_by = NULL, locked_at = NULL WHERE id = ?', [id])
    logActivity(ctx, req, 'file.unlock', { type: 'file', id })
    notifyRoot(f.root_id)
    return ok({ id })
  })

  app.patch('/api/files/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    const p = parse(z.object({ name: z.string().trim().min(1).max(200).optional(), folderId: z.string().optional() }), req.body)
    if (f.created_by !== req.member.id && !canManageRoot(rootOf(f.root_id)!, req.member)) throw forbidden()
    if (p.folderId) {
      const dest = loadFolder(req, p.folderId)
      if (dest.root_id !== f.root_id) throw badRequest('같은 최상위 폴더 안에서만 옮길 수 있습니다.')
    }
    const name = p.name ? assertName(p.name) : f.name
    const folderId = p.folderId ?? f.folder_id
    if (db.get('SELECT 1 FROM files WHERE folder_id = ? AND name = ? AND id != ? AND deleted_at IS NULL', [folderId, name, id])) throw conflict('같은 이름의 파일이 있습니다.')
    db.run('UPDATE files SET name = ?, folder_id = ?, updated_at = ? WHERE id = ?', [name, folderId, Date.now(), id])
    logActivity(ctx, req, 'file.update', { type: 'file', id }, p)
    notifyRoot(f.root_id)
    return ok({ id })
  })

  app.delete('/api/files/:id', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    if (f.created_by !== req.member.id && !canManageRoot(rootOf(f.root_id)!, req.member)) throw forbidden('올린 사람만 지울 수 있습니다.')
    if (f.locked_by && f.locked_by !== req.member.id) throw new AppError('LOCKED', `${f.locked_by_name}님이 편집 중입니다.`, 423)
    db.run('UPDATE files SET deleted_at = ?, deleted_by = ? WHERE id = ?', [Date.now(), req.member.id, id])
    logActivity(ctx, req, 'file.delete', { type: 'file', id }, { name: f.name })
    notifyRoot(f.root_id)
    return ok({ id })
  })

  /** Make an old version current again (as a new version that reuses the same blob). */
  app.post('/api/files/:id/restore-version', auth, async (req) => {
    const { id } = req.params as { id: string }
    const f = loadFile(req, id)
    if (!canWriteRoot(rootOf(f.root_id)!, req.member)) throw forbidden()
    if (f.locked_by && f.locked_by !== req.member.id) throw new AppError('LOCKED', `${f.locked_by_name}님이 편집 중입니다.`, 423)
    const { versionId } = parse(z.object({ versionId: z.string() }), req.body)
    const v = db.get<{ blob_id: string; size: number; version_no: number }>('SELECT blob_id, size, version_no FROM file_versions WHERE id = ? AND file_id = ?', [versionId, id])
    if (!v) throw notFound('버전')
    const vid = newId()
    const no = f.version_count + 1
    const t = Date.now()
    db.tx(() => {
      db.run('INSERT INTO file_versions (id, file_id, version_no, blob_id, size, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [vid, id, no, v.blob_id, v.size, `v${v.version_no} 복원`, req.member.id, t])
      db.run('UPDATE files SET current_version_id = ?, size = ?, version_count = ?, updated_by = ?, updated_at = ? WHERE id = ?', [vid, v.size, no, req.member.id, t, id])
      addRef(ctx, v.blob_id, 1)
    })
    logActivity(ctx, req, 'file.restore-version', { type: 'file', id }, { from: v.version_no })
    notifyRoot(f.root_id)
    return ok({ id, versionNo: no })
  })

  // ---- trash (30 days) ----
  const visibleTrash = (req: FastifyRequest): TrashItemDto[] => {
    const cutoff = Date.now() - TRASH_DAYS * 86400000
    const admin = req.member.role === 'admin'
    const files = db.all<FileRow & { deleted_by_name: string | null }>(
      `${FILE_SELECT.replace('FROM files x', ', CASE WHEN IFNULL(LENGTH(d.nickname), 0) = 0 THEN d.name ELSE d.name || char(40) || d.nickname || char(41) END AS deleted_by_name FROM files x')} LEFT JOIN members d ON d.id = x.deleted_by WHERE x.deleted_at IS NOT NULL AND x.deleted_at > ?`,
      [cutoff]
    )
    const folders = db.all<FolderRow & { deleted_by: string | null; deleted_by_name: string | null }>(
      `SELECT f.*, CASE WHEN IFNULL(LENGTH(m.nickname), 0) = 0 THEN m.name ELSE m.name || char(40) || m.nickname || char(41) END AS created_by_name, CASE WHEN IFNULL(LENGTH(d.nickname), 0) = 0 THEN d.name ELSE d.name || char(40) || d.nickname || char(41) END AS deleted_by_name FROM folders f JOIN members m ON m.id = f.created_by LEFT JOIN members d ON d.id = f.deleted_by WHERE f.deleted_at IS NOT NULL AND f.deleted_at > ?`,
      [cutoff]
    )
    const out: TrashItemDto[] = []
    for (const f of files) {
      if (!rootVisible(f.root_id, req.member)) continue
      if (!admin && f.created_by !== req.member.id && (f as unknown as { deleted_by: string }).deleted_by !== req.member.id) continue
      const folder = db.get<FolderRow>(`${FOLDER_SELECT} WHERE f.id = ?`, [f.folder_id])
      out.push({ type: 'file', id: f.id, name: f.name, size: f.size, deletedAt: f.deleted_at!, deletedByName: f.deleted_by_name, location: folder ? breadcrumb(folder).map((b) => b.name).join(' / ') : '' })
    }
    for (const f of folders) {
      if (!rootVisible(f.root_id, req.member)) continue
      if (!admin && f.created_by !== req.member.id && f.deleted_by !== req.member.id) continue
      out.push({ type: 'folder', id: f.id, name: f.name, size: 0, deletedAt: f.deleted_at!, deletedByName: f.deleted_by_name, location: breadcrumb(f).slice(0, -1).map((b) => b.name).join(' / ') })
    }
    return out.sort((a, b) => b.deletedAt - a.deletedAt)
  }

  app.get('/api/trash', auth, async (req) => ok(visibleTrash(req)))

  app.post('/api/trash/:type/:id/restore', auth, async (req) => {
    const { type, id } = req.params as { type: string; id: string }
    if (!visibleTrash(req).some((t) => t.type === type && t.id === id)) throw notFound('휴지통 항목')
    const table = type === 'folder' ? 'folders' : 'files'
    const row = db.get<{ root_id: string; name: string; folder_id?: string; parent_id?: string }>(`SELECT * FROM ${table} WHERE id = ?`, [id])!
    if (type === 'file' && db.get('SELECT 1 FROM files WHERE folder_id = ? AND name = ? AND deleted_at IS NULL', [row.folder_id!, row.name])) {
      throw conflict('같은 이름의 파일이 이미 있어 복원할 수 없습니다. 기존 파일 이름을 바꾸세요.')
    }
    db.run(`UPDATE ${table} SET deleted_at = NULL, deleted_by = NULL WHERE id = ?`, [id])
    logActivity(ctx, req, `${type}.restore`, { type, id })
    notifyRoot(row.root_id)
    return ok({ id })
  })

  app.delete('/api/trash/:type/:id', auth, async (req) => {
    const { type, id } = req.params as { type: string; id: string }
    if (!visibleTrash(req).some((t) => t.type === type && t.id === id)) throw notFound('휴지통 항목')
    if (type === 'file') purgeFile(db, ctx, id)
    else purgeFolder(db, ctx, id)
    logActivity(ctx, req, `${type}.purge`, { type, id })
    return ok({ id })
  })
}

function purgeFile(db: Db, ctx: ServerContext, id: string): void {
  for (const v of db.all<{ blob_id: string }>('SELECT blob_id FROM file_versions WHERE file_id = ?', [id])) addRef(ctx, v.blob_id, -1)
  db.run('DELETE FROM file_downloads WHERE file_id = ?', [id])
  db.run('DELETE FROM files WHERE id = ?', [id])
}

function purgeFolder(db: Db, ctx: ServerContext, id: string): void {
  for (const c of db.all<{ id: string }>('SELECT id FROM folders WHERE parent_id = ?', [id])) purgeFolder(db, ctx, c.id)
  for (const f of db.all<{ id: string }>('SELECT id FROM files WHERE folder_id = ?', [id])) purgeFile(db, ctx, f.id)
  db.run(`DELETE FROM scope_targets WHERE item_type = 'folder' AND item_id = ?`, [id])
  db.run('DELETE FROM folders WHERE id = ?', [id])
}

/** Daily cleanup: empty old trash, drop stale uploads, delete unreferenced blobs. */
export function runFileJobs(ctx: ServerContext, now = Date.now()): void {
  const db = ctx.db
  const cutoff = now - TRASH_DAYS * 86400000
  for (const f of db.all<{ id: string }>('SELECT id FROM files WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff])) purgeFile(db, ctx, f.id)
  for (const f of db.all<{ id: string }>('SELECT id FROM folders WHERE deleted_at IS NOT NULL AND deleted_at < ?', [cutoff])) purgeFolder(db, ctx, f.id)
  for (const u of db.all<{ id: string; temp_path: string }>(`SELECT id, temp_path FROM uploads WHERE state = 'active' AND updated_at < ?`, [now - STALE_UPLOAD_MS])) {
    rmSync(u.temp_path, { force: true })
    db.run(`UPDATE uploads SET state = 'aborted' WHERE id = ?`, [u.id])
  }
  sweepUnreferenced(ctx, 24 * 3600 * 1000, now)
}

/**
 * Stream a file with optional Range (206 Partial Content).
 * With an etag, a client resuming a download sends it back as If-Range: when the content is no
 * longer the same (a new version was uploaded meanwhile) it gets the whole file instead of a
 * piece that would not fit what it already has.
 */
export function sendRange(req: FastifyRequest, reply: FastifyReply, path: string, size: number, name: string, inline: boolean, onFull?: () => void, etag?: string): FastifyReply {
  const ifRange = req.headers['if-range']
  const range = !ifRange || (etag && ifRange === etag) ? req.headers.range : undefined
  void reply.header('Accept-Ranges', 'bytes').header('Content-Disposition', contentDisposition(name, inline)).header('Content-Type', 'application/octet-stream')
  if (etag) void reply.header('ETag', etag)
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]))
    let end = m[1] && m[2] ? Number(m[2]) : size - 1
    if (start >= size || start > end) {
      return reply.status(416).header('Content-Range', `bytes */${size}`).send()
    }
    end = Math.min(end, size - 1)
    start = Math.max(0, start)
    if (start === 0) onFull?.()
    return reply
      .status(206)
      .header('Content-Range', `bytes ${start}-${end}/${size}`)
      .header('Content-Length', String(end - start + 1))
      .send(createReadStream(path, { start, end }))
  }
  onFull?.()
  return reply.header('Content-Length', String(size)).send(createReadStream(path))
}
