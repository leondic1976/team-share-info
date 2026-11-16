/**
 * Single source of truth for renderer <-> main IPC (13.8).
 * Each channel maps to its request and response types. The preload script only
 * forwards channels listed in IPC_CHANNELS, and main validates every request.
 */

import type { ServerSetupInput } from './schemas/settings'
import type { ServerStatus } from './server-host'
import type { UrgentPayload } from './schemas/notices'
import type { DiaryEntryDto, DiarySummaryDto, PersonalEventDto, PersonalEventInput, PersonalOccurrenceDto, PersonalTaskDto, PersonalTaskInput, ReminderItem } from './schemas/personal'
import type { DetectedApp, LauncherInput, LauncherItemDto, RecentDocDto, TeamLauncherDto } from './schemas/launcher'
import type { NetCheckStep, SecurityProgramDto, SecurityRunDto, SysInfo, SysResources, TempEntry } from './schemas/sysutil'
import type { FmEntry, FmPlace, FmResult, IndexRoot, SearchHit, SearchQuery } from './fm'
import type { BookmarkDto, BookmarkInput, CollectionDto, SmartFolderDto, SmartQuery, TagDto, TaggedItem } from './organize'
import type { CellValue, DbProps, NoteDto, NoteKind, NoteRow, NoteTreeItem } from './notes'
import type { MeetingInvitePayload } from './schemas/meetings'
import type { CatalogPlugin, InstalledPlugin, PluginManifest } from './schemas/plugins'
import type { AlarmDto, AlarmFirePayload, AlarmInput, AlarmPopupPayload, ClipboardItemDto, ClipboardSettings, FavoriteDto, FocusState, MemoDto, MemoInput, SnippetDto, UpcomingReminder } from './schemas/tools'

export interface AppInfo {
  version: string
  profile: string
  isPackaged: boolean
  platform: string
  userDataPath: string
  localDbPath: string
  winUser: string
  pcName: string
  osRelease: string
}

/** 저장 위치 (6.20) */
export interface StorageInfo {
  local: { dir: string; isDefault: boolean; defaultDir: string; bytes: number }
  /** only on the server PC */
  server: { dir: string; bytes: number; running: boolean } | null
  /** result of the last change (shown once after the restart) */
  last: { ok: boolean; message: string; at: number } | null
}
export interface StorageCheck {
  ok: boolean
  error?: string
  hasData: boolean
  needBytes: number
  freeBytes: number | null
}
export interface StorageProgress {
  phase: 'stop' | 'copy' | 'verify' | 'start' | 'cleanup'
  doneBytes: number
  totalBytes: number
  file?: string
}

export interface ConnInfo {
  mode: 'server' | 'client' | null
  serverUrl: string | null
  deviceId: string | null
  deviceKey: string | null
  memberId: string | null
  pending: { serverUrl: string; requestId: string; pollToken: string; name: string } | null
  winUser: string
  pcName: string
  appVersion: string
}

/** A connection this PC used before and can use again (settings: 서버·팀원 PC 전환). No keys. */
export interface SavedConnInfo {
  id: string
  mode: 'server' | 'client'
  label: string
  savedAt: number
  /** member PC: the server address */
  serverUrl: string | null
  /** server PC: its data folder */
  dataDir: string | null
}

export interface NetIfaceInfo {
  name: string
  address: string
  netmask: string
  cidr: string | null
  broadcast: string | null
  virtual: boolean
}

export interface DiscoveredServer {
  address: string
  port: number
  url: string
  orgName: string
  teamName: string
  version: string
}

export interface SetupResult {
  ok: boolean
  error?: string
  addresses?: string[]
  firewall?: { ok: boolean; message: string }
}

export interface TransferItem {
  id: string
  direction: 'up' | 'down'
  name: string
  path?: string
  size: number
  mtimeMs?: number
  folderId?: string
  fileId?: string
  note?: string
  uploadId?: string
  done: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  error?: string
  newVersion?: boolean
  createdAt: number
}

export interface ExportResult {
  ok: boolean
  path?: string
  error?: string
}

