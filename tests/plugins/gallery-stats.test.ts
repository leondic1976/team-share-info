import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DOWNLOAD_COUNTER, counterKey, fetchDownloadCounts, hitDownload, sortCatalog, type CounterFetch } from '../../src/shared/plugin-stats'
import { pluginBundleSchema } from '../../src/shared/schemas/plugins'

const ROOT = join(import.meta.dirname, '../..')

/** A stand-in for the external counter: the real one is never called from tests. */
function fakeCounter(values: Record<string, number>, opts: { down?: boolean; broken?: string[] } = {}): { fetch: CounterFetch; calls: string[] } {
  const calls: string[] = []
  const fetch: CounterFetch = async (url) => {
    calls.push(url)
    if (opts.down) throw new Error('net::ERR_INTERNET_DISCONNECTED')
    const m = /^https:\/\/abacus\.jasoncameron\.dev\/(get|hit)\/teamhub-lan-app\/plugin-([a-z0-9-]+)$/.exec(url)
    if (!m) return { ok: false, status: 400, json: async () => ({}) }
    const [, how, id] = m
    if (opts.broken?.includes(id)) return { ok: false, status: 500, json: async () => ({}) }
    if (how === 'hit') values[id] = (values[id] ?? 0) + 1
    if (values[id] === undefined) return { ok: false, status: 404, json: async () => ({ error: 'Key not found' }) }
    return { ok: true, status: 200, json: async () => ({ value: values[id] }) }
  }
  return { fetch, calls }
}

describe('plugin gallery: download counts', () => {
  it('asks the counter with nothing but the plugin id', async () => {
    const c = fakeCounter({ ladder: 12, meal: 3 })
    expect(await fetchDownloadCounts(['ladder', 'meal', 'bipum'], c.fetch)).toEqual({ ladder: 12, meal: 3, bipum: 0 })
    expect(c.calls.sort()).toEqual(['bipum', 'ladder', 'meal'].map((id) => `${DOWNLOAD_COUNTER}/get/${counterKey(id)}`))
    expect(counterKey('bipum')).toBe('teamhub-lan-app/plugin-bipum')
  })
  it('gives no numbers when the counter cannot be reached, and never throws', async () => {
    expect(await fetchDownloadCounts(['ladder', 'meal'], fakeCounter({}, { down: true }).fetch)).toEqual({})
    expect(await hitDownload('ladder', fakeCounter({}, { down: true }).fetch)).toBeNull()
    // one plugin failing does not hide the others
    expect(await fetchDownloadCounts(['ladder', 'meal'], fakeCounter({ ladder: 5, meal: 1 }, { broken: ['meal'] }).fetch)).toEqual({ ladder: 5 })
  })
  it('gives up on a counter that does not answer', async () => {
    const hang: CounterFetch = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
    const t = Date.now()
    expect(await fetchDownloadCounts(['ladder'], hang, 50)).toEqual({})
    expect(Date.now() - t).toBeLessThan(2000)
  })
  it('counts one download', async () => {
    const values = { ladder: 7 }
    const c = fakeCounter(values)
    expect(await hitDownload('ladder', c.fetch)).toBe(8)
    expect(await hitDownload('bipum', c.fetch)).toBe(1)
    expect(c.calls).toEqual([`${DOWNLOAD_COUNTER}/hit/teamhub-lan-app/plugin-ladder`, `${DOWNLOAD_COUNTER}/hit/teamhub-lan-app/plugin-bipum`])
  })
})

describe('plugin gallery: sort order', () => {
  const list = [
    { id: 'meal', name: '식사 신청', updated: '2026-11-23' },
    { id: 'ladder', name: '사다리타기', updated: '2026-11-12' },
    { id: 'bipum', name: '비품관리대장', updated: '2026-11-24' },
    { id: 'old', name: '가나다' }
  ]
  const ids = (l: { id: string }[]): string[] => l.map((x) => x.id)
  it('popular: most downloads first, then by name', () => {
    expect(ids(sortCatalog(list, 'popular', { ladder: 40, meal: 40, bipum: 2 }))).toEqual(['ladder', 'meal', 'bipum', 'old'])
  })
  it('popular without counts is the name order', () => {
    expect(ids(sortCatalog(list, 'popular', {}))).toEqual(ids(sortCatalog(list, 'name')))
    expect(ids(sortCatalog(list, 'name'))).toEqual(['old', 'bipum', 'ladder', 'meal'])
  })
  it('recent: newest date first, undated last', () => {
    expect(ids(sortCatalog(list, 'recent'))).toEqual(['bipum', 'meal', 'ladder', 'old'])
  })
  it('does not change the list it is given', () => {
    sortCatalog(list, 'recent')
    expect(ids(list)).toEqual(['meal', 'ladder', 'bipum', 'old'])
  })
})

describe('plugin gallery: catalog built from plugins/', () => {
  it('every plugin has a date, and the date stays out of the installed bundle', () => {
    const out = mkdtempSync(join(tmpdir(), 'teamhub-plugins-'))
    try {
      execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-plugins.mjs'), out], { stdio: 'pipe' })
      const catalog = JSON.parse(readFileSync(join(out, 'catalog.json'), 'utf8')) as { id: string; file: string; updated: string }[]
      expect(catalog.map((p) => p.id).sort()).toEqual(readdirSync(join(ROOT, 'plugins'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort())
      for (const p of catalog) {
        expect(p.updated, p.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
        const bundle = JSON.parse(readFileSync(join(out, p.file), 'utf8'))
        expect(pluginBundleSchema.safeParse(bundle).success, p.id).toBe(true)
        expect(bundle.manifest.updated).toBeUndefined()
        expect(bundle.manifest.features).toBeUndefined()
      }
      expect(catalog.some((p) => p.id === 'bipum')).toBe(true)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })
})
