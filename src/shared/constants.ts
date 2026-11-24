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

/**
 * 공용 PC 사용 (src/node/seats.ts): the PIN of a person on a shared PC keeps colleagues apart,
 * so it is longer than the optional 4-digit program lock.
 */
export const SEAT_PIN_MIN = 6
export const SEAT_PIN_MAX = 12
export const SEAT_NAME_MAX = 20
/** People on one PC. */
export const SEAT_MAX = 10
/** Minutes without input after which the program locks itself (set by the PC 책임자). */
export const SEAT_IDLE_MIN = 3
export const SEAT_IDLE_MAX = 60
export const SEAT_IDLE_DEFAULT = 10

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
  /** only the 최종관리자 (the server PC) may do this; a 서무 gets it with 403 */
  OWNER_ONLY: 'OWNER_ONLY',
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
  'org',
  'directory',
  'meal',
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
