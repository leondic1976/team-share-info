import { describe, it, expect, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createTestServer, type TestServer } from './helpers'
import { seedForms, type FormsIndex } from '../../src/server/forms-seed'

let s: TestServer | null = null
const dirs: string[] = []
afterEach(async () => {
  await s?.close()
  s = null
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const IP = '192.168.10.20'
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/** A forms package like resources/forms: index.json and the files it names. */
function pack(version: number, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamhub-forms-'))
  dirs.push(dir)
  const list = Object.entries(files).map(([name, text], i) => {
    const file = `set1/f${i}.hwp`
    const data = Buffer.from(text)
    mkdirSync(dirname(join(dir, file)), { recursive: true })
    writeFileSync(join(dir, file), data)
    return { name, file, size: data.length, sha256: sha(data), title: name }
  })
  const index: FormsIndex = { version, folder: '서식자료실', sets: [{ id: 'set1', name: '행정업무 운영 서식', law: '시행규칙', revision: '[시행 2023. 6. 28.]', source: '국가법령정보센터', sourceUrl: 'https://www.law.go.kr', fetchedAt: '2026-11-20', files: list }] }
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index))
  return dir
}

const view = async (t: TestServer, who: TestServer['admin'], folderId?: string) => (await t.req(who, { method: 'GET', url: `/api/files/view${folderId ? `?folderId=${folderId}` : ''}`, ip: who === t.admin ? '127.0.0.1' : IP })).json().data

describe('서식자료실: official forms shipped with the program are put into the file library', () => {
  it('creates the team folder with the forms and a note; every member can open them', async () => {
    s = await createTestServer()
    const b = await s.join('B')
    const r = seedForms(s.ctx, pack(1, { '서식 01 - 기안문.hwp': 'form one', '서식 02 - 기안문.hwp': 'form two' }))
    expect(r).toMatchObject({ added: 3, updated: 0 })
    const roots = await view(s, b)
    const root = roots.folders.find((f: { name: string }) => f.name === '서식자료실')
    expect(root).toMatchObject({ id: r.folderId, canWrite: true })
    const top = await view(s, b, root.id)
    expect(top.folders.map((f: { name: string }) => f.name)).toEqual(['행정업무 운영 서식'])
    expect(top.files.map((f: { name: string }) => f.name)).toEqual(['서식자료실 안내.txt'])
    const sub = await view(s, b, top.folders[0].id)
    expect(sub.files.map((f: { name: string }) => f.name)).toEqual(['서식 01 - 기안문.hwp', '서식 02 - 기안문.hwp'])
    const dl = await s.req(b, { method: 'GET', url: `/api/files/${sub.files[0].id}/download`, ip: IP })
    expect(dl.statusCode).toBe(200)
    expect(dl.rawPayload.toString()).toBe('form one')
    const note = await s.req(b, { method: 'GET', url: `/api/files/${top.files[0].id}/download`, ip: IP })
    expect(note.rawPayload.toString('utf8')).toContain('기준: [시행 2023. 6. 28.]')
  })

  it('runs once per shipped version: deleted forms stay deleted, a newer set adds versions', async () => {
    s = await createTestServer()
    const dir = pack(1, { 'a.hwp': 'old a', 'b.hwp': 'b' })
    const first = seedForms(s.ctx, dir)
    const sub = (await view(s, s.admin, first.folderId!)).folders[0].id
    const files = (await view(s, s.admin, sub)).files
    expect((await s.req(s.admin, { method: 'DELETE', url: `/api/files/${files[1].id}` })).statusCode).toBe(200)
    // the same program starts again: nothing is touched
    expect(seedForms(s.ctx, dir)).toMatchObject({ folderId: null, skipped: 'already seeded' })
    expect((await view(s, s.admin, sub)).files.map((f: { name: string }) => f.name)).toEqual(['a.hwp'])
    // a newer program: a.hwp changed (new version of the same file), b.hwp is put back, c.hwp is new
    const next = seedForms(s.ctx, pack(2, { 'a.hwp': 'new a', 'b.hwp': 'b', 'c.hwp': 'c' }))
    // added: b.hwp and c.hwp; updated: a.hwp and the note (it lists how many forms there are)
    expect(next).toMatchObject({ folderId: first.folderId, added: 2, updated: 2 })
    const after = (await view(s, s.admin, sub)).files
    expect(after.map((f: { name: string; versionCount: number }) => [f.name, f.versionCount])).toEqual([
      ['a.hwp', 2],
      ['b.hwp', 1],
      ['c.hwp', 1]
    ])
    expect((await s.req(s.admin, { method: 'GET', url: `/api/files/${after[0].id}/download` })).rawPayload.toString()).toBe('new a')
  })

  it('does nothing without a package or before the server is set up, and refuses a damaged package', async () => {
    s = await createTestServer()
    expect(seedForms(s.ctx, undefined).skipped).toBe('no forms shipped')
    expect(seedForms(s.ctx, join(tmpdir(), 'teamhub-no-such-forms')).skipped).toBe('no forms shipped')
    const dir = pack(1, { 'a.hwp': 'a' })
    writeFileSync(join(dir, 'set1', 'f0.hwp'), 'tampered')
    expect(() => seedForms(s!.ctx, dir)).toThrow(/checksum/)
    expect((await view(s, s.admin)).folders).toEqual([])
  })

  it('the forms shipped in resources/forms match their index', () => {
    const dir = resolve(import.meta.dirname, '../../resources/forms')
    const ix = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as FormsIndex
    expect(ix.folder).toBe('서식자료실')
    const all = ix.sets.flatMap((x) => x.files)
    expect(all.length).toBeGreaterThanOrEqual(19)
    expect(new Set(all.map((f) => f.name)).size).toBe(all.length)
    for (const f of all) {
      expect(existsSync(join(dir, f.file)), f.file).toBe(true)
      const data = readFileSync(join(dir, f.file))
      expect(sha(data), f.name).toBe(f.sha256)
      // HWP is an OLE file, PDF starts with %PDF: not an error page saved by mistake
      const sig = data.subarray(0, 4).toString('hex')
      expect(f.name.endsWith('.pdf') ? sig === '25504446' : sig === 'd0cf11e0', f.name).toBe(true)
    }
  })
  it('installed program: the forms come from the single pack file (no loose documents are installed)', async () => {
    s = await createTestServer()
    const out = mkdtempSync(join(tmpdir(), 'teamhub-formspack-'))
    dirs.push(out)
    execFileSync(process.execPath, [resolve('scripts/build-forms.mjs'), join(out, 'forms.pack')])
    expect(existsSync(join(out, 'forms'))).toBe(false)
    const shipped = JSON.parse(readFileSync(resolve('resources/forms/index.json'), 'utf8')) as FormsIndex
    const count = shipped.sets.reduce((n, x) => n + x.files.length, 0)
    const r = seedForms(s.ctx, join(out, 'forms'))
    // every form plus the note
    expect(r).toMatchObject({ added: count + 1, updated: 0 })
    // and without the pack nothing is seeded, nothing fails
    const t = await createTestServer()
    expect(seedForms(t.ctx, join(out, 'nothing-here'))).toMatchObject({ skipped: 'no forms shipped' })
    await t.close()
  })
})
