import { app, dialog, shell } from 'electron'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { z } from 'zod'
import { handle } from './registry'
import { localDb } from '../localdb'
import { isProtected, listDir, mkdir, openItem, places, properties, recentFolders, rename, revealItem, setPin, transfer, trash } from '../files/fm'
import { addIndexRoot, indexRoots, removeIndexRoot, rescan, searchFiles, watchNow } from '../files'
import { bookmarkInputSchema, parseBookmarkHtml, parseChromeBookmarks, resolveSmart, toBookmarkHtml, type TaggedItem } from '../../shared/organize'
import { htmlToMarkdown } from '../../shared/notes'

const P = z.string().min(1).max(2000)
const paths = z.array(P).max(5000)
const searchSchema = z.object({
  q: z.string().max(200),
  category: z.enum(['', 'folder', 'doc', 'sheet', 'slide', 'pdf', 'image', 'video', 'audio', 'archive', 'exe', 'text', 'other']).optional(),
  ext: z.string().max(20).optional(),
  minSize: z.number().optional(),
  maxSize: z.number().optional(),
  modifiedAfter: z.number().optional(),
  modifiedBefore: z.number().optional(),
  under: z.string().max(2000).optional(),
  limit: z.number().int().max(2000).optional()
})
const smartSchema = searchSchema.omit({ modifiedAfter: true, modifiedBefore: true }).extend({ modifiedWithinDays: z.number().int().max(3650).optional(), olderThanDays: z.number().int().max(3650).optional() })

function items(list: { path: string; note?: string }[]): TaggedItem[] {
  const tags = localDb().organize.tagsOf(list.map((l) => l.path))
  return list.map((l) => {
    let s: ReturnType<typeof statSync> | null
    try {
      s = statSync(l.path)
    } catch {
      s = null
    }
    return { path: l.path, name: basename(l.path) || l.path, exists: !!s, isDir: !!s?.isDirectory(), size: s && !s.isDirectory() ? s.size : 0, mtime: s?.mtimeMs ?? 0, tags: tags[l.path] ?? [], note: l.note }
  })
}

const BROWSER_FILES: Record<string, string[]> = {
  chrome: ['Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'],
  edge: ['Microsoft', 'Edge', 'User Data', 'Default', 'Bookmarks'],
  whale: ['Naver', 'Naver Whale', 'User Data', 'Default', 'Bookmarks']
}

