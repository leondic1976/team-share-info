import { z } from 'zod'
import type { SearchQuery } from './fm'

/** Logical file organization and site bookmarks (6.18 ③④). Local only. */

export interface TagDto {
  name: string
  color: string
  count: number
}

export interface CollectionDto {
  id: string
  parentId: string | null
  name: string
  note: string
  count: number
}

export interface TaggedItem {
  path: string
  name: string
  exists: boolean
  isDir: boolean
  size: number
  mtime: number
  tags: string[]
  note?: string
}

/** Smart folder query: a SearchQuery plus relative dates resolved at run time. */
export interface SmartQuery extends Omit<SearchQuery, 'modifiedAfter' | 'modifiedBefore'> {
  modifiedWithinDays?: number
  olderThanDays?: number
}

export interface SmartFolderDto {
  id: string
  name: string
  query: SmartQuery
}

export function resolveSmart(q: SmartQuery, now = Date.now()): SearchQuery {
  const { modifiedWithinDays, olderThanDays, ...rest } = q
  return {
    ...rest,
    modifiedAfter: modifiedWithinDays ? now - modifiedWithinDays * 86400000 : undefined,
    modifiedBefore: olderThanDays ? now - olderThanDays * 86400000 : undefined
  }
}

export const TAG_COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899', '#64748b']

export const tagNameSchema = z.string().trim().min(1).max(30)

// ---------- bookmarks ----------
export interface BookmarkDto {
  id: string
  title: string
  url: string
  category: string
  note: string
  sort: number
}

export const bookmarkInputSchema = z.object({
  id: z.string().optional(),
  title: z.string().trim().min(1, '이름을 입력하세요').max(100),
  url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https?:\/\/\S+$/i, 'http:// 또는 https:// 로 시작하는 주소를 입력하세요'),
  category: z.string().trim().max(30).default(''),
  note: z.string().max(500).default('')
})
export type BookmarkInput = z.input<typeof bookmarkInputSchema>

/** Commonly used sites offered as a pick list (6.18 ④ 기본 제공 목록). */
export const PRESET_BOOKMARKS: { category: string; title: string; url: string }[] = [
  { category: '정부·공공', title: '정부24', url: 'https://www.gov.kr' },
  { category: '정부·공공', title: '국민신문고', url: 'https://www.epeople.go.kr' },
  { category: '정부·공공', title: '나라장터', url: 'https://www.g2b.go.kr' },
  { category: '정부·공공', title: '홈택스', url: 'https://www.hometax.go.kr' },
  { category: '정부·공공', title: '국가법령정보센터', url: 'https://www.law.go.kr' },
  { category: '정부·공공', title: '대한민국 정책브리핑', url: 'https://www.korea.kr' },
  { category: '정부·공공', title: '공공데이터포털', url: 'https://www.data.go.kr' },
  { category: '정부·공공', title: '인사혁신처', url: 'https://www.mpm.go.kr' },
  { category: '정부·공공', title: '행정안전부', url: 'https://www.mois.go.kr' },
  { category: '정부·공공', title: '고용노동부', url: 'https://www.moel.go.kr' },
  { category: '정부·공공', title: '국민건강보험', url: 'https://www.nhis.or.kr' },
  { category: '정부·공공', title: '국민연금', url: 'https://www.nps.or.kr' },
  { category: '정부·공공', title: '인터넷우체국', url: 'https://www.epost.go.kr' },
  { category: '정부·공공', title: '도로명주소', url: 'https://www.juso.go.kr' },
  { category: '정부·공공', title: '기상청 날씨누리', url: 'https://www.weather.go.kr' },
  { category: '업무 도구', title: '표준국어대사전', url: 'https://stdict.korean.go.kr' },
  { category: '업무 도구', title: '파파고 번역', url: 'https://papago.naver.com' },
  { category: '업무 도구', title: '구글 번역', url: 'https://translate.google.com' },
  { category: '포털·지도', title: '네이버', url: 'https://www.naver.com' },
  { category: '포털·지도', title: '다음', url: 'https://www.daum.net' },
  { category: '포털·지도', title: '구글', url: 'https://www.google.com' },
  { category: '포털·지도', title: '네이버 지도', url: 'https://map.naver.com' },
  { category: '포털·지도', title: '카카오맵', url: 'https://map.kakao.com' }
]

interface ChromeNode {
  type?: string
  name?: string
  url?: string
  children?: ChromeNode[]
}

/** Chrome/Edge/Whale "Bookmarks" JSON → flat list; folder names become categories. */
export function parseChromeBookmarks(json: string): { title: string; url: string; category: string }[] {
  const out: { title: string; url: string; category: string }[] = []
  let data: { roots?: Record<string, ChromeNode> }
  try {
    data = JSON.parse(json) as { roots?: Record<string, ChromeNode> }
  } catch {
    return out
  }
  const walk = (n: ChromeNode, path: string[]): void => {
    if (n.type === 'url' && n.url && /^https?:/i.test(n.url)) out.push({ title: (n.name || n.url).slice(0, 100), url: n.url, category: path.join(' / ').slice(0, 30) })
    for (const c of n.children ?? []) walk(c, n.type === 'folder' && n.name ? [...path, n.name] : path)
  }
  for (const root of Object.values(data.roots ?? {})) if (root && typeof root === 'object') for (const c of root.children ?? []) walk(c, [])
  return out
}

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
const encode = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Netscape bookmark HTML (what browsers import/export) → list; <H3> folders become categories. */
export function parseBookmarkHtml(html: string): { title: string; url: string; category: string }[] {
  const out: { title: string; url: string; category: string }[] = []
  const stack: string[] = []
  const re = /<H3[^>]*>([\s\S]*?)<\/H3>|<A\s[^>]*HREF="([^"]+)"[^>]*>([\s\S]*?)<\/A>|<\/DL>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) stack.push(decode(m[1].trim()))
    else if (m[2] !== undefined) {
      const url = decode(m[2])
      if (/^https?:/i.test(url)) out.push({ title: decode(m[3].replace(/<[^>]+>/g, '').trim()) || url, url, category: stack.join(' / ').slice(0, 30) })
    } else stack.pop()
  }
  return out
}

export function toBookmarkHtml(items: { title: string; url: string; category: string }[]): string {
  const cats = [...new Set(items.map((i) => i.category))]
  const lines = ['<!DOCTYPE NETSCAPE-Bookmark-file-1>', '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">', '<TITLE>Bookmarks</TITLE>', '<H1>TeamHub 사이트 모음</H1>', '<DL><p>']
  for (const c of cats) {
    const list = items.filter((i) => i.category === c).map((i) => `${c ? '    ' : ''}    <DT><A HREF="${encode(i.url)}">${encode(i.title)}</A>`)
    if (c) lines.push(`    <DT><H3>${encode(c)}</H3>`, '    <DL><p>', ...list, '    </DL><p>')
    else lines.push(...list)
  }
  lines.push('</DL><p>')
  return lines.join('\n')
}