export interface IpcMap {
  'app:getInfo': { req: void; res: AppInfo }
  'app:quit': { req: void; res: void }
  'app:setAutostart': { req: { enabled: boolean }; res: boolean }
  'app:getAutostart': { req: void; res: boolean }
  'app:openExternal': { req: { url: string }; res: void }
  'app:setBadge': { req: { count: number }; res: void }
  'app:idleSeconds': { req: void; res: number }
  'window:hide': { req: void; res: void }
  'window:minimize': { req: void; res: void }
  'window:toggleMaximize': { req: void; res: void }
  'window:setTheme': { req: { theme: 'light' | 'dark' | 'system' }; res: void }
  'local:kv.get': { req: { key: string }; res: unknown }
  'local:kv.set': { req: { key: string; value: unknown }; res: void }
  'local:kv.delete': { req: { key: string }; res: void }
  'local:kv.all': { req: void; res: Record<string, unknown> }
  'local:export': { req: void; res: ExportResult }
  'local:import': { req: void; res: ExportResult }
  'local:cache.save': { req: { entries: { key: string; value: string }[] }; res: void }
  'local:cache.load': { req: { prefix: string }; res: { key: string; value: string; updatedAt: number }[] }
  'local:cache.clear': { req: void; res: void }
  'conn:get': { req: void; res: ConnInfo }
  'conn:saveDevice': { req: { serverUrl: string; deviceId: string; deviceKey: string; memberId: string }; res: void }
  'conn:setPending': { req: { serverUrl: string; requestId: string; pollToken: string; name: string } | null; res: void }
  'conn:updateServerUrl': { req: { serverUrl: string }; res: void }
  'conn:reset': { req: void; res: void }
  'conn:saved': { req: void; res: SavedConnInfo[] }
  'conn:switchOut': { req: void; res: { ok: boolean; error?: string } }
  'conn:activateSaved': { req: { id: string }; res: { ok: boolean; error?: string } }
  'conn:forgetSaved': { req: { id: string }; res: void }
  'server:networkInfo': { req: void; res: { interfaces: NetIfaceInfo[]; suggestedDataDir: string; pcName: string; winUser: string } }
  'server:pickFolder': { req: { title: string }; res: string | null }
  'server:setup': { req: ServerSetupInput; res: SetupResult }
  'server:status': { req: void; res: ServerStatus }
  'server:restart': { req: void; res: ServerStatus }
  'server:registerFirewall': { req: void; res: { ok: boolean; message: string } }
  'server:inspectBackup': { req: { dir: string }; res: { ok: boolean; error?: string; orgName?: string; teamName?: string; createdAt?: number; admins?: { id: string; name: string }[] } }
  'server:importBackup': { req: { dir: string; dataDir: string; adminId: string }; res: SetupResult }
  'discovery:scan': { req: void; res: DiscoveredServer[] }
  'update:check': { req: { serverUrl: string | null; manual?: boolean; force?: boolean }; res: UpdateState }
  'update:download': { req: void; res: UpdateState }
  'update:getSettings': { req: void; res: UpdateSettings }
  'update:setSettings': { req: UpdateSettings; res: void }
  'update:getState': { req: void; res: UpdateState }
  'update:install': { req: void; res: void }
  'notify:urgent': { req: UrgentPayload; res: void }
  'notify:closeUrgent': { req: { id: string }; res: void }
  'notify:toast': { req: { title: string; body: string; route?: string }; res: void }
  'popup:get': { req: { id: string }; res: UrgentPayload | null }
  'window:showMain': { req: { path?: string }; res: void }
  'window:flash': { req: { on: boolean }; res: void }
  'local:events.list': { req: { from: number; to: number }; res: PersonalOccurrenceDto[] }
  'local:events.get': { req: { id: string }; res: PersonalEventDto | null }
  'local:events.save': { req: PersonalEventInput; res: string }
  'local:events.setBusy': { req: { id: string; busyEventId: string | null }; res: void }
  'local:events.delete': { req: { id: string; mode?: 'all' | 'this' | 'following'; occurrence?: number }; res: void }
  'local:diary.get': { req: { date: string }; res: DiaryEntryDto | null }
  'local:diary.save': { req: { date: string; bodyHtml: string; tags: string[] }; res: DiaryEntryDto | null }
  'local:diary.delete': { req: { date: string }; res: void }
  'local:diary.month': { req: { ym: string }; res: DiarySummaryDto[] }
  'local:diary.search': { req: { q: string }; res: DiarySummaryDto[] }
  'local:diary.range': { req: { from: string; to: string }; res: DiaryEntryDto[] }
  'scheduler:setServerReminders': { req: { source: string; items: ReminderItem[] }; res: void }
  'local:tasks.list': { req: { includeDone: boolean }; res: PersonalTaskDto[] }
  'local:tasks.save': { req: PersonalTaskInput; res: string }
  'local:tasks.setDone': { req: { id: string; done: boolean }; res: void }
  'local:tasks.delete': { req: { id: string }; res: void }
  'transfer:upload': { req: { paths: string[]; folderId: string; fileId?: string; note?: string }; res: number }
  'transfer:list': { req: void; res: TransferItem[] }
  'transfer:cancel': { req: { id: string }; res: void }
  'transfer:clearDone': { req: void; res: void }
  'transfer:resume': { req: void; res: void }
  'transfer:pick': { req: { folders: boolean }; res: string[] }
  'transfer:download': { req: { fileId: string; name: string; versionId?: string }; res: ExportResult }
  'transfer:open': { req: { fileId: string; name: string; folderId: string }; res: ExportResult }
  'local:memos.list': { req: { q: string }; res: MemoDto[] }
  'local:memos.get': { req: { id: string }; res: MemoDto | null }
  'local:memos.save': { req: MemoInput; res: string }
  'local:memos.delete': { req: { id: string }; res: void }
  'memo:sticky': { req: { id: string; on: boolean }; res: void }
  'memo:onTop': { req: { id: string; on: boolean }; res: void }
  'memo:quick': { req: void; res: void }
  'memo:closeWindow': { req: void; res: void }
  'local:alarms.list': { req: void; res: AlarmDto[] }
  'local:alarms.save': { req: AlarmInput; res: string }
  'local:alarms.setEnabled': { req: { id: string; enabled: boolean }; res: void }
  'local:alarms.delete': { req: { id: string }; res: void }
  'alarm:popupGet': { req: { pid: string }; res: AlarmPopupPayload | null }
  'alarm:popupAction': { req: { pid: string; action: 'dismiss' | 'snooze'; minutes?: number }; res: void }
  'alarm:showRemote': { req: AlarmFirePayload; res: void }
  'scheduler:upcoming': { req: { from: number; to: number }; res: UpcomingReminder[] }
  'local:snippets.list': { req: void; res: SnippetDto[] }
  'local:snippets.save': { req: { id?: string; title: string; body: string; groupName?: string }; res: string }
  'local:snippets.delete': { req: { id: string }; res: void }
  'local:snippets.use': { req: { id: string }; res: void }
  'local:clipboard.list': { req: void; res: ClipboardItemDto[] }
  'local:clipboard.delete': { req: { id: string | null }; res: void }
  'clipboard:getSettings': { req: void; res: ClipboardSettings }
  'clipboard:setSettings': { req: ClipboardSettings; res: void }
  'clipboard:write': { req: { text?: string; dataUrl?: string }; res: void }
  'local:favorites.list': { req: void; res: FavoriteDto[] }
  'local:favorites.toggle': { req: { itemType: string; itemId: string; title: string; route: string }; res: boolean }
  'focus:start': { req: { minutes: number; kind: 'focus' | 'break' }; res: FocusState }
  'focus:stop': { req: void; res: FocusState }
  'focus:state': { req: void; res: FocusState & { today: { sessions: number; minutes: number } } }
  'capture:start': { req: void; res: void }
  'capture:saveFile': { req: { dataUrl: string }; res: ExportResult }
  'launcher:list': { req: void; res: LauncherItemDto[] }
  'launcher:save': { req: LauncherInput; res: string }
  'launcher:remove': { req: { id: string }; res: void }
  'launcher:reorder': { req: { ids: string[] }; res: void }
  'launcher:run': { req: { id: string }; res: ExportResult }
  'launcher:runTeam': { req: TeamLauncherDto; res: ExportResult }
  'launcher:detect': { req: void; res: { added: number; found: DetectedApp[] } }
  'launcher:startMenu': { req: void; res: { name: string; target: string }[] }
  'launcher:icon': { req: { path: string }; res: string | null }
  'launcher:recent': { req: void; res: RecentDocDto[] }
  'launcher:openRecent': { req: { path: string }; res: ExportResult }
  'launcher:pinRecent': { req: { path: string; pinned: boolean }; res: void }
  'launcher:forgetRecent': { req: { path: string }; res: void }
  'launcher:openBar': { req: void; res: void }
  'sys:resources': { req: void; res: SysResources }
  'sys:info': { req: void; res: SysInfo }
  'security:run': { req: { programs: SecurityProgramDto[] }; res: SecurityRunDto }
  'security:history': { req: void; res: SecurityRunDto[] }
  'sys:netCheck': { req: { target?: string }; res: NetCheckStep[] }
  'sys:tempList': { req: void; res: TempEntry[] }
  'sys:tempDelete': { req: { paths: string[] }; res: { deleted: number; skipped: number; freed: number } }
  'sys:openSetting': { req: { key: string }; res: boolean }
  'fm:places': { req: void; res: FmPlace[] }
  'fm:list': { req: { path: string; showHidden: boolean }; res: { entries: FmEntry[]; error?: string; truncated?: boolean } }
  'fm:mkdir': { req: { parent: string; name: string }; res: FmResult }
  'fm:rename': { req: { path: string; name: string }; res: FmResult }
  'fm:transfer': { req: { paths: string[]; dest: string; move: boolean }; res: FmResult }
  'fm:trash': { req: { paths: string[] }; res: FmResult }
  'fm:open': { req: { path: string }; res: ExportResult }
  'fm:reveal': { req: { path: string }; res: void }
  'fm:props': { req: { path: string }; res: { path: string; size: number; files: number; folders: number; created: number; modified: number; dir: boolean } | null }
  'fm:pin': { req: { path: string; on: boolean }; res: void }
  'fm:recent': { req: void; res: string[] }
  'fm:isProtected': { req: { path: string }; res: boolean }
  'fsx:roots': { req: void; res: IndexRoot[] }
  'fsx:addRoot': { req: { path: string }; res: void }
  'fsx:removeRoot': { req: { path: string }; res: void }
  'fsx:rescan': { req: { path?: string }; res: void }
  'fsx:search': { req: SearchQuery; res: SearchHit[] }
  'fsx:watchNow': { req: void; res: void }
  'org:tags': { req: void; res: TagDto[] }
  'org:tagsOf': { req: { paths: string[] }; res: Record<string, string[]> }
  'org:setTags': { req: { path: string; tags: string[] }; res: void }
  'org:addTag': { req: { paths: string[]; tag: string }; res: void }
  'org:updateTag': { req: { name: string; newName?: string; color?: string }; res: void }
  'org:deleteTag': { req: { name: string }; res: void }
  'org:tagged': { req: { tag: string }; res: TaggedItem[] }
  'org:collections': { req: void; res: CollectionDto[] }
  'org:saveCollection': { req: { id?: string; parentId?: string | null; name: string; note?: string }; res: string }
  'org:deleteCollection': { req: { id: string }; res: void }
  'org:collectionItems': { req: { id: string }; res: TaggedItem[] }
  'org:addToCollection': { req: { id: string; paths: string[] }; res: number }
  'org:removeFromCollection': { req: { id: string; path: string }; res: void }
  'org:setItemNote': { req: { id: string; path: string; note: string }; res: void }
  'org:smart': { req: void; res: SmartFolderDto[] }
  'org:saveSmart': { req: { id?: string; name: string; query: SmartQuery }; res: string }
  'org:deleteSmart': { req: { id: string }; res: void }
  'org:runSmart': { req: { id: string }; res: SearchHit[] }
  'org:forget': { req: { path: string }; res: void }
  'bm:list': { req: void; res: BookmarkDto[] }
  'bm:save': { req: BookmarkInput; res: string }
  'bm:delete': { req: { id: string }; res: void }
  'bm:reorder': { req: { ids: string[] }; res: void }
  'bm:import': { req: { items: { title: string; url: string; category: string }[] }; res: number }
  'bm:importBrowser': { req: { browser: 'chrome' | 'edge' | 'whale' }; res: { ok: boolean; count: number; error?: string } }
  'bm:importHtml': { req: void; res: { ok: boolean; count: number; error?: string } }
  'bm:exportHtml': { req: void; res: ExportResult }
  'bm:open': { req: { url: string }; res: void }
  'notes:tree': { req: void; res: NoteTreeItem[] }
  'notes:trash': { req: void; res: NoteTreeItem[] }
  'notes:get': { req: { id: string }; res: NoteDto | null }
  'notes:create': { req: { parentId?: string | null; kind?: NoteKind; title?: string; icon?: string; bodyHtml?: string }; res: string }
  'notes:update': { req: { id: string; title?: string; icon?: string; bodyHtml?: string; props?: DbProps; rowValues?: Record<string, CellValue>; favorite?: boolean; isTemplate?: boolean }; res: void }
  'notes:move': { req: { id: string; parentId: string | null; index: number }; res: void }
  'notes:toTrash': { req: { id: string }; res: void }
  'notes:restore': { req: { id: string }; res: void }
  'notes:purge': { req: { id: string }; res: void }
  'notes:duplicate': { req: { id: string; parentId: string | null; asTemplate?: boolean }; res: string }
  'notes:rows': { req: { dbId: string }; res: NoteRow[] }
  'notes:addRow': { req: { dbId: string; values?: Record<string, CellValue>; title?: string }; res: string }
  'notes:search': { req: { q: string }; res: { id: string; title: string; icon: string; snippet: string }[] }
  'notes:export': { req: { id: string; format: 'html' | 'md' }; res: ExportResult }
  'meeting:open': { req: { id: string }; res: void }
  'meeting:sources': { req: void; res: { id: string; name: string; thumbnail: string; kind: 'screen' | 'window'; displayId: string }[] }
  'meeting:chooseSource': { req: { id: string; audio: boolean }; res: void }
  'meeting:border': { req: { on: boolean; displayId?: string | null }; res: void }
  'meeting:invite': { req: MeetingInvitePayload; res: void }
  'meeting:inviteGet': { req: { id: string }; res: MeetingInvitePayload | null }
  'meeting:inviteClose': { req: { id: string; accept: boolean }; res: void }
  'plugins:list': { req: void; res: InstalledPlugin[] }
  'plugins:catalog': { req: void; res: { ok: boolean; error?: string; data?: CatalogPlugin[] } }
  'plugins:installCatalog': { req: { id: string; builtin?: boolean }; res: { ok: boolean; error?: string; data?: PluginManifest } }
  'plugins:pickFile': { req: void; res: { ok: boolean; path?: string; manifest?: PluginManifest; error?: string } }
  'plugins:inspectFile': { req: { path: string }; res: { ok: boolean; path?: string; manifest?: PluginManifest; error?: string } }
  'plugins:installFile': { req: { path: string }; res: { ok: boolean; error?: string; data?: PluginManifest } }
  'plugins:uninstall': { req: { id: string }; res: void }
  'plugins:setEnabled': { req: { id: string; enabled: boolean }; res: void }
  'plugins:saveFile': { req: { id: string; name: string; text: string }; res: { ok: boolean; path?: string; error?: string } }
  'plugins:openFile': { req: { id: string; exts: string[] }; res: { ok: boolean; name?: string; text?: string; error?: string } }
  'storage:info': { req: void; res: StorageInfo }
  'storage:clearLast': { req: void; res: void }
  'storage:pick': { req: { kind: 'local' | 'server' }; res: string | null }
  'storage:checkLocal': { req: { to: string }; res: StorageCheck }
  'storage:changeLocal': { req: { to: string; mode: 'move' | 'use' }; res: { ok: boolean; error?: string } }
  'storage:checkServer': { req: { to: string }; res: StorageCheck }
  'storage:moveServer': { req: { to: string }; res: { ok: boolean; error?: string; warning?: string } }
}

