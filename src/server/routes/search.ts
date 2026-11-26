import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import { z } from 'zod'
import type { ServerContext } from '../context'
import { parse, ok } from '../validate'
import { visibleWhere } from '../scope'
import { deptPathOf } from '../repos/members'
import { deptPathText } from '../../shared/org'
import { choseongOr } from '../choseong'

export interface SearchResultDto {
  type: 'notice' | 'event' | 'doc' | 'post' | 'file' | 'message' | 'contact' | 'member' | 'worklog'
  id: string
  title: string
  snippet: string
  route: string
  at: number
}

const strip = (html: string): string =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

/** Text around the first hit, so the user sees why it matched. */
export function snippetOf(text: string, q: string, len = 90): string {
  const t = strip(text)
  const i = t.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return t.slice(0, len)
  const s = Math.max(0, i - 30)
  return `${s > 0 ? '…' : ''}${t.slice(s, s + len)}${s + len < t.length ? '…' : ''}`
}

/**
 * Unified search (6.15, M8-2): everything the member may see, using the same scope rules
 * as each feature (13.9). At 10–50 people a LIKE scan is fast enough (see test), so no
 * separate index has to be kept in sync.
 */
export function registerSearchRoutes(app: FastifyInstance, ctx: ServerContext, guards: { requireAuth: preHandlerAsyncHookHandler }): void {
  const db = ctx.db
  app.get('/api/search', { preHandler: guards.requireAuth }, async (req) => {
    const { q, limit } = parse(z.object({ q: z.string().trim().min(1).max(100), limit: z.coerce.number().int().min(1).max(50).default(12) }), req.query)
    const me = req.member.id
    const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    const E = `ESCAPE '\\'`
    const out: SearchResultDto[] = []
    const add = (rows: SearchResultDto[]): void => void out.push(...rows)
    // 초성 검색 ("ㄱㅈㅎㅎ", "홍ㄱㄷ"): titles and names only, never bodies or messages
    const cho = (...cols: string[]): { sql: string; params: string[] } => choseongOr(q, cols)

    {
      const w = visibleWhere('n', 'notice', me)
      const c = cho('n.title')
      add(
        db
          .all<{ id: string; title: string; body_html: string; t: number }>(
            `SELECT n.id, n.title, n.body_html, COALESCE(n.published_at, n.created_at) AS t FROM notices n WHERE n.deleted_at IS NULL AND (n.published_at IS NOT NULL OR n.created_by = ?) AND ${w.sql} AND (n.title LIKE ? ${E} OR n.body_html LIKE ? ${E}${c.sql}) ORDER BY t DESC LIMIT ?`,
            [me, ...w.params, like, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'notice', id: r.id, title: r.title, snippet: snippetOf(r.body_html, q), route: `/notices/${r.id}`, at: r.t }))
      )
    }
    {
      const w = visibleWhere('e', 'event', me)
      const c = cho('e.title')
      add(
        db
          .all<{ id: string; title: string; body_html: string; start_at: number }>(
            `SELECT e.id, e.title, e.body_html, e.start_at FROM events e WHERE e.deleted_at IS NULL AND e.kind != 'busy' AND ${w.sql} AND (e.title LIKE ? ${E} OR e.body_html LIKE ? ${E} OR e.location LIKE ? ${E}${c.sql}) ORDER BY e.start_at DESC LIMIT ?`,
            [...w.params, like, like, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'event', id: r.id, title: r.title, snippet: snippetOf(r.body_html, q), route: '/calendar', at: r.start_at }))
      )
    }
    {
      const w = visibleWhere('d', 'doc', me)
      const c = cho('d.title')
      add(
        db
          .all<{ id: string; kind: string; title: string; body_html: string; updated_at: number }>(
            `SELECT d.id, d.kind, d.title, d.body_html, d.updated_at FROM docs d WHERE d.deleted_at IS NULL AND ${w.sql} AND (d.title LIKE ? ${E} OR d.body_html LIKE ? ${E}${c.sql}) ORDER BY d.updated_at DESC LIMIT ?`,
            [...w.params, like, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'doc', id: r.id, title: r.title, snippet: snippetOf(r.body_html, q), route: `/docs/${r.kind}/${r.id}`, at: r.updated_at }))
      )
    }
    {
      const w = visibleWhere('b', 'board', me)
      const c = cho('p.title')
      add(
        db
          .all<{ id: string; board_id: string; title: string; body_html: string; created_at: number }>(
            `SELECT p.id, p.board_id, p.title, p.body_html, p.created_at FROM posts p JOIN boards b ON b.id = p.board_id WHERE p.deleted_at IS NULL AND b.deleted_at IS NULL AND ${w.sql} AND (p.title LIKE ? ${E} OR p.body_html LIKE ? ${E}${c.sql}) ORDER BY p.created_at DESC LIMIT ?`,
            [...w.params, like, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'post', id: r.id, title: r.title, snippet: snippetOf(r.body_html, q), route: `/boards/${r.board_id}/${r.id}`, at: r.created_at }))
      )
    }
    // Tasks (할 일 · 업무 요청) are no longer searched: the feature left the app; its routes and data remain for older PCs.
    {
      // file visibility follows the top-level folder (6.6)
      const w = visibleWhere('r', 'folder', me)
      const c = cho('f.name')
      add(
        db
          .all<{ id: string; name: string; folder_id: string; updated_at: number }>(
            `SELECT f.id, f.name, f.folder_id, f.updated_at FROM files f JOIN folders r ON r.id = f.root_id JOIN folders pf ON pf.id = f.folder_id WHERE f.deleted_at IS NULL AND pf.deleted_at IS NULL AND r.deleted_at IS NULL AND ${w.sql} AND (f.name LIKE ? ${E}${c.sql}) ORDER BY f.updated_at DESC LIMIT ?`,
            [...w.params, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'file', id: r.id, title: r.name, snippet: '', route: `/files/${r.folder_id}`, at: r.updated_at }))
      )
    }
    add(
      db
        .all<{ id: string; conversation_id: string; body: string; created_at: number; title: string | null; sender: string }>(
          `SELECT m.id, m.conversation_id, m.body, m.created_at, c.title, CASE WHEN IFNULL(LENGTH(s.nickname), 0) = 0 THEN s.name ELSE s.name || char(40) || s.nickname || char(41) END AS sender FROM messages m
           JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.member_id = ?
           JOIN conversations c ON c.id = m.conversation_id JOIN members s ON s.id = m.sender_id
           WHERE m.deleted_at IS NULL AND m.kind = 'text' AND m.body LIKE ? ${E} ORDER BY m.created_at DESC LIMIT ?`,
          [me, like, limit]
        )
        .map((r) => ({ type: 'message', id: r.id, title: `${r.sender}${r.title ? ` · ${r.title}` : ''}`, snippet: snippetOf(r.body, q), route: `/chat/${r.conversation_id}`, at: r.created_at }))
    )
    {
      const w = visibleWhere('c', 'contact', me)
      const c = cho('c.name', 'c.org')
      add(
        db
          .all<{ id: string; name: string; org: string | null; updated_at: number }>(
            `SELECT c.id, c.name, c.org, c.updated_at FROM contacts c WHERE c.deleted_at IS NULL AND ${w.sql} AND (c.name LIKE ? ${E} OR c.org LIKE ? ${E} OR c.phone LIKE ? ${E} OR c.memo LIKE ? ${E}${c.sql}) ORDER BY c.name LIMIT ?`,
            [...w.params, like, like, like, like, ...c.params, limit]
          )
          .map((r) => ({ type: 'contact', id: r.id, title: r.name, snippet: r.org ?? '', route: '/directory', at: r.updated_at }))
      )
    }
    const cm = cho('m.name', 'm.nickname', 'm.title')
    const cd = cho('name')
    add(
      db
        .all<{ id: string; name: string; dept_id: string | null; title: string | null; updated_at: number }>(
          // a department name finds the people of that department and of everything below it
          `SELECT m.id, m.name, m.dept_id, m.title, m.updated_at FROM members m WHERE m.status = 'active' AND (m.name LIKE ? ${E} OR m.title LIKE ? ${E}${cm.sql} OR m.dept_id IN (
             WITH RECURSIVE sub(id, lvl) AS (
               SELECT id, 0 FROM departments WHERE name LIKE ? ${E}${cd.sql}
               UNION SELECT c.id, sub.lvl + 1 FROM departments c JOIN sub ON c.parent_id = sub.id WHERE sub.lvl < 20
             ) SELECT id FROM sub)) ORDER BY m.name LIMIT ?`,
          [like, like, ...cm.params, like, ...cd.params, limit]
        )
        .map((r) => ({ type: 'member', id: r.id, title: r.name, snippet: [r.dept_id ? deptPathText(deptPathOf(db, r.dept_id)) : '', r.title].filter(Boolean).join(' · '), route: '/directory', at: r.updated_at }))
    )
    {
      const w = visibleWhere('w', 'worklog', me)
      add(
        db
          .all<{ id: string; date: string; name: string; text: string; updated_at: number }>(
            `SELECT w.id, w.date, m.name, (w.done_html || ' ' || w.todo_html || ' ' || w.notes_html) AS text, w.updated_at FROM worklogs w JOIN members m ON m.id = w.member_id WHERE ${w.sql} AND (w.done_html LIKE ? ${E} OR w.todo_html LIKE ? ${E} OR w.notes_html LIKE ? ${E}) ORDER BY w.date DESC LIMIT ?`,
            [...w.params, like, like, like, limit]
          )
          .map((r) => ({ type: 'worklog', id: r.id, title: `${r.name} 업무일지 ${r.date}`, snippet: snippetOf(r.text, q), route: '/diary', at: r.updated_at }))
      )
    }
    return ok(out)
  })
}
