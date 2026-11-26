import { hasChoseong } from '../shared/hangul'

/**
 * 초성 검색 on the server: for a query with an initial consonant ("ㅎㄱㄷ", "홍ㄱㄷ") the extra
 * `OR hangul_match(col, ?)` terms for short title/name columns (registered in src/node/sqlite.ts).
 * A query without one gets nothing, so the plain LIKE search stays exactly as it was. Bodies
 * (message text, HTML) are never matched this way.
 */
export function choseongOr(q: string, cols: string[]): { sql: string; params: string[] } {
  const t = q.trim()
  if (!hasChoseong(t) || !cols.length) return { sql: '', params: [] }
  return { sql: cols.map((c) => ` OR hangul_match(${c}, ?)`).join(''), params: cols.map(() => t) }
}