export interface UpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'
  version?: string
  percent?: number
  message?: string
  /** where the update comes from: the public download site or the TeamHub server PC */
  source?: 'web' | 'lan'
  checkedAt?: number
}

/** auto: web site first, then the server PC (closed networks). */
export interface UpdateSettings {
  auto: boolean
  source: 'auto' | 'web' | 'lan'
}

export type IpcChannel = keyof IpcMap
export type IpcReq<C extends IpcChannel> = IpcMap[C]['req']
export type IpcRes<C extends IpcChannel> = IpcMap[C]['res']

export const IPC_CHANNELS: readonly IpcChannel[] = [
  'app:getInfo',
  'app:quit',
  'app:setAutostart',
  'app:getAutostart',
  'app:openExternal',
  'app:setBadge',
  'app:idleSeconds',
  'window:hide',
  'window:minimize',
  'window:toggleMaximize',
  'window:setTheme',
  'local:kv.get',
  'local:kv.set',
  'local:kv.delete',
  'local:kv.all',
  'local:export',
  'local:import',
  'local:cache.save',
  'local:cache.load',
  'local:cache.clear',
  'conn:get',
  'conn:saveDevice',
  'conn:setPending',
  'conn:updateServerUrl',
  'conn:reset',
  'conn:saved',
  'conn:switchOut',
  'conn:activateSaved',
  'conn:forgetSaved',
  'server:networkInfo',
  'server:pickFolder',
  'server:setup',
  'server:status',
  'server:restart',
  'server:registerFirewall',
  'server:inspectBackup',
  'server:importBackup',
  'discovery:scan',
  'update:check',
  'update:download',
  'update:getSettings',
  'update:setSettings',
  'update:getState',
  'update:install',
  'notify:urgent',
  'notify:closeUrgent',
  'notify:toast',
  'popup:get',
  'window:showMain',
  'window:flash',
  'local:events.list',
  'local:events.get',
  'local:events.save',
  'local:events.setBusy',
  'local:events.delete',
  'local:diary.get',
  'local:diary.save',
  'local:diary.delete',
  'local:diary.month',
  'local:diary.search',
  'local:diary.range',
  'scheduler:setServerReminders',
  'local:tasks.list',
  'local:tasks.save',
  'local:tasks.setDone',
  'local:tasks.delete',
  'transfer:upload',
  'transfer:list',
  'transfer:cancel',
  'transfer:clearDone',
  'transfer:resume',
  'transfer:pick',
  'transfer:download',
  'transfer:open',
  'local:memos.list',
  'local:memos.get',
  'local:memos.save',
  'local:memos.delete',
  'memo:sticky',
  'memo:onTop',
  'memo:quick',
  'memo:closeWindow',
  'local:alarms.list',
  'local:alarms.save',
  'local:alarms.setEnabled',
  'local:alarms.delete',
  'alarm:popupGet',
  'alarm:popupAction',
  'alarm:showRemote',
  'scheduler:upcoming',
  'local:snippets.list',
  'local:snippets.save',
  'local:snippets.delete',
  'local:snippets.use',
  'local:clipboard.list',
  'local:clipboard.delete',
  'clipboard:getSettings',
  'clipboard:setSettings',
  'clipboard:write',
  'local:favorites.list',
  'local:favorites.toggle',
  'focus:start',
  'focus:stop',
  'focus:state',
  'capture:start',
  'capture:saveFile',
  'launcher:list',
  'launcher:save',
  'launcher:remove',
  'launcher:reorder',
  'launcher:run',
  'launcher:runTeam',
  'launcher:detect',
  'launcher:startMenu',
  'launcher:icon',
  'launcher:recent',
  'launcher:openRecent',
  'launcher:pinRecent',
  'launcher:forgetRecent',
  'launcher:openBar',
  'sys:resources',
  'sys:info',
  'security:run',
  'security:history',
  'sys:netCheck',
  'sys:tempList',
  'sys:tempDelete',
  'sys:openSetting',
  'fm:places',
  'fm:list',
  'fm:mkdir',
  'fm:rename',
  'fm:transfer',
  'fm:trash',
  'fm:open',
  'fm:reveal',
  'fm:props',
  'fm:pin',
  'fm:recent',
  'fm:isProtected',
  'fsx:roots',
  'fsx:addRoot',
  'fsx:removeRoot',
  'fsx:rescan',
  'fsx:search',
  'fsx:watchNow',
  'org:tags',
  'org:tagsOf',
  'org:setTags',
  'org:addTag',
  'org:updateTag',
  'org:deleteTag',
  'org:tagged',
  'org:collections',
  'org:saveCollection',
  'org:deleteCollection',
  'org:collectionItems',
  'org:addToCollection',
  'org:removeFromCollection',
  'org:setItemNote',
  'org:smart',
  'org:saveSmart',
  'org:deleteSmart',
  'org:runSmart',
  'org:forget',
  'bm:list',
  'bm:save',
  'bm:delete',
  'bm:reorder',
  'bm:import',
  'bm:importBrowser',
  'bm:importHtml',
  'bm:exportHtml',
  'bm:open',
  'notes:tree',
  'notes:trash',
  'notes:get',
  'notes:create',
  'notes:update',
  'notes:move',
  'notes:toTrash',
  'notes:restore',
  'notes:purge',
  'notes:duplicate',
  'notes:rows',
  'notes:addRow',
  'notes:search',
  'notes:export',
  'meeting:open',
  'meeting:sources',
  'meeting:chooseSource',
  'meeting:border',
  'meeting:invite',
  'meeting:inviteGet',
  'meeting:inviteClose',
  'plugins:list',
  'plugins:catalog',
  'plugins:installCatalog',
  'plugins:pickFile',
  'plugins:inspectFile',
  'plugins:installFile',
  'plugins:uninstall',
  'plugins:setEnabled',
  'plugins:saveFile',
  'plugins:openFile',
  'storage:info',
  'storage:clearLast',
  'storage:pick',
  'storage:checkLocal',
  'storage:changeLocal',
  'storage:checkServer',
  'storage:moveServer'
]