/** IPC for personal files, search, organization, bookmarks and notes (6.18). Local only. */
export function registerFilesIpc(): void {
  // ---------- explorer ----------
  handle('fm:places', null, () => places())
  handle('fm:list', z.object({ path: P, showHidden: z.boolean() }), ({ path, showHidden }) => listDir(path, showHidden))
  handle('fm:mkdir', z.object({ parent: P, name: z.string().max(255) }), ({ parent, name }) => mkdir(parent, name))
  handle('fm:rename', z.object({ path: P, name: z.string().max(255) }), ({ path, name }) => rename(path, name))
  handle('fm:transfer', z.object({ paths, dest: P, move: z.boolean() }), ({ paths: p, dest, move }) => transfer(p, dest, move))
  handle('fm:trash', z.object({ paths }), ({ paths: p }) => trash(p))
  handle('fm:open', z.object({ path: P }), async ({ path }) => {
    if (process.env.TEAMHUB_E2E) return { ok: true }
    const err = await openItem(path)
    return err ? { ok: false, error: err } : { ok: true }
  })
  handle('fm:reveal', z.object({ path: P }), ({ path }) => revealItem(path))
  handle('fm:props', z.object({ path: P }), ({ path }) => properties(path))
  handle('fm:pin', z.object({ path: P, on: z.boolean() }), ({ path, on }) => setPin(path, on))
  handle('fm:recent', null, () => recentFolders().filter((p) => existsSync(p)))
  handle('fm:isProtected', z.object({ path: P }), ({ path }) => isProtected(path))

  // ---------- fast search ----------
  handle('fsx:roots', null, () => indexRoots())
  handle('fsx:addRoot', z.object({ path: P }), ({ path }) => addIndexRoot(path))
  handle('fsx:removeRoot', z.object({ path: P }), ({ path }) => removeIndexRoot(path))
  handle('fsx:rescan', z.object({ path: P.optional() }), ({ path }) => rescan(path))
  handle('fsx:search', searchSchema, (q) => searchFiles(q))
  handle('fsx:watchNow', null, () => watchNow())

  // ---------- tags, collections, smart folders ----------
  const org = () => localDb().organize
  handle('org:tags', null, () => org().tags())
  handle('org:tagsOf', z.object({ paths }), ({ paths: p }) => org().tagsOf(p))
  handle('org:setTags', z.object({ path: P, tags: z.array(z.string().trim().min(1).max(30)).max(20) }), ({ path, tags }) => org().setTags(path, tags))
  handle('org:addTag', z.object({ paths, tag: z.string().trim().min(1).max(30) }), ({ paths: p, tag }) => org().addTag(p, tag))
  handle('org:updateTag', z.object({ name: z.string(), newName: z.string().trim().min(1).max(30).optional(), color: z.string().regex(/^#[0-9a-f]{6}$/i).optional() }), ({ name, newName, color }) =>
    org().updateTag(name, { name: newName, color })
  )
  handle('org:deleteTag', z.object({ name: z.string() }), ({ name }) => org().deleteTag(name))
  handle('org:tagged', z.object({ tag: z.string() }), ({ tag }) => items(org().pathsWithTag(tag).map((path) => ({ path }))))
  handle('org:collections', null, () => org().collections())
  handle('org:saveCollection', z.object({ id: z.string().optional(), parentId: z.string().nullable().optional(), name: z.string().trim().min(1).max(60), note: z.string().max(2000).optional() }), (c) => org().saveCollection(c))
  handle('org:deleteCollection', z.object({ id: z.string() }), ({ id }) => org().deleteCollection(id))
  handle('org:collectionItems', z.object({ id: z.string() }), ({ id }) => items(org().collectionItems(id)))
  handle('org:addToCollection', z.object({ id: z.string(), paths }), ({ id, paths: p }) => org().addToCollection(id, p))
  handle('org:removeFromCollection', z.object({ id: z.string(), path: P }), ({ id, path }) => org().removeFromCollection(id, path))
  handle('org:setItemNote', z.object({ id: z.string(), path: P, note: z.string().max(500) }), ({ id, path, note }) => org().setItemNote(id, path, note))
  handle('org:smart', null, () => org().smartFolders())
  handle('org:saveSmart', z.object({ id: z.string().optional(), name: z.string().trim().min(1).max(60), query: smartSchema }), (f) => org().saveSmartFolder(f))
  handle('org:deleteSmart', z.object({ id: z.string() }), ({ id }) => org().deleteSmartFolder(id))
  handle('org:runSmart', z.object({ id: z.string() }), ({ id }) => {
    const f = org().smartFolders().find((x) => x.id === id)
    return f ? searchFiles({ limit: 500, ...resolveSmart(f.query) }) : []
  })
  handle('org:forget', z.object({ path: P }), ({ path }) => org().forgetPath(path))

  // ---------- bookmarks ----------
  handle('bm:list', null, () => org().bookmarks())
  handle('bm:save', bookmarkInputSchema, (b) => org().saveBookmark(b))
  handle('bm:delete', z.object({ id: z.string() }), ({ id }) => org().deleteBookmark(id))
  handle('bm:reorder', z.object({ ids: z.array(z.string()).max(5000) }), ({ ids }) => org().reorderBookmarks(ids))
  handle('bm:import', z.object({ items: z.array(z.object({ title: z.string().max(200), url: z.string().max(2000).regex(/^https?:\/\//i), category: z.string().max(60) })).max(5000) }), ({ items: list }) => org().importBookmarks(list))
  handle('bm:importBrowser', z.object({ browser: z.enum(['chrome', 'edge', 'whale']) }), ({ browser }) => {
    const file = join(process.env.LOCALAPPDATA ?? join(app.getPath('home'), 'AppData', 'Local'), ...BROWSER_FILES[browser])
    if (!existsSync(file)) return { ok: false, count: 0, error: '이 PC에서 해당 브라우저의 즐겨찾기를 찾지 못했습니다.' }
    // read-only: the browser's file is never changed
    return { ok: true, count: org().importBookmarks(parseChromeBookmarks(readFileSync(file, 'utf8'))) }
  })
  handle('bm:importHtml', null, async () => {
    const r = await dialog.showOpenDialog({ title: '즐겨찾기 HTML 가져오기', filters: [{ name: '즐겨찾기 HTML', extensions: ['html', 'htm'] }], properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return { ok: false, count: 0 }
    return { ok: true, count: org().importBookmarks(parseBookmarkHtml(readFileSync(r.filePaths[0], 'utf8'))) }
  })
  handle('bm:exportHtml', null, async () => {
    const r = await dialog.showSaveDialog({ title: '사이트 모음 내보내기', defaultPath: join(app.getPath('documents'), 'TeamHub 사이트 모음.html'), filters: [{ name: '즐겨찾기 HTML', extensions: ['html'] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    writeFileSync(r.filePath, toBookmarkHtml(org().bookmarks()), 'utf8')
    return { ok: true, path: r.filePath }
  })
  handle('bm:open', z.object({ url: z.string().max(2000).regex(/^https?:\/\//i) }), async ({ url }) => {
    if (process.env.TEAMHUB_E2E) {
      const g = globalThis as unknown as { __teamhubOpened?: string[] }
      ;(g.__teamhubOpened ??= []).push(url)
    } else await shell.openExternal(url)
  })

  // ---------- notes ----------
  const notes = () => localDb().notes
  const id = z.object({ id: z.string() })
  const cell = z.union([z.string().max(5000), z.number(), z.boolean(), z.array(z.string().max(100)).max(50), z.null()])
  const propsSchema = z.object({
    columns: z.array(z.object({ id: z.string().max(40), name: z.string().max(60), type: z.enum(['text', 'number', 'select', 'multi', 'date', 'check', 'url']), options: z.array(z.string().max(60)).max(100).optional() })).max(50),
    view: z.object({
      type: z.enum(['table', 'board']),
      groupBy: z.string().max(40).optional(),
      sort: z.object({ prop: z.string().max(40), dir: z.enum(['asc', 'desc']) }).nullable().optional(),
      filters: z.array(z.object({ prop: z.string().max(40), op: z.enum(['contains', 'eq', 'neq', 'empty', 'notEmpty', 'gt', 'lt', 'checked', 'unchecked']), value: z.string().max(200).optional() })).max(20).optional()
    })
  })
  handle('notes:tree', null, () => notes().tree())
  handle('notes:trash', null, () => notes().trash())
  handle('notes:get', id, (r) => notes().get(r.id))
  handle('notes:create', z.object({ parentId: z.string().nullable().optional(), kind: z.enum(['page', 'database']).optional(), title: z.string().max(200).optional(), icon: z.string().max(10).optional(), bodyHtml: z.string().max(10_000_000).optional() }), (i) => notes().create(i))
  handle(
    'notes:update',
    z.object({ id: z.string(), title: z.string().max(200).optional(), icon: z.string().max(10).optional(), bodyHtml: z.string().max(10_000_000).optional(), props: propsSchema.optional(), rowValues: z.record(z.string(), cell).optional(), favorite: z.boolean().optional(), isTemplate: z.boolean().optional() }),
    ({ id: nid, ...p }) => notes().update(nid, p)
  )
  handle('notes:move', z.object({ id: z.string(), parentId: z.string().nullable(), index: z.number().int().min(0) }), ({ id: nid, parentId, index }) => notes().move(nid, parentId, index))
  handle('notes:toTrash', id, (r) => notes().moveToTrash(r.id))
  handle('notes:restore', id, (r) => notes().restore(r.id))
  handle('notes:purge', id, (r) => notes().purge(r.id))
  handle('notes:duplicate', z.object({ id: z.string(), parentId: z.string().nullable(), asTemplate: z.boolean().optional() }), (r) => notes().duplicate(r.id, r.parentId, r.asTemplate))
  handle('notes:rows', z.object({ dbId: z.string() }), ({ dbId }) => notes().rows(dbId))
  handle('notes:addRow', z.object({ dbId: z.string(), values: z.record(z.string(), cell).optional(), title: z.string().max(200).optional() }), ({ dbId, values, title }) => notes().addRow(dbId, values, title))
  handle('notes:search', z.object({ q: z.string().max(200) }), ({ q }) => notes().search(q))
  handle('notes:export', z.object({ id: z.string(), format: z.enum(['html', 'md']) }), async ({ id: nid, format }) => {
    const n = notes().get(nid)
    if (!n) return { ok: false, error: '페이지가 없습니다.' }
    const safe = (n.title || '제목 없음').replace(/[\\/:*?"<>|]/g, '_')
    const r = await dialog.showSaveDialog({ title: '페이지 내보내기', defaultPath: join(app.getPath('documents'), `${safe}.${format}`), filters: [{ name: format === 'md' ? 'Markdown' : 'HTML', extensions: [format] }] })
    if (r.canceled || !r.filePath) return { ok: false }
    const body =
      format === 'md'
        ? `# ${n.icon ? `${n.icon} ` : ''}${n.title}\n\n${htmlToMarkdown(n.bodyHtml)}\n`
        : `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${safe}</title></head><body><h1>${n.icon} ${n.title.replace(/</g, '&lt;')}</h1>${n.bodyHtml}</body></html>`
    writeFileSync(r.filePath, body, 'utf8')
    return { ok: true, path: r.filePath }
  })
}
