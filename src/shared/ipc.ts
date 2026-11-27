/**
 * Single source of truth for renderer <-> main IPC (13.8).
 * Each channel maps to its request and response types. The preload script only
 * forwards channels listed in IPC_CHANNELS, and main validates every request.
 */
import type { LedgerChange, LedgerChanges, LedgerDoc, LedgerExportCell, LedgerExportColumn, LedgerExportFormat, LedgerRefused, LedgerVersion, LocalLedgerDto, LocalLedgerMeta } from './schemas/ledger'

import type { ServerSetupInput } from './schemas/settings'
import type { ServerStatus } from './server-host'
import type { HeldBack } from './update-policy'
import type { UrgentPayload } from './schemas/notices'
import type { AlertSoundKind } from './alert-sound'
import type { DiaryEntryDto, DiarySummaryDto, PersonalEventDto, PersonalEventInput, PersonalOccurrenceDto, ReminderItem } from './schemas/personal'
import type { DetectedApp, LauncherInput, LauncherItemDto, RecentDocDto, TeamLauncherDto } from './schemas/launcher'
import type { NetCheckStep, SecurityProgramDto, SecurityRunDto, SysInfo, SysResources, TempEntry } from './schemas/sysutil'
import type { FmEntry, FmPlace, FmResult, IndexRoot, SearchHit, SearchQuery } from './fm'
import type { BookmarkDto, BookmarkInput, CollectionDto, SmartFolderDto, SmartQuery, TagDto, TaggedItem } from './organize'
import type { CellValue, DbProps, NoteDto, NoteKind, NoteRow, NoteTreeItem } from './notes'
import type { MeetingInvitePayload } from './schemas/meetings'
import type { CatalogPlugin, InstalledPlugin, PluginManifest } from './schemas/plugins'
import type { OcrResult } from './ocr'
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
  local: { dir: string; isDefault: boolean; defaultDir: string; bytes: number; /** set while the data is in the app data folder and a D: drive is there */ driveDir: string | null }
  /** only on the server PC */
  server: { dir: string; bytes: number; running: boolean } | null
  /** result of the last change (shown once after the restart) */
  last: { ok: boolean; message: string; at: number } | null
  /** a move under way (one at a time), with its last progress */
  busy: { kind: 'local' | 'server'; progress: StorageProgress | null } | null
  /** result of the last server-folder move */
  lastServer: { ok: boolean; message: string; at: number } | null
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
  /** Server PC or member PC, fixed at the first setup; null until then. */
  lockedRole: 'server' | 'client' | null
  /** The unique value of this PC (A1B2-C3D4-E5F6); null until it has been made. */
  pcUid: string | null
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

/** One inbound firewall rule TeamHub adds (src/main/firewall.ts), as shown to the person. */
export interface FirewallRule {
  name: string
  label: string
}

export interface FirewallState {
  /** false in development and E2E runs: nothing is registered there (they stay on 127.0.0.1) */
  available: boolean
  /** what the register button adds on this PC */
  rules: FirewallRule[]
  /** names of those rules that exist now */
  registered: string[]
}

export interface SetupResult {
  ok: boolean
  error?: string
  addresses?: string[]
  firewall?: { ok: boolean; message: string }
  /** Set when the data folder already holds a set-up server: nothing was changed, ask before replacing it. */
  existing?: { orgName: string; teamName: string; remembered: boolean }
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
  /** Download of one specific version (otherwise the current one). */
  versionId?: string
  note?: string
  uploadId?: string
  /** Download: which content the partial file belongs to (sent back as If-Range when continuing). */
  etag?: string
  /** Download into a temporary place ("바로 열기"): not continued after a restart. */
  temp?: boolean
  done: number
  status: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled'
  error?: string
  newVersion?: boolean
  createdAt: number
}

/** What the feedback window (기능요청 및 오류신고) adds to a post; the post itself goes to the server PC. */
export interface FeedbackInfo {
  /** The value that stands for this PC on the board (made from its addresses, not reversible). */
  installId: string
  /** What is added to a post when the writer allows it: app and Windows version. */
  app: { version: string; os: string }
  /** The same, as the line shown to the writer. */
  environment: string
  boardUrl: string
  limits: { titleMin: number; titleMax: number; bodyMin: number; bodyMax: number; authorMax: number }
}