/** main -> renderer push events */
export interface MainEventMap {
  'window:maximized': { maximized: boolean }
  'app:navigate': { path: string }
  'server:status': ServerStatus
  'update:state': UpdateState
  'popup:refresh': { id: string }
  'popup:closed': { id: string }
  'transfer:update': TransferItem[]
  'transfer:edited': { fileId: string; folderId: string; name: string; path: string }
  'memos:changed': { id: string | null }
  'alarms:changed': { id: string | null }
  'clipboard:changed': { count: number }
  'favorites:changed': { count: number }
  'focus:state': FocusState
  'capture:done': { dataUrl: string }
  'launcher:changed': { count: number }
  'fsindex:changed': { scanning: boolean; count: number }
  'meeting:closed': { id: string }
  'plugins:changed': { count: number }
  'storage:progress': StorageProgress
}
export type MainEvent = keyof MainEventMap
export const MAIN_EVENTS: readonly MainEvent[] = ['window:maximized', 'app:navigate', 'server:status', 'update:state', 'popup:refresh', 'popup:closed', 'transfer:update', 'transfer:edited', 'memos:changed', 'alarms:changed', 'clipboard:changed', 'favorites:changed', 'focus:state', 'capture:done', 'launcher:changed', 'fsindex:changed', 'meeting:closed', 'plugins:changed', 'storage:progress']

export interface TeamhubBridge {
  /** Absolute path of a dropped/selected File (Electron webUtils). */
  pathForFile(file: File): string
  invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>>
  on<E extends MainEvent>(event: E, cb: (payload: MainEventMap[E]) => void): () => void
}
