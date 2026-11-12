import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify'
import fastifyStatic from '@fastify/static'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { z } from 'zod'
import { newId } from '../../node/sqlite'
import { compareVersions, SEMVER_RE } from '../../shared/semver'
import type { ServerContext } from '../context'
import { badRequest, conflict, notFound } from '../errors'
import { parse, ok } from '../validate'
import { logActivity } from '../activity'
import { getSection } from '../settings'
import { DOWNLOAD_SITE } from '../../shared/constants'

export interface ReleaseRow {
  id: string
  version: string
  notes: string
  file_name: string
  sha512: string
  size: number
  mandatory: number
  state: 'published' | 'withdrawn'
  published_at: number
}

export interface ReleaseDto {
  id: string
  version: string
  notes: string
  fileName: string
  sha512: string
  size: number
  mandatory: boolean
  state: 'published' | 'withdrawn'
  publishedAt: number
}

const toDto = (r: ReleaseRow): ReleaseDto => ({
  id: r.id,
  version: r.version,
  notes: r.notes,
  fileName: r.file_name,
  sha512: r.sha512,
  size: r.size,
  mandatory: !!r.mandatory,
  state: r.state,
  publishedAt: r.published_at
})

export function updatesDir(ctx: ServerContext): string {
  const dir = join(ctx.dataDir, 'updates')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function latestRelease(ctx: ServerContext): ReleaseRow | undefined {
  const rows = ctx.db.all<ReleaseRow>(`SELECT * FROM app_releases WHERE state = 'published'`)
  return rows.sort((a, b) => compareVersions(b.version, a.version))[0]
}

/** electron-updater generic feed manifest. */
export function buildLatestYml(r: Pick<ReleaseRow, 'version' | 'file_name' | 'sha512' | 'size' | 'published_at'>): string {
  const date = new Date(r.published_at).toISOString()
  return [
    `version: ${r.version}`,
    'files:',
    `  - url: ${r.file_name}`,
    `    sha512: ${r.sha512}`,
    `    size: ${r.size}`,
    `path: ${r.file_name}`,
    `sha512: ${r.sha512}`,
    `releaseDate: '${date}'`,
    ''
  ].join('\n')
}

export function writeLatestYml(ctx: ServerContext): ReleaseRow | undefined {
  const dir = updatesDir(ctx)
  const latest = latestRelease(ctx)
  const file = join(dir, 'latest.yml')
  if (!latest) {
    rmSync(file, { force: true })
    return undefined
  }
  writeFileSync(file, buildLatestYml(latest), 'utf8')
  return latest
}

function safeFileName(name: string): string {
  const base = name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '-').trim()
  if (!/\.exe$/i.test(base)) throw badRequest('설치 파일(.exe)만 올릴 수 있습니다.')
  return base
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

export function registerUpdateRoutes(
  app: FastifyInstance,
  ctx: ServerContext,
  guards: { requireAuth: preHandlerAsyncHookHandler; requireAdmin: preHandlerAsyncHookHandler }
): void {
  const pre = { preHandler: [guards.requireAuth, guards.requireAdmin] }

  void app.register(fastifyStatic, {
    root: updatesDir(ctx),
    prefix: '/updates/',
    decorateReply: false,
    cacheControl: false,
    // latest.yml must never be cached; installers are immutable per version
    setHeaders: (res, path) => {
      if (path.endsWith('.yml')) void res.header('Cache-Control', 'no-store')
    }
  })

  app.get('/api/updates/latest', { preHandler: guards.requireAuth }, async () => {
    const r = latestRelease(ctx)
    return ok(r ? { version: r.version, notes: r.notes, mandatory: !!r.mandatory, fileName: r.file_name, size: r.size } : null)
  })

  app.get('/api/admin/releases', pre, async () => {
    const rows = ctx.db.all<ReleaseRow>('SELECT * FROM app_releases')
    return ok(rows.sort((a, b) => compareVersions(b.version, a.version)).map(toDto))
  })

  // Raw installer upload: body is the .exe stream; metadata in the query string.
  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
    scoped.post('/api/admin/releases', { ...pre, bodyLimit: 2 * 1024 * 1024 * 1024 }, async (req) => {
      const q = parse(
        z.object({
          version: z.string().trim().regex(SEMVER_RE, '버전 형식: 1.2.3'),
          notes: z.string().max(4000).default(''),
          mandatory: z.enum(['0', '1', 'true', 'false']).default('0'),
          fileName: z.string().min(5).max(200)
        }),
        req.query
      )
      if (ctx.db.get('SELECT id FROM app_releases WHERE version = ?', [q.version])) throw conflict('같은 버전이 이미 등록되어 있습니다.')
      const fileName = safeFileName(q.fileName)
      const dir = updatesDir(ctx)
      const tmp = join(dir, `${fileName}.${newId()}.part`)
      const hash = createHash('sha512')
      let size = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          hash.update(chunk)
          size += chunk.length
          cb(null, chunk)
        }
      })
      try {
        await pipeline(req.body as Readable, counter, createWriteStream(tmp))
      } catch (e) {
        rmSync(tmp, { force: true })
        throw e
      }
      if (size < 1024 * 1024) {
        rmSync(tmp, { force: true })
        throw badRequest('설치 파일이 너무 작습니다. 올바른 파일인지 확인하세요.')
      }
      const target = join(dir, fileName)
      if (existsSync(target)) rmSync(target, { force: true })
      renameSync(tmp, target)
      const id = newId()
      const t = Date.now()
      ctx.db.run(
        `INSERT INTO app_releases (id, version, notes, file_name, sha512, size, mandatory, state, published_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?, ?)`,
        [id, q.version, q.notes, fileName, hash.digest('base64'), size, q.mandatory === '1' || q.mandatory === 'true' ? 1 : 0, t, req.member.id, t, t]
      )
      const latest = writeLatestYml(ctx)
      logActivity(ctx, req, 'release.publish', { type: 'release', id }, { version: q.version, size })
      if (latest) ctx.hub.broadcast('update.available', { version: latest.version, mandatory: !!latest.mandatory })
      return ok(toDto(ctx.db.get<ReleaseRow>('SELECT * FROM app_releases WHERE id = ?', [id])!))
    })
  })

  /**
   * Closed networks: the server PC (if it has internet) fetches the newest release from
   * the public download site and offers it to members over the LAN.
   */
  app.post('/api/admin/releases/import-web', pre, async (req) => {
    const base = (parse(z.object({ site: z.string().url().optional() }), req.body ?? {}).site ?? DOWNLOAD_SITE).replace(/\/?$/, '/')
    let yml: string
    try {
      const r = await fetch(`${base}updates/latest.yml`, { signal: AbortSignal.timeout(15000), cache: 'no-store' })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      yml = await r.text()
    } catch (e) {
      throw badRequest(`다운로드 사이트에 연결하지 못했습니다(${(e as Error).message}). 이 PC의 인터넷 연결을 확인하세요.`)
    }
    const field = (k: string): string => (new RegExp(String.raw`^${k}:\s*'?([^'\n]+)'?\s*$`, 'm').exec(yml)?.[1] ?? '').trim()
    const version = field('version')
    const fileName = safeFileName(field('path'))
    const sha512 = field('sha512')
    if (!SEMVER_RE.test(version) || !fileName || !sha512) throw badRequest('다운로드 사이트의 버전 정보가 올바르지 않습니다.')
    if (ctx.db.get('SELECT id FROM app_releases WHERE version = ?', [version])) return ok({ version, imported: false, message: '이미 등록된 버전입니다.' })
    let notes = ''
    try {
      const list = (await (await fetch(`${base}releases.json`, { signal: AbortSignal.timeout(10000) })).json()) as { version: string; notes?: string }[]
      notes = (list.find((x) => x.version === version)?.notes ?? '').slice(0, 4000)
    } catch {
      // notes are optional
    }
    const dir = updatesDir(ctx)
    const tmp = join(dir, `${fileName}.${newId()}.part`)
    const hash = createHash('sha512')
    let size = 0
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        hash.update(chunk)
        size += chunk.length
        cb(null, chunk)
      }
    })
    try {
      const r = await fetch(`${base}updates/${encodeURIComponent(fileName)}`, { signal: AbortSignal.timeout(30 * 60_000) })
      if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`)
      await pipeline(Readable.fromWeb(r.body as never), counter, createWriteStream(tmp))
    } catch (e) {
      rmSync(tmp, { force: true })
      throw badRequest(`설치 파일을 받지 못했습니다(${(e as Error).message}).`)
    }
    const digest = hash.digest('base64')
    if (digest !== sha512) {
      rmSync(tmp, { force: true })
      throw badRequest('받은 설치 파일이 손상되었습니다(해시 불일치). 다시 시도하세요.')
    }
    const target = join(dir, fileName)
    if (existsSync(target)) rmSync(target, { force: true })
    renameSync(tmp, target)
    const id = newId()
    const t = Date.now()
    ctx.db.run(
      `INSERT INTO app_releases (id, version, notes, file_name, sha512, size, mandatory, state, published_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 'published', ?, ?, ?, ?)`,
      [id, version, notes, fileName, digest, size, t, req.member.id, t, t]
    )
    const latest = writeLatestYml(ctx)
    logActivity(ctx, req, 'release.import', { type: 'release', id }, { version, size })
    if (latest) ctx.hub.broadcast('update.available', { version: latest.version, mandatory: !!latest.mandatory })
    return ok({ version, imported: true })
  })

  app.patch('/api/admin/releases/:id', pre, async (req) => {
    const { id } = req.params as { id: string }
    const body = parse(z.object({ state: z.enum(['published', 'withdrawn']).optional(), mandatory: z.boolean().optional() }), req.body)
    const row = ctx.db.get<ReleaseRow>('SELECT * FROM app_releases WHERE id = ?', [id])
    if (!row) throw notFound('릴리스')
    ctx.db.run('UPDATE app_releases SET state = COALESCE(?, state), mandatory = COALESCE(?, mandatory), updated_at = ? WHERE id = ?', [
      body.state ?? null,
      body.mandatory === undefined ? null : body.mandatory ? 1 : 0,
      Date.now(),
      id
    ])
    const latest = writeLatestYml(ctx)
    logActivity(ctx, req, 'release.update', { type: 'release', id }, body)
    if (latest) ctx.hub.broadcast('update.available', { version: latest.version, mandatory: !!latest.mandatory })
    return ok(toDto(ctx.db.get<ReleaseRow>('SELECT * FROM app_releases WHERE id = ?', [id])!))
  })

  // Install guide page for new members (8.2): open http://<server>:<port>/download in a browser.
  app.get('/download', async (_req, reply) => {
    const org = getSection(ctx.db, 'org')
    const r = latestRelease(ctx)
    const link = r
      ? `<a class="btn" href="/updates/${encodeURIComponent(r.file_name)}">TeamHub ${escapeHtml(r.version)} 설치 파일 받기</a>
         <p class="muted">${(r.size / 1024 / 1024).toFixed(1)} MB · SHA-512: <code>${escapeHtml(r.sha512)}</code></p>`
      : `<p>아직 등록된 설치 파일이 없습니다. 관리자에게 문의하세요.</p>`
    const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TeamHub 설치 안내</title>
<style>body{font-family:'Malgun Gothic',system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#0f172a;line-height:1.6}
h1{font-size:24px}.btn{display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600}
.muted{color:#64748b;font-size:13px;word-break:break-all}.box{background:#f1f5f9;border-radius:8px;padding:12px 16px}
.warn{background:#fef3c7;color:#92400e;border-radius:8px;padding:10px 14px;font-weight:600}</style></head><body>
<h1>TeamHub 설치 안내</h1>
<p>${escapeHtml([org.orgName, org.teamName].filter(Boolean).join(' '))} 팀 정보공유 프로그램입니다.</p>
${link}
<h2>설치 순서</h2>
<ol><li>위 버튼으로 설치 파일을 내려받아 실행합니다(관리자 권한이 필요 없습니다).</li>
<li>"Windows의 PC 보호" 창이 뜨면 <b>추가 정보 → 실행</b>을 누릅니다. (코드 서명이 없는 사내용 프로그램이라 표시됩니다.)</li>
<li>프로그램이 열리면 <b>서버에 접속</b>을 고르고, 이 페이지 주소의 IP를 입력합니다.</li>
<li>이름·부서를 입력해 사용 신청을 하면, 관리자가 승인한 뒤 바로 사용할 수 있습니다.</li></ol>
<div class="box">서버 주소: <b id="addr"></b></div>
<p class="warn">⚠ ${escapeHtml(org.noticeText)}</p>
<p class="muted">보안 프로그램이 설치를 막는 경우, 관리자에게 예외 등록을 요청하세요(프로그램 이름: TeamHub, 사용 포트: TCP ${getSection(ctx.db, 'network').port}, UDP 47801).</p>
<script>document.getElementById('addr').textContent=location.host</script>
</body></html>`
    return reply.type('text/html; charset=utf-8').header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'").send(html)
  })
}