/** Program lock (optional: a 4-digit PIN asked at start and after Windows was locked). */
/** A card of the message preview near the tray (src/main/preview.ts). */
export interface PreviewItem {
  /** the conversation (or 'notes') */
  key: string
  title: string
  body: string
  route?: string
  /** messages that came since the card appeared */
  count: number
  at: number
}

export interface LockState {
  /** The user turned the lock on by making a PIN. Shared PC: the signed-in person has a PIN. */
  hasPin: boolean
  locked: boolean
  /** Too many wrong tries: nothing is accepted for this long. */
  waitMs: number
  /** Shared PC: the lock asks for the one PIN of this signed-in person (there is no separate lock PIN). */
  seat?: { name: string; owner: boolean }
}

/** Shared PC (공용 PC 사용): several people use one member PC, each with a name and, if they want one, a PIN. */
export interface SeatInfo {
  id: string
  name: string
  /** PC 책임자: turned the mode on; adds and removes people. */
  owner: boolean
  /** False: this person uses no PIN, the name alone signs them in. */
  hasPin: boolean
  lastUsedAt: number
  /** Too many wrong tries for this person: nothing is accepted for this long. */
  waitMs: number
}

export interface SeatState {
  enabled: boolean
  /** The list of people cannot be read. */
  damaged: boolean
  /** Somebody is signed in (false in the sign-in window). */
  signedIn: boolean
  /** The mode may be turned on here: a member PC that is connected to a server. */
  allowed: boolean
  active: { id: string; name: string; owner: boolean; hasPin: boolean } | null
  /** The signed-in person is logged out after this many minutes without input (자동 로그아웃 시간). */
  idleMinutes: number
  seats: SeatInfo[]
}

export interface SeatResult {
  ok: boolean
  error?: string
  waitMs?: number
  /** Shown once: recovery code of the PC 책임자's PIN. */
  recovery?: string
  warning?: string
  /** After a restore: the name the person has now (marked when somebody else took theirs). */
  name?: string
}

/** Shared PC: the automatic logout that is about to happen (shown by the warning window). */
export interface LogoutWarning {
  /** Seconds until the person is logged out. */
  seconds: number
  name: string
}

/** A person removed from a shared PC whose data is still kept (30 days). */
export interface RemovedSeatInfo {
  id: string
  name: string
  removedAt: number
  /** Whole days until the kept data is erased for good. */
  daysLeft: number
  bytes: number
}

/** 내 자료 백업 · 복구: one snapshot of the personal DB in the backups folder. */
export interface LocalSnapshot {
  /** File name inside the backups folder (the only thing the renderer ever names). */
  id: string
  /** auto: the daily one; manual: 지금 백업; safety: made right before a restore. */
  kind: 'auto' | 'manual' | 'safety'
  at: number
  bytes: number
}
export interface LocalBackupInfo {
  dir: string
  /** How many daily snapshots are kept. */
  keep: number
  /** Newest snapshot of any kind; null when there is none. */
  lastAt: number | null
  totalBytes: number
  /** Why the last automatic backup was skipped (not enough free space...). */
  note: string | null
  /** Result of the last restore, shown once after the restart. */
  restore: { ok: boolean; message: string; at: number } | null
  busy: boolean
  snapshots: LocalSnapshot[]
}
export interface LocalBackupResult {
  ok: boolean
  error?: string
  id?: string
}

export interface LockResult {
  ok: boolean
  error?: string
  waitMs?: number
  /** Shown once after a PIN was made or replaced. */
  recovery?: string
}

