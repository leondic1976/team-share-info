import { z } from 'zod'

/** Program launcher (6.13). Personal items live in the local DB; team items on the server. */

export type LauncherKind = 'app' | 'path' | 'url'

export interface LauncherItemDto {
  id: string
  kind: LauncherKind
  name: string
  target: string
  args: string
  groupName: string
  sort: number
  detected: boolean
  hidden: boolean
}

export const launcherInputSchema = z.object({
  id: z.string().optional(),
  kind: z.enum(['app', 'path', 'url']),
  name: z.string().trim().min(1, '이름을 입력하세요').max(60),
  target: z.string().trim().min(1).max(1000),
  args: z.string().max(500).default(''),
  groupName: z.string().trim().max(30).default('')
})
export type LauncherInput = z.input<typeof launcherInputSchema>

export type TeamLauncherKind = 'url' | 'path' | 'template'
export interface TeamLauncherDto {
  id: string
  kind: TeamLauncherKind
  name: string
  target: string
  groupName: string
  sort: number
  attachmentId: string | null
  fileName: string | null
}

export const teamLauncherInputSchema = z
  .object({
    kind: z.enum(['url', 'path', 'template']),
    name: z.string().trim().min(1, '이름을 입력하세요').max(60),
    target: z.string().trim().max(1000).default(''),
    groupName: z.string().trim().max(30).default(''),
    attachmentId: z.string().optional()
  })
  .refine((i) => (i.kind === 'template' ? !!i.attachmentId : isSafeTeamTarget(i.kind, i.target)), { message: '주소나 경로가 올바르지 않거나 실행 파일입니다.', path: ['target'] })

export interface RecentDocDto {
  path: string
  name: string
  openedAt: number
  pinned: boolean
}

export interface DetectedApp {
  key: string
  name: string
  path: string
  group: string
}

/** Programs registered automatically when found (6.13 자동 감지). */
export const KNOWN_APPS: { key: string; name: string; group: string; exe: string[]; lnk?: RegExp; assoc?: string }[] = [
  { key: 'hwp', name: '한글', group: '문서', exe: ['hwp.exe'], lnk: /^(한컴오피스 )?한글( \d{4})?$/, assoc: '.hwp' },
  { key: 'hcell', name: '한셀', group: '문서', exe: ['hcell.exe'], lnk: /^(한컴오피스 )?한셀( \d{4})?$/ },
  { key: 'hshow', name: '한쇼', group: '문서', exe: ['hshow.exe'], lnk: /^(한컴오피스 )?한쇼( \d{4})?$/ },
  { key: 'excel', name: 'Excel', group: '문서', exe: ['excel.exe'], lnk: /^Excel( \d{4})?$/i, assoc: '.xlsx' },
  { key: 'word', name: 'Word', group: '문서', exe: ['winword.exe'], lnk: /^Word( \d{4})?$/i, assoc: '.docx' },
  { key: 'powerpoint', name: 'PowerPoint', group: '문서', exe: ['powerpnt.exe'], lnk: /^PowerPoint( \d{4})?$/i, assoc: '.pptx' },
  { key: 'outlook', name: 'Outlook', group: '문서', exe: ['outlook.exe'], lnk: /^Outlook( \(classic\))?( \d{4})?$/i },
  { key: 'acrobat', name: 'Adobe Acrobat', group: '문서', exe: ['acrord32.exe', 'acrobat.exe'], lnk: /^Adobe Acrobat( Reader)?( DC)?$/i, assoc: '.pdf' },
  { key: 'edge', name: 'Microsoft Edge', group: '브라우저', exe: ['msedge.exe'], lnk: /^Microsoft Edge$/i },
  { key: 'chrome', name: 'Chrome', group: '브라우저', exe: ['chrome.exe'], lnk: /^(Google )?Chrome$/i },
  { key: 'whale', name: '네이버 웨일', group: '브라우저', exe: ['whale.exe'], lnk: /^(Naver )?Whale$|^네이버 웨일$/i },
  { key: 'firefox', name: 'Firefox', group: '브라우저', exe: ['firefox.exe'], lnk: /^(Mozilla )?Firefox$/i }
]

/** Built-in Windows tools always offered. */
export const SYSTEM_APPS: { key: string; name: string; file: string }[] = [
  { key: 'explorer', name: '파일 탐색기', file: 'explorer.exe' },
  { key: 'notepad', name: '메모장', file: 'notepad.exe' },
  { key: 'calc', name: '계산기', file: 'calc.exe' },
  { key: 'mspaint', name: '그림판', file: 'mspaint.exe' }
]

const base = (p: string): string => p.replace(/^.*[\\/]/, '').toLowerCase()

/** First executable path in an "open" command such as `"C:\\x\\Hwp.exe" "%1"`. */
export function parseOpenCommand(cmd: string): string | null {
  const m = /^\s*"([^"]+\.exe)"/i.exec(cmd) ?? /^\s*(\S+?\.exe)\b/i.exec(cmd)
  return m ? m[1] : null
}

/**
 * Match registry App Paths, Start menu shortcuts and file associations against the
 * known program list. `exists` filters paths that are not on disk.
 */
export function matchKnownApps(
  appPaths: { name: string; path: string }[],
  shortcuts: { name: string; target: string }[],
  assoc: Record<string, string>,
  exists: (p: string) => boolean = () => true
): DetectedApp[] {
  const out: DetectedApp[] = []
  for (const k of KNOWN_APPS) {
    let path: string | null = null
    const ap = appPaths.find((a) => k.exe.includes(a.name.toLowerCase()) && exists(a.path))
    if (ap) path = ap.path
    if (!path) {
      const sc = shortcuts.find((s) => (k.lnk?.test(s.name) || k.exe.includes(base(s.target))) && base(s.target).endsWith('.exe') && exists(s.target))
      if (sc) path = sc.target
    }
    if (!path && k.assoc && assoc[k.assoc]) {
      const exe = parseOpenCommand(assoc[k.assoc])
      if (exe && k.exe.includes(base(exe)) && exists(exe)) path = exe
    }
    if (path) out.push({ key: k.key, name: k.name, path, group: k.group })
  }
  return out
}

/** Extensions never opened from server-provided launcher items (13.4: no remote commands). */
export const BLOCKED_EXT = ['.exe', '.bat', '.cmd', '.com', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr', '.pif', '.lnk', '.url', '.reg', '.hta', '.cpl', '.jar', '.appref-ms', '.msc']

export function isBlockedPath(p: string): boolean {
  const lower = p.trim().toLowerCase().replace(/[\\/]+$/, '')
  return BLOCKED_EXT.some((e) => lower.endsWith(e))
}

export function isSafeTeamTarget(kind: string, target: string): boolean {
  const t = target.trim()
  if (kind === 'url') return /^https?:\/\/[^\s]+$/i.test(t)
  if (kind === 'path') return /^(\\\\[^\\/:*?"<>|\s][^:*?"<>|]*|[a-zA-Z]:\\[^:*?"<>|]*)$/.test(t) && !isBlockedPath(t)
  return false
}

/** Documents shown in "최근 문서" (Windows Recent + opened from TeamHub). */
export const DOC_EXT = ['.hwp', '.hwpx', '.doc', '.docx', '.xls', '.xlsx', '.xlsm', '.csv', '.ppt', '.pptx', '.pdf', '.txt', '.cell', '.show', '.odt', '.ods', '.odp', '.rtf', '.png', '.jpg', '.jpeg', '.zip']
export const isDocPath = (p: string): boolean => DOC_EXT.some((e) => p.toLowerCase().endsWith(e))
