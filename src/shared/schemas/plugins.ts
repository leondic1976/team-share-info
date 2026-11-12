import { z } from 'zod'
import { scopeSchema, type ScopeDto } from './scope'

/**
 * Plugins (확장 기능). A plugin is a small web app (HTML/JS/CSS) that runs in a sandboxed
 * frame with its own origin and no network access. It talks to TeamHub only through the
 * bridge below, limited to the permissions declared in its manifest.
 */

export const PLUGIN_PERMISSIONS = {
  members: '팀원 이름·부서 보기',
  storage: '이 PC에 확장 기능 데이터 저장',
  rooms: '팀원과 함께하는 방 만들기·참여(서버에 저장)',
  notify: 'Windows 알림 보내기',
  clipboard: '클립보드에 글자 복사',
  files: '내가 고른 파일로 저장·내가 고른 파일 열기'
} as const
export type PluginPermission = keyof typeof PLUGIN_PERMISSIONS

export const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{1,39}$/

export const pluginManifestSchema = z.object({
  id: z.string().regex(PLUGIN_ID_RE, '확장 기능 ID 형식이 올바르지 않습니다.'),
  name: z.string().trim().min(1).max(40),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string().max(300).default(''),
  author: z.string().max(60).default(''),
  icon: z.string().max(8).default('🧩'),
  entry: z.string().regex(/^[\w./-]+\.html$/).default('index.html'),
  permissions: z.array(z.enum(Object.keys(PLUGIN_PERMISSIONS) as [PluginPermission, ...PluginPermission[]])).max(10).default([]),
  minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/).default('0.1.0')
})
export type PluginManifest = z.infer<typeof pluginManifestSchema>

/** .thplugin file: manifest + files (path → base64). One JSON file, no archive library needed. */
export const pluginBundleSchema = z.object({
  format: z.literal('teamhub-plugin@1'),
  manifest: pluginManifestSchema,
  files: z.record(z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/), z.string()).refine((f) => Object.keys(f).length <= 200, '파일이 너무 많습니다.')
})
export type PluginBundle = z.infer<typeof pluginBundleSchema>

/** Entry of the plugin catalog on the download site (plugins/catalog.json). */
export interface CatalogPlugin {
  id: string
  name: string
  version: string
  description: string
  author: string
  icon: string
  permissions: PluginPermission[]
  file: string
  sha256: string
  size: number
  features?: string[]
}

export interface InstalledPlugin {
  manifest: PluginManifest
  installedAt: number
  source: 'catalog' | 'file'
  enabled: boolean
}

// ---------- shared rooms (server) ----------
export const pluginRoomInputSchema = z.object({
  title: z.string().trim().min(1).max(100),
  scope: scopeSchema,
  shared: z.unknown().default({})
})

export interface PluginRoomDto {
  id: string
  pluginId: string
  title: string
  createdBy: string
  createdByName: string
  scope: ScopeDto
  shared: unknown
  entries: Record<string, { name: string; value: unknown; at: number }>
  closed: boolean
  version: number
  createdAt: number
  updatedAt: number
}

/** plugin.invite payload */
export interface PluginInvitePayload {
  pluginId: string
  roomId: string
  title: string
  fromName: string
}

export const PLUGIN_STATE_MAX = 64 * 1024
