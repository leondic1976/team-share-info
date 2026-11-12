import { describe, it, expect } from 'vitest'
import { Db } from '../../src/node/sqlite'
import { LOCAL_MIGRATIONS } from '../../src/main/localdb/migrations'
import { FsIndexRepo, type IndexedFile } from '../../src/main/localdb/fsindex'

const open = (): Db => {
  const db = new Db(':memory:')
  db.migrate(LOCAL_MIGRATIONS)
  return db
}
const ROOT = String.raw`C:\Users\kim\Documents`
const f = (rel: string, o: Partial<IndexedFile> = {}): IndexedFile => {
  const path = `${ROOT}\\${rel}`
  const i = path.lastIndexOf('\\')
  return { path, name: path.slice(i + 1), dir: path.slice(0, i), size: 1000, mtime: 1_700_000_000_000, isDir: false, ...o }
}

describe('fast file search index (M7-11)', () => {
  it('reflects added, removed and renamed files', () => {
    const repo = new FsIndexRepo(open())
    repo.addRoot(ROOT)
    repo.upsert(ROOT, 1, [f('2026 업무보고서_최종.hwp'), f('예산\\2026 예산안.xlsx', { size: 5_000_000 }), f('예산', { isDir: true }), f('사진.png')])
    expect(repo.finishScan(ROOT, 1)).toBe(4)
    expect(repo.search({ q: '보고서' }).map((h) => h.name)).toEqual(['2026 업무보고서_최종.hwp'])
    expect(repo.search({ q: '2026' }).map((h) => h.name).sort()).toEqual(['2026 업무보고서_최종.hwp', '2026 예산안.xlsx'])
    expect(repo.search({ q: '예산' }).length).toBe(2) // 2-letter term uses LIKE
    expect(repo.search({ q: '*.xlsx' }).map((h) => h.name)).toEqual(['2026 예산안.xlsx'])
    expect(repo.search({ q: '2026', category: 'sheet' }).map((h) => h.ext)).toEqual(['xlsx'])
    expect(repo.search({ q: '2026', minSize: 1_000_000 }).length).toBe(1)
    expect(repo.search({ q: '', under: `${ROOT}\\예산` }).map((h) => h.name)).toEqual(['2026 예산안.xlsx'])
    expect(repo.search({ q: '예산', category: 'folder' }).map((h) => h.name)).toEqual(['예산'])

    // rescan: the photo was deleted, a report was renamed
    repo.upsert(ROOT, 2, [f('2026 주간보고.hwp'), f('예산\\2026 예산안.xlsx'), f('예산', { isDir: true })])
    repo.finishScan(ROOT, 2)
    expect(repo.search({ q: '보고서' })).toEqual([])
    expect(repo.search({ q: '주간보고' }).length).toBe(1)
    expect(repo.search({ q: '사진' })).toEqual([])
    // watcher: a folder disappears with everything under it
    repo.removePath(`${ROOT}\\예산`)
    expect(repo.search({ q: '2026' }).map((h) => h.name)).toEqual(['2026 주간보고.hwp'])
    expect(repo.roots()[0]).toMatchObject({ path: ROOT, fileCount: 3 })
  })

  it('searches 100,000 names in well under 100 ms', () => {
    const repo = new FsIndexRepo(open())
    repo.addRoot(ROOT)
    const words = ['보고서', '예산', '회의록', '출장', '계약서', '사진', 'report', 'budget', '설명서', '공문']
    const batch: IndexedFile[] = []
    for (let i = 0; i < 100_000; i++) batch.push(f(`폴더${i % 500}\\${words[i % 10]}_${i}_${words[(i * 7) % 10]}.${['hwp', 'xlsx', 'pdf', 'docx'][i % 4]}`, { mtime: 1_700_000_000_000 + i }))
    repo.upsert(ROOT, 1, batch)
    repo.finishScan(ROOT, 1)
    // Budget is for a normal office PC; shared CI machines are several times slower.
    const budget = process.env.CI ? 1000 : 100
    repo.search({ q: '보고서', limit: 200 }) // warm up page cache
    for (const q of ['계약서', 'budget', '회의록 계약서', '_9999_']) {
      const t0 = performance.now()
      const r = repo.search({ q, limit: 200 })
      const ms = performance.now() - t0
      expect(r.length).toBeGreaterThan(0)
      console.log('[search]', q, r.length, ms.toFixed(1), 'ms')
      expect(ms).toBeLessThan(budget)
    }
  }, 60000)
})
