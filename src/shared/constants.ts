export const APP_NAME = 'TeamHub'

/** TCP port for API, WebSocket and update feed. */
export const DEFAULT_PORT = 47800
/** UDP port for LAN server discovery. */
export const DISCOVERY_PORT = 47801
export const DISCOVERY_MAGIC = 'TEAMHUB_DISCOVER_V1'

/** Bump when the client/server wire contract changes incompatibly. */
export const PROTOCOL_VERSION = 1
/** Oldest client protocol the server still accepts. */
export const MIN_CLIENT_PROTOCOL = 1

/** The unique value of an installed PC, e.g. A1B2-C3D4-E5F6 (made in the main process, src/main/pcid.ts). */
export const PC_UID_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/

export const DEFAULT_NOTICE_TEXT = '중요 보안 내용, 개인정보, 비공개 정보는 공유할 수 없습니다.'

export const LIMITS = {
  pageDefault: 50,
  pageMax: 200,
  uploadChunkBytes: 8 * 1024 * 1024,
  defaultMaxFileBytes: 5 * 1024 * 1024 * 1024,
  defaultQuotaBytes: 200 * 1024 * 1024 * 1024,
  meetingMaxVideo: 8,
  meetingRecommendedVideo: 6,
  awayAfterMs: 5 * 60 * 1000
} as const

export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UPDATE_REQUIRED: 'UPDATE_REQUIRED',
  DEVICE_REVOKED: 'DEVICE_REVOKED',
  MEMBER_SUSPENDED: 'MEMBER_SUSPENDED',
  IP_NOT_ALLOWED: 'IP_NOT_ALLOWED',
  ADMIN_PIN_REQUIRED: 'ADMIN_PIN_REQUIRED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  EXTENSION_BLOCKED: 'EXTENSION_BLOCKED',
  PC_BLOCKED: 'PC_BLOCKED',
  LOCKED: 'LOCKED',
  INTERNAL: 'INTERNAL'
} as const
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** Menu feature keys; admins can turn features off (6.16). */
export const FEATURES = [
  'home',
  'notices',
  'calendar',
  'files',
  'meetings',
  'chat',
  'tasks',
  'boards',
  'duty',
  'directory',
  'docs',
  'diary',
  'memos',
  'alarms',
  'launcher',
  'utilities',
  'myfiles',
  'notes',
  'ledger',
  'plugins'
] as const
export type FeatureKey = (typeof FEATURES)[number]

/** Public download site (GitHub Pages) and its update feed (electron-updater generic provider). */
export const DOWNLOAD_SITE = 'https://leondic1976.github.io/team-share-info/'
export const WEB_UPDATE_FEED = `${DOWNLOAD_SITE}updates/`
