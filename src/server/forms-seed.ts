import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { z } from 'zod'
import { newId } from '../node/sqlite'
import type { ServerContext } from './context'
import { readSetting, writeSetting } from './settings'
import { addRef, adoptFile, filesRoot } from './storage/blobs'

/**
 * "서식자료실": official forms shipped with the program (resources/forms) are put into a
 * team folder of the file library when the server starts.
 *
 * It runs once per version of the shipped set (resources/forms/index.json `version`), so
 * what a team deletes or renames afterwards is not brought back at every start. When a
 * newer program ships a changed form, that file gets a new version; nothing is removed.
 */

const indexSchema = z.object({
  version: z.number().int().positive(),
  folder: z.string().min(1).max(100),
  sets: z.array(
    z.object({
      id: z.string(),
      name: z.string().min(1).max(100),
      law: z.string(),
      revision: z.string(),
      source: z.string(),
      sourceUrl: z.string(),
      fetchedAt: z.string(),
      files: z.array(z.object({ name: z.string().min(1).max(200), file: z.string().regex(/^[\w./-]+$/), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/), title: z.string() }))
    })
  )
})
export type FormsIndex = z.infer<typeof indexSchema>

const SETTING = 'formsSeed'
const NOTE = '프로그램에 들어 있는 공식 서식'

export interface FormsSeedResult {
  folderId: string | null
  added: number
  updated: number
  skipped?: string
}

const readme = (ix: FormsIndex): string =>
  [
    '서식자료실 안내',
    '',
    '이 폴더의 서식은 TeamHub 프로그램에 함께 들어 있는 공식 서식 원본입니다.',
    '내용을 고치지 않은 원본이며, 프로그램이 새 서식을 담아 업데이트되면 해당 파일에 새 버전으로 추가됩니다.',
    '',
    ...ix.sets.flatMap((s) => [`■ ${s.name} (${s.files.length}개)`, `  근거: ${s.law}`, `  기준: ${s.revision}`, `  출처: ${s.source}`, `  받은 날: ${s.fetchedAt}`, '']),
    '주의',
    '- 법령은 개정됩니다. 중요한 문서를 만들기 전에 국가법령정보센터(https://www.law.go.kr)에서 지금 시행 중인 서식인지 확인하세요.',
    '- 기관에서 따로 정한 서식(자체 규정·전자문서시스템 서식)이 있으면 그것을 따르세요.',
    '- 이 폴더에는 팀에서 쓰는 다른 서식을 자유롭게 더 올릴 수 있습니다.',
    ''
  ].join('\r\n')

/** `dir`: resources/forms of the program. Safe to call at every start. */
export function seedForms(ctx: ServerContext, dir: string | undefined): FormsSeedResult {
  const none = (skipped: string): FormsSeedResult => ({ folderId: null, added: 0, updated: 0, skipped })
  if (!dir || !existsSync(join(dir, 'index.json'))) return none('no forms shipped')
  const ix = indexSchema.parse(JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')))
  const done = readSetting<{ version: number }>(ctx.db, SETTING)
  if (done && done.version >= ix.version) return none('already seeded')
  // the folder belongs to the first administrator (the server PC's own account)
  const admin = ctx.db.get<{ id: string }>(`SELECT id FROM members WHERE role = 'admin' ORDER BY created_at LIMIT 1`)
  if (!admin) return none('server not set up yet')

  const db = ctx.db
  const t = Date.now()
  const tmpDir = join(filesRoot(ctx), 'tmp')
  mkdirSync(tmpDir, { recursive: true })
  let added = 0
  let updated = 0

  /** Put one file into a folder: new file, new version when the content changed, nothing when it is the same. */
  const put = (folder: { id: string; root_id: string }, name: string, data: Buffer): void => {
    const sha = createHash('sha256').update(data).digest('hex')
    const cur = db.get<{ id: string; version_count: number; sha256: string | null }>(
      `SELECT x.id, x.version_count, b.sha256 FROM files x LEFT JOIN file_versions v ON v.id = x.current_version_id LEFT JOIN blobs b ON b.id = v.blob_id WHERE x.folder_id = ? AND x.name = ? AND x.deleted_at IS NULL`,
      [folder.id, name]
    )
    if (cur?.sha256 === sha) return
    const tmp = join(tmpDir, `${newId()}.part`)
    writeFileSync(tmp, data)
    const blob = adoptFile(ctx, tmp, sha, data.length)
    const vid = newId()
    if (cur) {
      const no = cur.version_count + 1
      db.run('INSERT INTO file_versions (id, file_id, version_no, blob_id, size, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [vid, cur.id, no, blob.id, data.length, NOTE, admin.id, t])
      db.run('UPDATE files SET current_version_id = ?, size = ?, version_count = ?, updated_by = ?, updated_at = ? WHERE id = ?', [vid, data.length, no, admin.id, t, cur.id])
      updated++
    } else {
      const fid = newId()
      db.run(`INSERT INTO files (id, folder_id, root_id, name, current_version_id, size, version_count, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, [fid, folder.id, folder.root_id, name, vid, data.length, admin.id, admin.id, t, t])
      db.run('INSERT INTO file_versions (id, file_id, version_no, blob_id, size, note, created_by, created_at) VALUES (?, ?, 1, ?, ?, ?, ?, ?)', [vid, fid, blob.id, data.length, NOTE, admin.id, t])
      added++
    }
    addRef(ctx, blob.id, 1)
  }

  // read everything first: a broken package must not leave half a folder behind
  const base = resolve(dir)
  const sets = ix.sets.map((s) => ({
    set: s,
    files: s.files.map((f) => {
      const abs = resolve(base, f.file)
      if (!abs.startsWith(base + sep)) throw new Error(`forms: bad path ${f.file}`)
      const data = readFileSync(abs)
      if (createHash('sha256').update(data).digest('hex') !== f.sha256) throw new Error(`forms: ${f.file} does not match its checksum`)
      return { name: f.name, data }
    })
  }))

  let rootId = ''
  db.tx(() => {
    const root = db.get<{ id: string }>(`SELECT id FROM folders WHERE parent_id IS NULL AND name = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1`, [ix.folder])
    rootId = root?.id ?? newId()
    if (!root) {
      // everyone in the team reads it and may add the team's own forms
      db.run(`INSERT INTO folders (id, parent_id, root_id, name, scope_type, write_policy, created_by, created_at, updated_at) VALUES (?, NULL, ?, ?, 'team', 'all', ?, ?, ?)`, [rootId, rootId, ix.folder, admin.id, t, t])
    }
    const rootFolder = db.get<{ scope_type: string; write_policy: string }>('SELECT scope_type, write_policy FROM folders WHERE id = ?', [rootId])!
    for (const { set, files } of sets) {
      const sub = db.get<{ id: string }>(`SELECT id FROM folders WHERE parent_id = ? AND name = ? AND deleted_at IS NULL`, [rootId, set.name])
      const subId = sub?.id ?? newId()
      if (!sub) db.run(`INSERT INTO folders (id, parent_id, root_id, name, scope_type, write_policy, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [subId, rootId, rootId, set.name, rootFolder.scope_type, rootFolder.write_policy, admin.id, t, t])
      for (const f of files) put({ id: subId, root_id: rootId }, f.name, f.data)
    }
    put({ id: rootId, root_id: rootId }, '서식자료실 안내.txt', Buffer.from('﻿' + readme(ix), 'utf8'))
    writeSetting(db, SETTING, { version: ix.version, at: t })
  })
  return { folderId: rootId, added, updated }
}
