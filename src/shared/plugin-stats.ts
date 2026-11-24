/**
 * Download counts and sort order of the plugin gallery (확장 기능 모음).
 *
 * The download site is static (GitHub Pages), so downloads are counted by the same free
 * external counter the installer download uses (site/index.html): one key per plugin id.
 * Nothing but that key is sent. Everything here is optional: when the counter cannot be
 * reached (closed networks) there are simply no numbers.
 */
export const DOWNLOAD_COUNTER = 'https://abacus.jasoncameron.dev'
export const counterKey = (id: string): string => `teamhub-lan-app/plugin-${id}`

export type PluginSort = 'popular' | 'recent' | 'name'
export const PLUGIN_SORTS: Record<PluginSort, string> = { popular: '인기순', recent: '최신순', name: '이름순' }

interface Sortable {
  id: string
  name: string
  updated?: string
}

/**
 * popular: most downloads first; recent: newest `updated` date first; ties and missing
 * values fall back to the name, so without counts "popular" is simply the name order.
 */
export function sortCatalog<T extends Sortable>(list: readonly T[], sort: PluginSort, counts: Record<string, number> = {}): T[] {
  const byName = (a: T, b: T): number => a.name.localeCompare(b.name, 'ko')
  const n = (p: T): number => counts[p.id] ?? 0
  return [...list].sort((a, b) => {
    if (sort === 'popular') return n(b) - n(a) || byName(a, b)
    if (sort === 'recent') return (b.updated ?? '').localeCompare(a.updated ?? '') || byName(a, b)
    return byName(a, b)
  })
}

/** The part of fetch() used here, so tests (and main's net.fetch) can stand in. */
export type CounterFetch = (url: string, init: { signal: AbortSignal; cache: 'no-store'; credentials: 'omit' }) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>

const valueOf = (j: unknown): number | null => {
  const v = Number((j as { value?: unknown } | null)?.value)
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

async function ask(fetchFn: CounterFetch, path: string, timeoutMs: number): Promise<number | null> {
  try {
    const r = await fetchFn(`${DOWNLOAD_COUNTER}/${path}`, { signal: AbortSignal.timeout(timeoutMs), cache: 'no-store', credentials: 'omit' })
    // a key nobody has hit yet does not exist
    if (r.status === 404) return 0
    return r.ok ? valueOf(await r.json()) : null
  } catch {
    return null
  }
}

/** Counts of the given plugins; a plugin whose count could not be read is left out. Never throws. */
export async function fetchDownloadCounts(ids: readonly string[], fetchFn: CounterFetch, timeoutMs = 5000): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  await Promise.all(
    ids.map(async (id) => {
      const v = await ask(fetchFn, `get/${counterKey(id)}`, timeoutMs)
      if (v !== null) out[id] = v
    })
  )
  return out
}

/** Count one download; resolves to the new count, or null when the counter was not reached. Never throws. */
export const hitDownload = (id: string, fetchFn: CounterFetch, timeoutMs = 5000): Promise<number | null> => ask(fetchFn, `hit/${counterKey(id)}`, timeoutMs).then((v) => v || null)