/** token: stands for the saved file in later open/reveal calls (the renderer never handles its path). */
export interface AttachSaveResult {
  ok: boolean
  canceled?: boolean
  token?: string
  name?: string
  dir?: string
  opened?: boolean
  /** a file that runs code: saved, but not opened from here */
  blocked?: boolean
  error?: string
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
  // personal ledgers (관리대장 · 개인용): rows in the local DB
  'local:ledger.list': { req: void; res: LocalLedgerMeta[] }
  'local:ledger.trash': { req: void; res: LocalLedgerMeta[] }
  'local:ledger.get': { req: { id: string; after?: { p: number; id: string } | null; limit?: number }; res: LocalLedgerDto }
  'local:ledger.create': { req: { doc: LedgerDoc; icon?: string }; res: LocalLedgerMeta }
  'local:ledger.save': { req: { id: string; change: LedgerChange }; res: { meta: LocalLedgerMeta; changes: LedgerChanges; refused: LedgerRefused } }
  'local:ledger.delete': { req: { id: string }; res: void }
  'local:ledger.restore': { req: { id: string }; res: LocalLedgerMeta }
  'local:ledger.purge': { req: { id: string }; res: void }
  'local:ledger.versions': { req: { id: string }; res: LedgerVersion[] }
  'local:ledger.keep': { req: { id: string }; res: LedgerVersion[] }
  'local:ledger.version': { req: { id: string; versionId: string }; res: LedgerDoc }
  'local:ledger.revert': { req: { id: string; versionId: string }; res: LocalLedgerMeta }
  /** 다른 이름으로 저장: the user picks the place; the file type is the one asked for. */
  'ledger:saveAs': { req: { name: string; format: LedgerExportFormat; columns: LedgerExportColumn[]; rows: LedgerExportCell[][]; book: unknown }; res: { ok: boolean; path?: string; error?: string } }
  /** Open a ledger file: xlsx gives rows of values, csv its text, json/db the ledger itself. */
  'ledger:open': { req: void; res: { ok: boolean; name?: string; kind?: 'rows' | 'book' | 'text'; rows?: LedgerExportCell[][]; book?: unknown; text?: string; error?: string } }
  'local:export': { req: void; res: ExportResult }
  'local:import': { req: void; res: ExportResult }
  'local:backup.info': { req: void; res: LocalBackupInfo }
  'local:backup.now': { req: void; res: LocalBackupResult }
  /** Restarts the program on success: the snapshot is swapped in before the local DB opens. */
  'local:backup.restore': { req: { id: string }; res: LocalBackupResult }
  'local:backup.delete': { req: { id: string }; res: LocalBackupResult }
  'local:backup.setKeep': { req: { keep: number }; res: LocalBackupResult }
  'local:backup.openFolder': { req: void; res: void }
  'local:backup.dismiss': { req: void; res: void }
  'local:cache.save': { req: { entries: { key: string; value: string }[] }; res: void }
  'local:cache.load': { req: { prefix: string }; res: { key: string; value: string; updatedAt: number }[] }
  /** prefix '' clears every member's cache; otherwise only the keys of that member */
  'local:cache.clear': { req: { prefix: string }; res: void }
  'local:outbox.list': { req: { owner: string }; res: OutboxItem[] }
  /** false: could not be kept (no key to seal with, or the outbox is full) */
  'local:outbox.add': { req: { id: string; owner: string; kind: string; label: string; body: string }; res: boolean }
  'local:outbox.update': { req: { id: string; state: 'waiting' | 'failed'; error: string }; res: void }
  'local:outbox.remove': { req: { id: string }; res: void }
  'conn:get': { req: void; res: ConnInfo }
  'conn:saveDevice': { req: { serverUrl: string; deviceId: string; deviceKey: string; memberId: string }; res: void }
  'conn:setPending': { req: { serverUrl: string; requestId: string; pollToken: string; name: string } | null; res: void }
  'conn:updateServerUrl': { req: { serverUrl: string }; res: void }
  'conn:reset': { req: void; res: void }
  'conn:pcUid': { req: void; res: string }
  'conn:saved': { req: void; res: SavedConnInfo[] }
  'conn:switchOut': { req: void; res: { ok: boolean; error?: string } }
  'conn:activateSaved': { req: { id: string }; res: { ok: boolean; error?: string } }
  'conn:forgetSaved': { req: { id: string }; res: void }
  'server:networkInfo': { req: void; res: { interfaces: NetIfaceInfo[]; suggestedDataDir: string; pcName: string; winUser: string } }
  'server:pickFolder': { req: { title: string }; res: string | null }
  'server:setup': { req: ServerSetupInput & { replaceExisting?: boolean }; res: SetupResult }
  'server:status': { req: void; res: ServerStatus }
  'server:restart': { req: void; res: ServerStatus }
  'firewall:state': { req: void; res: FirewallState }
  'firewall:register': { req: void; res: { ok: boolean; message: string } }
  'firewall:remove': { req: void; res: { ok: boolean; message: string } }
  'server:inspectBackup': { req: { dir: string }; res: { ok: boolean; error?: string; orgName?: string; teamName?: string; createdAt?: number; admins?: { id: string; name: string }[] } }
  'server:importBackup': { req: { dir: string; dataDir: string; adminId: string }; res: SetupResult }
  'discovery:scan': { req: void; res: DiscoveredServer[] }
  'update:check': { req: { serverUrl: string | null; manual?: boolean; force?: boolean }; res: UpdateState }
  'update:download': { req: void; res: UpdateState }
  'update:getSettings': { req: void; res: UpdateSettings }
  'update:setSettings': { req: UpdateSettings; res: void }
  'update:getState': { req: void; res: UpdateState }
  'update:install': { req: void; res: void }
  'update:postpone': { req: void; res: UpdateState }
  'notify:urgent': { req: UrgentPayload; res: void }
  'notify:closeUrgent': { req: { id: string }; res: void }
  /** ids of the urgent windows open on this PC */
  'notify:openUrgent': { req: void; res: string[] }
  /** close the urgent windows whose notice is not in `ids`; returns the ids closed */
  'notify:syncUrgent': { req: { ids: string[] }; res: string[] }
  'notify:toast': { req: { title: string; body: string; route?: string; key?: string; kind?: AlertSoundKind }; res: void }
  'preview:list': { req: void; res: PreviewItem[] }
  'preview:open': { req: { key: string }; res: void }
  'preview:dismiss': { req: { key: string | null }; res: void }
  'preview:read': { req: { key: string }; res: void }
  'popup:get': { req: { id: string }; res: UrgentPayload | null }
  'window:showMain': { req: { path?: string }; res: void }
  'window:flash': { req: { on: boolean }; res: void }
  /** the window that asks is on screen and has the focus (a window hidden to the tray still claims both in the page) */
  'window:inFront': { req: void; res: boolean }
  'local:events.list': { req: { from: number; to: number }; res: PersonalOccurrenceDto[] }
  'local:events.get': { req: { id: string }; res: PersonalEventDto | null }
  'local:events.save': { req: PersonalEventInput; res: string }
  'local:events.setBusy': { req: { id: string; busyEventId: string | null }; res: void }
  'local:events.setAbsence': { req: { id: string; absenceEventId: string | null }; res: void }
  'local:events.absenceChanged': { req: { absenceEventId: string; change: { startAt: number; endAt: number; allDay: boolean } | null }; res: number }
  'local:events.delete': { req: { id: string; mode?: 'all' | 'this' | 'following'; occurrence?: number }; res: void }
  'local:diary.get': { req: { date: string }; res: DiaryEntryDto | null }
  'local:diary.save': { req: { date: string; bodyHtml: string; tags: string[] }; res: DiaryEntryDto | null }
  'local:diary.delete': { req: { date: string }; res: void }
  'local:diary.month': { req: { ym: string }; res: DiarySummaryDto[] }
  'local:diary.search': { req: { q: string }; res: DiarySummaryDto[] }
  'local:diary.range': { req: { from: string; to: string }; res: DiaryEntryDto[] }
  'scheduler:setServerReminders': { req: { source: string; items: ReminderItem[] }; res: void }
  'transfer:upload': { req: { paths: string[]; folderId: string; fileId?: string; note?: string }; res: number }
  'transfer:list': { req: void; res: TransferItem[] }
  'transfer:cancel': { req: { id: string }; res: void }
  'transfer:clearDone': { req: void; res: void }
  'transfer:resume': { req: void; res: void }
  'transfer:retry': { req: { id: string }; res: void }
  'transfer:pick': { req: { folders: boolean }; res: string[] }
  'transfer:download': { req: { fileId: string; name: string; versionId?: string }; res: ExportResult }
  'transfer:open': { req: { fileId: string; name: string; folderId: string }; res: ExportResult }
  /** An attachment (message, notice, post): save where the user picks, or (open) fetch into the folder used last and open it. */
  'attach:save': { req: { id: string; name: string; open: boolean }; res: AttachSaveResult }
  'attach:open': { req: { token: string }; res: { ok: boolean; error?: string } }
  'attach:reveal': { req: { token: string }; res: void }
  /** 자료 취합: the bundle of handed-in files (zip) or the 제출 현황 list (csv) of a request */
  'collect:save': { req: { id: string; kind: 'zip' | 'csv'; name: string }; res: AttachSaveResult }
  'local:memos.list': { req: { q: string }; res: MemoDto[] }
  'local:memos.get': { req: { id: string }; res: MemoDto | null }
  'local:memos.save': { req: MemoInput; res: string }
  'local:memos.delete': { req: { id: string }; res: void }
  'memo:sticky': { req: { id: string; on: boolean }; res: void }
  'memo:onTop': { req: { id: string; on: boolean }; res: void }
  'memo:quick': { req: void; res: void }
  'memo:closeWindow': { req: void; res: void }
  /** 긴급구조지휘대: the 훈련 창 of a drill (brought to the front when open; msgId: the message to show) */
  'command:openDrill': { req: { drillId: string; msgId?: string }; res: void }
  /** 긴급구조지휘대: the 훈련 통제실 window of a drill */
  'command:openControl': { req: { drillId: string }; res: void }
  'command:closeWindow': { req: void; res: void }
  'command:openDrills': { req: void; res: string[] }
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
  'plugins:downloadCounts': { req: { ids: string[] }; res: Record<string, number> }
  'plugins:installCatalog': { req: { id: string; builtin?: boolean }; res: { ok: boolean; error?: string; data?: PluginManifest } }
  'plugins:pickFile': { req: void; res: { ok: boolean; path?: string; manifest?: PluginManifest; error?: string } }
  'plugins:inspectFile': { req: { path: string }; res: { ok: boolean; path?: string; manifest?: PluginManifest; error?: string } }
  'plugins:installFile': { req: { path: string }; res: { ok: boolean; error?: string; data?: PluginManifest } }
  'plugins:uninstall': { req: { id: string }; res: void }
  'plugins:setEnabled': { req: { id: string; enabled: boolean }; res: void }
  'plugins:saveFile': { req: { id: string; name: string; text: string }; res: { ok: boolean; path?: string; error?: string } }
  'plugins:openFile': { req: { id: string; exts: string[] }; res: { ok: boolean; name?: string; text?: string; error?: string } }
  'plugins:ocr': { req: { id: string; image: string; lang?: string }; res: OcrResult }
  'plugins:openCopilot': { req: { id: string }; res: { ok: boolean; where?: 'app' | 'web'; error?: string } }
  'storage:info': { req: void; res: StorageInfo }
  'storage:clearLast': { req: void; res: void }
  'storage:clearLastServer': { req: void; res: void }
  'storage:pick': { req: { kind: 'local' | 'server' }; res: string | null }
  'storage:checkLocal': { req: { to: string }; res: StorageCheck }
  'storage:changeLocal': { req: { to: string; mode: 'move' | 'use' }; res: { ok: boolean; error?: string } }
  'storage:checkServer': { req: { to: string }; res: StorageCheck }
  'storage:moveServer': { req: { to: string }; res: { ok: boolean; error?: string; warning?: string } }
  'lock:state': { req: void; res: LockState }
  'lock:create': { req: { pin: string }; res: LockResult }
  'lock:unlock': { req: { pin: string }; res: LockResult }
  'lock:change': { req: { oldPin: string; newPin: string }; res: LockResult }
  'lock:recover': { req: { code: string; newPin: string }; res: LockResult }
  'lock:remove': { req: { pin: string }; res: LockResult }
  'lock:now': { req: void; res: void }
  'seat:state': { req: void; res: SeatState }
  /** Sign-in window only: the PIN is checked in the main process, which then starts that person's session. */
  'seat:signIn': { req: { id: string; pin: string }; res: SeatResult }
  'seat:enable': { req: { name: string; pin: string }; res: SeatResult }
  'seat:disable': { req: { ownerPin: string }; res: SeatResult }
  'seat:add': { req: { ownerPin: string; name: string; pin: string }; res: SeatResult }
  'seat:remove': { req: { id: string; pin: string; by: 'self' | 'owner' }; res: SeatResult }
  'seat:removed': { req: void; res: RemovedSeatInfo[] }
  'seat:restore': { req: { ownerPin: string; id: string }; res: SeatResult }
  'seat:purge': { req: { ownerPin: string; id: string }; res: SeatResult }
  'seat:resetPin': { req: { ownerPin: string; id: string; newPin: string }; res: SeatResult }
  /** The signed-in person makes (oldPin empty) or changes their own PIN. */
  'seat:changePin': { req: { oldPin: string; newPin: string }; res: SeatResult }
  /** The signed-in person stops using a PIN. */
  'seat:removePin': { req: { pin: string }; res: SeatResult }
  'seat:recover': { req: { code: string; newPin: string }; res: SeatResult }
  'seat:setIdle': { req: { ownerPin: string; minutes: number }; res: SeatResult }
  /** Ends the session and starts the program again at the sign-in window. */
  'seat:switch': { req: void; res: void }
  /** The automatic logout that is coming; null when none is. */
  'seat:logoutWarning': { req: void; res: LogoutWarning | null }
  /** "계속 사용": cancels the automatic logout that was announced. */
  'seat:stay': { req: void; res: void }
  'feedback:open': { req: void; res: void }
  'feedback:info': { req: void; res: FeedbackInfo }
}

