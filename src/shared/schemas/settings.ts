import { z } from 'zod'
import { DEFAULT_NOTICE_TEXT, DEFAULT_PORT, FEATURES, LIMITS, MESSAGE_FILE_RETENTION, type FeatureKey } from '../constants'

export const orgSettingsSchema = z.object({
  orgName: z.string().trim().min(1, '기관/회사명을 입력하세요').max(60),
  teamName: z.string().trim().min(1, '소속 팀명을 입력하세요').max(60),
  noticeText: z.string().trim().min(1).max(200).default(DEFAULT_NOTICE_TEXT)
})
export type OrgSettings = z.infer<typeof orgSettingsSchema>

const cidr = z
  .string()
  .trim()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/, 'CIDR 형식(예: 192.168.10.0/24)')

export const networkSettingsSchema = z.object({
  bindIp: z.string().trim().default('0.0.0.0'),
  advertisedIp: z.string().trim().default(''),
  port: z.number().int().min(1024).max(65535).default(DEFAULT_PORT),
  allowedCidrs: z.array(cidr).max(20).default([]),
  approvalMode: z.enum(['manual', 'auto-in-cidr']).default('manual'),
  reapproveOnIpChange: z.boolean().default(false)
})
export type NetworkSettings = z.infer<typeof networkSettingsSchema>

export const storageSettingsSchema = z.object({
  quotaBytes: z.number().int().positive().default(LIMITS.defaultQuotaBytes),
  maxFileBytes: z.number().int().positive().default(LIMITS.defaultMaxFileBytes),
  blockedExtensions: z.array(z.string().trim().toLowerCase()).default(['exe', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'js', 'msi']),
  /** days a file sent in the messenger stays on the server PC (null: kept for good); at least 90 */
  messageFileRetentionDays: z
    .number()
    .int()
    .min(MESSAGE_FILE_RETENTION.minDays, `메시지 파일 보관 기간은 ${MESSAGE_FILE_RETENTION.minDays}일보다 짧게 할 수 없습니다.`)
    .max(MESSAGE_FILE_RETENTION.maxDays)
    .nullable()
    .default(MESSAGE_FILE_RETENTION.defaultDays)
})
export type StorageSettings = z.infer<typeof storageSettingsSchema>

export const backupSettingsSchema = z.object({
  dir: z.string().trim().default(''),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('12:30'),
  keep: z.number().int().min(1).max(365).default(14)
})
export type BackupSettings = z.infer<typeof backupSettingsSchema>

/** A server backup older than this (or none for this long since the team began) counts as stale. */
export const BACKUP_STALE_MS = 2 * 24 * 3600_000

/** How safe the server backups are (관리 → 백업, 상태; the 최종관리자's reminder). */
export interface BackupHealth {
  /** the folder backups go into */
  root: string
  /** no folder set: `<data folder>/backups/auto` */
  isDefault: boolean
  /** the backups are on the same drive (or network share) as the server data, so one disk failure loses both */
  sameDrive: boolean
  lastAt: number | null
  /** message of the last run when it failed (cleared by the next successful one) */
  lastError: string | null
  lastErrorAt: number | null
  /** no successful backup for more than 2 days */
  stale: boolean
  /** the last run failed */
  failed: boolean
  /** the daily job runs at its next check (within a minute), e.g. a catch-up after the server PC was off */
  pending: boolean
}

/** What /api/me tells the 최종관리자 for the reminder card (null: nothing to remind). */
export interface BackupAlert {
  kind: 'failed' | 'stale'
  lastAt: number | null
  lastError: string | null
}

export const featureKeySchema = z.enum(FEATURES)

const isFeatureKey = (k: string): k is FeatureKey => (FEATURES as readonly string[]).includes(k)

export const opsSettingsSchema = z.object({
  // Keys this version does not know (a removed feature such as 'tasks' in stored settings, or
  // sent by a PC on another version) are dropped instead of failing the whole settings object.
  disabledFeatures: z
    .array(z.string())
    .transform((a) => a.filter(isFeatureKey))
    .default([]),
  preventSleep: z.boolean().default(true),
  urgentSenders: z.enum(['admins', 'everyone']).default('admins'),
  groupCreators: z.enum(['admins', 'everyone']).default('everyone'),
  /** who may ask for 자료 취합 (지시 127) */
  collectCreators: z.enum(['admins', 'everyone']).default('everyone'),
  messageRetentionDays: z.number().int().min(30).max(3650).default(365)
})
export type OpsSettings = z.infer<typeof opsSettingsSchema>

export const allSettingsSchema = z.object({
  org: orgSettingsSchema,
  network: networkSettingsSchema,
  storage: storageSettingsSchema,
  backup: backupSettingsSchema,
  ops: opsSettingsSchema
})
export type AllSettings = z.infer<typeof allSettingsSchema>

export const settingsPatchSchema = z.object({
  org: orgSettingsSchema.partial().optional(),
  network: networkSettingsSchema.partial().optional(),
  storage: storageSettingsSchema.partial().optional(),
  backup: backupSettingsSchema.partial().optional(),
  ops: opsSettingsSchema.partial().optional(),
  adminPin: z.union([z.string().regex(/^\d{4,8}$/, '숫자 4~8자리'), z.literal('')]).optional()
})
export type SettingsPatch = z.infer<typeof settingsPatchSchema>

/** Input of the first-run server wizard (4장). */
export const serverSetupSchema = z.object({
  org: orgSettingsSchema,
  admin: z.object({
    name: z.string().trim().min(1, '이름을 입력하세요').max(40),
    deptName: z.string().trim().max(40).default(''),
    title: z.string().trim().max(40).default(''),
    ext: z.string().trim().max(20).default('')
  }),
  adminPin: z.union([z.string().regex(/^\d{4,8}$/, '숫자 4~8자리'), z.literal('')]).default(''),
  network: networkSettingsSchema,
  dataDir: z.string().trim().min(3, '데이터 폴더를 지정하세요'),
  storage: storageSettingsSchema,
  backup: backupSettingsSchema,
  ops: z.object({
    autostart: z.boolean().default(true),
    preventSleep: z.boolean().default(true),
    registerFirewall: z.boolean().default(true)
  })
})
export type ServerSetupInput = z.infer<typeof serverSetupSchema>
