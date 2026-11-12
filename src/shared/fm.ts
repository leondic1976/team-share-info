/** Personal file management (6.18): types and pure helpers shared by main and renderer. */

export interface FmEntry {
  path: string
  name: string
  ext: string
  dir: boolean
  size: number
  mtime: number
  hidden: boolean
}

export interface FmPlace {
  path: string
  name: string
  kind: 'drive' | 'known' | 'pin'
  free?: number
  size?: number
}

export interface FmResult {
  ok: boolean
  error?: string
  done?: number
  paths?: string[]
}

export type FileCategory = 'folder' | 'doc' | 'sheet' | 'slide' | 'pdf' | 'image' | 'video' | 'audio' | 'archive' | 'exe' | 'text' | 'other'

const CAT: Record<string, FileCategory> = {}
const add = (c: FileCategory, exts: string): void => exts.split(' ').forEach((e) => (CAT[e] = c))
add('doc', 'hwp hwpx doc docx odt rtf')
add('sheet', 'xls xlsx xlsm csv cell ods')
add('slide', 'ppt pptx show odp')
add('pdf', 'pdf')
add('image', 'png jpg jpeg gif bmp webp tif tiff svg heic')
add('video', 'mp4 avi mkv mov wmv webm')
add('audio', 'mp3 wav m4a flac ogg')
add('archive', 'zip 7z rar alz egg tar gz')
add('exe', 'exe msi bat cmd ps1 lnk')
add('text', 'txt md log json xml ini')

export function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(i + 1).toLowerCase() : ''
}

export function categoryOf(name: string, dir = false): FileCategory {
  return dir ? 'folder' : (CAT[extOf(name)] ?? 'other')
}

export const CATEGORY_LABEL: Record<FileCategory, string> = {
  folder: '폴더',
  doc: '문서',
  sheet: '표',
  slide: '발표',
  pdf: 'PDF',
  image: '그림',
  video: '동영상',
  audio: '소리',
  archive: '압축',
  exe: '실행 파일',
  text: '텍스트',
  other: '기타'
}

const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/**
 * Paths where TeamHub never creates, renames, moves or deletes (6.18 안전):
 * drive roots themselves, Windows, Program Files, ProgramData, and other users' profiles.
 */
export function isProtectedPath(path: string, env: { systemRoot: string; programFiles: string[]; programData: string; usersDir: string; home: string }): boolean {
  const p = norm(path)
  if (/^[a-z]:$/.test(p) || /^\\\\[^\\]+\\[^\\]+$/.test(p)) return true
  const roots = [env.systemRoot, ...env.programFiles, env.programData].filter(Boolean).map(norm)
  if (roots.some((r) => p === r || p.startsWith(`${r}\\`))) return true
  const users = norm(env.usersDir)
  const home = norm(env.home)
  if (p.startsWith(`${users}\\`) && !(p === home || p.startsWith(`${home}\\`)) && !p.startsWith(`${users}\\public`)) return true
  if (/\\(\$recycle\.bin|system volume information)(\\|$)/.test(p)) return true
  return false
}

/** "보고서.hwp" → "보고서 (2).hwp" when the name is taken. */
export function uniqueName(name: string, taken: (n: string) => boolean, dir = false): string {
  if (!taken(name)) return name
  const ext = dir ? '' : extOf(name)
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name
  for (let i = 2; i < 10000; i++) {
    const n = ext ? `${stem} (${i}).${ext}` : `${stem} (${i})`
    if (!taken(n)) return n
  }
  return `${stem} (${Date.now()})${ext ? `.${ext}` : ''}`
}

const BAD_NAME = /[\\/:*?"<>|]/
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
export function validName(name: string): string | null {
  const n = name.trim()
  if (!n) return '이름을 입력하세요.'
  if (BAD_NAME.test(n)) return '이름에 \\ / : * ? " < > | 는 쓸 수 없습니다.'
  if (RESERVED.test(n) || /[. ]$/.test(n)) return '쓸 수 없는 이름입니다.'
  if (n.length > 200) return '이름이 너무 깁니다.'
  return null
}

/** Breadcrumb parts for "C:\\Users\\a\\문서" → [C:\\, Users, a, 문서] with full paths. */
export function crumbs(path: string): { name: string; path: string }[] {
  const p = path.replace(/\//g, '\\')
  const unc = /^(\\\\[^\\]+\\[^\\]+)(.*)$/.exec(p)
  const [root, rest] = unc ? [unc[1], unc[2]] : [p.slice(0, 2), p.slice(2)]
  const out = [{ name: unc ? root : `${root}\\`, path: unc ? root : `${root}\\` }]
  let cur = out[0].path.replace(/\\$/, '')
  for (const part of rest.split('\\').filter(Boolean)) {
    cur = `${cur}\\${part}`
    out.push({ name: part, path: cur })
  }
  return out
}

export function parentOf(path: string): string | null {
  const c = crumbs(path)
  return c.length > 1 ? c[c.length - 2].path : null
}

// ---------- fast search (6.18 ②) ----------
export interface SearchQuery {
  q: string
  category?: FileCategory | ''
  ext?: string
  minSize?: number
  maxSize?: number
  modifiedAfter?: number
  modifiedBefore?: number
  under?: string
  limit?: number
}

export interface SearchHit {
  path: string
  name: string
  dir: string
  ext: string
  size: number
  mtime: number
  isDir: boolean
}

export interface IndexRoot {
  path: string
  enabled: boolean
  lastScanAt: number | null
  fileCount: number
  scanning: boolean
}

/** Extensions per category for SQL filters. */
export function extsOf(cat: FileCategory): string[] {
  return Object.entries(CAT)
    .filter(([, c]) => c === cat)
    .map(([e]) => e)
}

/**
 * Split a search box text into terms: words are ANDed; `*`/`?` wildcards become
 * LIKE patterns; quoted text stays one term. Terms shorter than 3 characters cannot
 * use the trigram index and fall back to LIKE.
 */
export function parseSearch(text: string): { fts: string[]; like: string[] } {
  const terms = [...text.matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] ?? m[2]).toLowerCase())
  const fts: string[] = []
  const like: string[] = []
  for (const t of terms) {
    if (/[*?]/.test(t)) like.push(t.replace(/[%_]/g, (c) => `\\${c}`).replace(/\*/g, '%').replace(/\?/g, '_'))
    else if ([...t].length >= 3) fts.push(`"${t.replace(/"/g, '""')}"`)
    else like.push(`%${t.replace(/[%_]/g, (c) => `\\${c}`)}%`)
  }
  return { fts, like }
}