/** Something written for the server while it was unreachable (sent in order when it is back). */
export interface OutboxItem {
  /** also the idempotency key of the request: a repeated send is answered, not done twice */
  id: string
  kind: string
  label: string
  /** JSON of { method, path, body } */
  body: string
  state: 'waiting' | 'failed'
  error: string
  createdAt: number
}

export interface UpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'none' | 'error'
  version?: string
  percent?: number
  message?: string
  /** Found right after the program started: it installs itself at this time unless put off. */
  autoInstallAt?: number
  /** where the update comes from: the public download site or the TeamHub server PC */
  source?: 'web' | 'lan'
  checkedAt?: number
  /** a newer version exists but this member PC waits until the server PC has it (지시 125-①) */
  heldBack?: HeldBack
  /** this PC is the server PC: member PCs wait for it to update first */
  serverPc?: boolean
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
  'local:ledger.list',
  'local:ledger.trash',
  'local:ledger.get',
  'local:ledger.create',
  'local:ledger.save',
  'local:ledger.delete',
  'local:ledger.restore',
  'local:ledger.purge',
  'local:ledger.versions',
  'local:ledger.keep',
  'local:ledger.version',
  'local:ledger.revert',
  'ledger:saveAs',
  'ledger:open',
  'local:export',
  'local:import',
  'local:backup.info',
  'local:backup.now',
  'local:backup.restore',
  'local:backup.delete',
  'local:backup.setKeep',
  'local:backup.openFolder',
  'local:backup.dismiss',
  'local:cache.save',
  'local:cache.load',
  'local:cache.clear',
  'local:outbox.list',
  'local:outbox.add',
  'local:outbox.update',
  'local:outbox.remove',
  'conn:get',
  'conn:saveDevice',
  'conn:setPending',
  'conn:updateServerUrl',
  'conn:reset',
  'conn:pcUid',
  'conn:saved',
  'conn:switchOut',
  'conn:activateSaved',
  'conn:forgetSaved',
  'server:networkInfo',
  'server:pickFolder',
  'server:setup',
  'server:status',
  'server:restart',
  'firewall:state',
  'firewall:register',
  'firewall:remove',
  'server:inspectBackup',
  'server:importBackup',
  'discovery:scan',
  'update:check',
  'update:download',
  'update:getSettings',
  'update:setSettings',
  'update:getState',
  'update:install',
  'update:postpone',
  'notify:urgent',
  'notify:closeUrgent',
  'notify:openUrgent',
  'notify:syncUrgent',
  'notify:toast',
  'preview:list',
  'preview:open',
  'preview:dismiss',
  'preview:read',
  'popup:get',
  'window:showMain',
  'window:flash',
  'window:inFront',
  'local:events.list',
  'local:events.get',
  'local:events.save',
  'local:events.setBusy',
  'local:events.setAbsence',
  'local:events.absenceChanged',
  'local:events.delete',
  'local:diary.get',
  'local:diary.save',
  'local:diary.delete',
  'local:diary.month',
  'local:diary.search',
  'local:diary.range',
  'scheduler:setServerReminders',
  'transfer:upload',
  'transfer:list',
  'transfer:cancel',
  'transfer:clearDone',
  'transfer:resume',
  'transfer:retry',
  'transfer:pick',
  'transfer:download',
  'transfer:open',
  'attach:save',
  'attach:open',
  'attach:reveal',
  'collect:save',
  'local:memos.list',
  'local:memos.get',
  'local:memos.save',
  'local:memos.delete',
  'memo:sticky',
  'memo:onTop',
  'memo:quick',
  'memo:closeWindow',
  'command:openDrill',
  'command:openControl',
  'command:closeWindow',
  'command:openDrills',
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
  'plugins:ocr',
  'plugins:openCopilot',
  'plugins:downloadCounts',
  'storage:info',
  'storage:clearLast',
  'storage:clearLastServer',
  'storage:pick',
  'storage:checkLocal',
  'storage:changeLocal',
  'storage:checkServer',
  'storage:moveServer',
  'lock:state',
  'lock:create',
  'lock:unlock',
  'lock:change',
  'lock:recover',
  'lock:remove',
  'lock:now',
  'seat:state',
  'seat:signIn',
  'seat:enable',
  'seat:disable',
  'seat:add',
  'seat:remove',
  'seat:removed',
  'seat:restore',
  'seat:purge',
  'seat:resetPin',
  'seat:changePin',
  'seat:removePin',
  'seat:recover',
  'seat:setIdle',
  'seat:switch',
  'seat:logoutWarning',
  'seat:stay',
  'feedback:open',
  'feedback:info'
]

/** main -> renderer push events */
export interface MainEventMap {
  'window:maximized': { maximized: boolean }
  'app:navigate': { path: string }
  'server:status': ServerStatus
  'update:state': UpdateState
  'popup:refresh': { id: string }
  'popup:closed': { id: string }
  /** the title-bar X of an urgent window that needs a confirmation: the window decides what it means */
  'popup:closeRequest': { id: string }
  /** the cards of the message preview changed; sound: a new message came */
  'preview:changed': { sound: boolean }
  /** play the alert sound in the TeamHub window: a chime and the sentence of the kind (지시 131) */
  'app:sound': { kind: AlertSoundKind }
  /** 긴급구조지휘대: the 훈련 창 was asked for again (a new message or 다시 알림) */
  'command:poke': { drillId: string; msgId: string | null }
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
  'lock:changed': LockState
}
export type MainEvent = keyof MainEventMap
export const MAIN_EVENTS: readonly MainEvent[] = ['window:maximized', 'app:navigate', 'server:status', 'update:state', 'popup:refresh', 'popup:closed', 'popup:closeRequest', 'preview:changed', 'app:sound', 'command:poke', 'transfer:update', 'transfer:edited', 'memos:changed', 'alarms:changed', 'clipboard:changed', 'favorites:changed', 'focus:state', 'capture:done', 'launcher:changed', 'fsindex:changed', 'meeting:closed', 'plugins:changed', 'storage:progress', 'lock:changed']

export interface TeamhubBridge {
  /** Absolute path of a dropped/selected File (Electron webUtils). */
  pathForFile(file: File): string
  invoke<C extends IpcChannel>(channel: C, req: IpcReq<C>): Promise<IpcRes<C>>
  on<E extends MainEvent>(event: E, cb: (payload: MainEventMap[E]) => void): () => void
}
