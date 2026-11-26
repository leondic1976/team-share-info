import { app, dialog, BrowserWindow } from 'electron'
import { z } from 'zod'
import log from 'electron-log/main'
import { handle } from './registry'
import { localDb } from '../localdb'
import { serverSetupSchema } from '../../shared/schemas/settings'
import { DEFAULT_PORT } from '../../shared/constants'
import {
  archiveCurrent,
  forgetSaved,
  listSaved,
  restoreSaved,
  clearCredential,
  getMode,
  getPendingJoin,
  getServerConfig,
  readCredential,
  setMode,
  setPendingJoin,
  setServerConfig,
  updateServerUrl,
  writeCredential
} from '../connection'
import { listIpv4, pcName, suggestedDataDir } from '../netinfo'
import { serverAddresses } from '../netpolicy'
import { installBackup } from '../../server/backup'
import { createDevice } from '../../server/repos/devices'
import { getSection, writeSetting } from '../../server/settings'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { archiveDataDir, inspectDataDir } from '../../server/dataDir'
import { winUser } from './app'
import { restartServer, serverStatus, startServer, stopServer } from '../server-host'
import { openServerDb } from '../../server/db'
import { initializeServer } from '../../server/setup'
import { firewallState, registerFirewallRules, removeFirewallRules } from '../firewall'
import { setAutostart } from '../autostart'
import { ensurePcUid, lockedRole, lockRole, pcUid, roleRefusal } from '../pcid'
import { discoverServers } from '../discovery'
import { checkForUpdates, downloadUpdate, getUpdateState, installUpdate, postponeUpdate, setUpdateSettings, updateSettings } from '../updater'

export function registerConnectionIpc(): void {
  // PCs set up before roles were fixed: what they are now is what they stay
  const now = getMode()
  if (now && readCredential()) lockRole(now)

  handle('conn:get', null, () => {
    const cred = readCredential()
    return {
      mode: getMode(),
      serverUrl: cred?.serverUrl ?? getPendingJoin()?.serverUrl ?? null,
      deviceId: cred?.deviceId ?? null,
      deviceKey: cred?.deviceKey ?? null,
      memberId: cred?.memberId ?? null,
      pending: getPendingJoin(),
      winUser: winUser(),
      pcName: pcName(),
      appVersion: app.getVersion(),
      lockedRole: lockedRole(),
      pcUid: pcUid()
    }
  })
  // the unique value is needed to ask a server for access: wait for it there
  handle('conn:pcUid', null, () => ensurePcUid())

  handle(
    'conn:saveDevice',
    z.object({ serverUrl: z.string().url(), deviceId: z.string().min(1), deviceKey: z.string().min(10), memberId: z.string().min(1) }),
    (c) => {
      if (lockedRole() === 'server') throw new Error(roleRefusal('client'))
      writeCredential(c)
      setPendingJoin(null)
      if (!getMode()) setMode('client')
    }
  )

  handle(
    'conn:setPending',
    z.object({ serverUrl: z.string().url(), requestId: z.string(), pollToken: z.string(), name: z.string() }).nullable(),
    (p) => {
      if (p && lockedRole() === 'server') throw new Error(roleRefusal('client'))
      setPendingJoin(p)
      if (p) setMode('client')
    }
  )

  handle('conn:updateServerUrl', z.object({ serverUrl: z.string().url() }), ({ serverUrl }) => updateServerUrl(serverUrl))

  /** Team data kept on this PC for one member (offline cache, things waiting to be sent). */
  const dropKept = (memberId: string | undefined): void => {
    if (!memberId) return
    localDb().db.run('DELETE FROM query_cache WHERE key LIKE ?', [`${memberId.replace(/[%_]/g, '')}:%`])
    localDb().db.run('DELETE FROM outbox WHERE owner = ?', [memberId])
  }

  handle('conn:reset', null, async () => {
    if (getMode() === 'server') await stopServer()
    // what was kept of the server's data belongs to the connection that is thrown away
    dropKept(readCredential()?.memberId)
    clearCredential()
    setPendingJoin(null)
    setMode(null)
  })

  // ---------- several servers on one member PC (top bar: 서버 바꾸기) ----------
  // A member PC may belong to several TeamHub servers (teams) and use one at a time. Each
  // server approved this PC separately, so each connection has its own device key; they are
  // remembered in connections.dpapi. The role of the PC stays fixed: a server PC is not
  // switched, and a remembered server-PC connection is never activated here.
  handle('conn:saved', null, () => (lockedRole() === 'server' || getMode() === 'server' ? [] : listSaved().filter((s) => s.mode === 'client')))

  const SERVER_PC = '서버용 PC는 다른 서버에 접속할 수 없습니다. 다른 서버는 일반용(팀원) PC에서 추가하세요.'
  const isServerPc = (): boolean => lockedRole() === 'server' || getMode() === 'server'
  /** Put the connection in use away (remembered, with its offline cache) so another server can be added or used. */
  handle('conn:switchOut', null, async () => {
    if (isServerPc()) return { ok: false, error: SERVER_PC }
    try {
      archiveCurrent()
      return { ok: true }
    } catch (e) {
      log.error('switch out failed', e)
      return { ok: false, error: '지금 연결을 기억해 두지 못했습니다. 연결은 그대로입니다.' }
    }
  })
  handle('conn:activateSaved', z.object({ id: z.string().min(1).max(200) }), async ({ id }) => {
    if (isServerPc()) return { ok: false, error: SERVER_PC }
    if (!id.startsWith('client:')) return { ok: false, error: '일반용(팀원) PC에서는 서버 접속 정보만 쓸 수 있습니다.' }
    try {
      // written before anything is cleared: a failure leaves the connection in use as it is
      if (readCredential()) archiveCurrent()
      else setPendingJoin(null)
      const entry = restoreSaved(id)
      if (!entry) return { ok: false, error: '기억해 둔 서버를 찾을 수 없습니다.' }
      return { ok: true }
    } catch (e) {
      log.error('activate saved connection failed', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
  })
  handle('conn:forgetSaved', z.object({ id: z.string().min(1).max(200) }), ({ id }) => {
    dropKept(forgetSaved(id) ?? undefined)
  })

  handle('server:networkInfo', null, () => ({
    interfaces: listIpv4(),
    suggestedDataDir: suggestedDataDir(),
    pcName: pcName(),
    winUser: winUser()
  }))

  handle('server:pickFolder', z.object({ title: z.string().max(60) }), async ({ title }, e) => {
    const win = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const opts = { title, properties: ['openDirectory' as const, 'createDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  })

  // ---------- server migration: start this PC as the server from a backup (6.16 서버 이전) ----------
  handle('server:inspectBackup', z.object({ dir: z.string().min(1).max(1000) }), ({ dir }) => inspectBackup(dir))
  handle('server:importBackup', z.object({ dir: z.string().min(1).max(1000), dataDir: z.string().min(1).max(1000), adminId: z.string() }), async ({ dir, dataDir, adminId }) => {
    if (getMode() === 'server' && readCredential()) return { ok: false, error: '이미 서버로 설정되어 있습니다.' }
    if (lockedRole() === 'client') return { ok: false, error: roleRefusal('server') }
    const uid = await ensurePcUid()
    let cred: { deviceId: string; deviceKey: string }
    let port: number
    try {
      installBackup(dir, dataDir)
      const db = openServerDb(dataDir, app.getVersion())
      try {
        const m = db.get<{ id: string }>(`SELECT id FROM members WHERE id = ? AND role = 'admin' AND status = 'active'`, [adminId])
        if (!m) throw new Error('관리자를 찾을 수 없습니다.')
        cred = createDevice(db, { memberId: adminId, pcName: pcName(), winUser: winUser(), ip: '127.0.0.1', appVersion: app.getVersion(), pcUid: uid })
        writeSetting(db, 'serverDeviceId', cred.deviceId)
        port = getSection(db, 'network').port
      } finally {
        db.close()
      }
    } catch (e) {
      log.error('server import failed', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    setServerConfig({ dataDir, port, preventSleep: true })
    writeCredential({ serverUrl: `http://127.0.0.1:${port}`, deviceId: cred.deviceId, deviceKey: cred.deviceKey, memberId: adminId })
    setMode('server')
    const st = await startServer(dataDir, { preventSleep: true, failFast: true })
    return { ok: st.state === 'running', error: st.state === 'running' ? undefined : st.message, addresses: serverAddresses(port) }
  })

  handle('server:setup', serverSetupSchema.extend({ replaceExisting: z.boolean().optional() }), async (input) => {
    if (getMode() === 'server' && readCredential()) return { ok: false, error: '이미 서버로 설정되어 있습니다.' }
    if (lockedRole() === 'client') return { ok: false, error: roleRefusal('server') }
    const uid = await ensurePcUid()
    let res
    try {
      // The server DB stays in the data folder when a connection is reset or forgotten, so a
      // new team in the same folder needs the old data moved aside first (asked in the wizard).
      const existing = inspectDataDir(input.dataDir)
      if (existing.initialized) {
        const remembered = listSaved().filter((s) => s.mode === 'server' && s.dataDir && sameDir(s.dataDir, input.dataDir))
        if (!input.replaceExisting) {
          return {
            ok: false,
            error: '이 데이터 폴더에는 이미 서버 자료가 있습니다.',
            existing: { orgName: existing.orgName ?? '', teamName: existing.teamName ?? '', remembered: remembered.length > 0 }
          }
        }
        const moved = archiveDataDir(input.dataDir)
        log.info('[setup] previous server data moved to', moved)
        // those remembered connections pointed at the data that was just moved away
        for (const s of remembered) forgetSaved(s.id)
      }
      const db = openServerDb(input.dataDir, app.getVersion())
      try {
        res = initializeServer(db, input, { pcName: pcName(), winUser: winUser(), appVersion: app.getVersion(), pcUid: uid })
      } finally {
        db.close()
      }
    } catch (e) {
      log.error('server setup failed', e)
      return { ok: false, error: setupErrorText(e) }
    }
    const port = input.network.port
    setServerConfig({ dataDir: input.dataDir, port, preventSleep: input.ops.preventSleep })
    writeCredential({ serverUrl: `http://127.0.0.1:${port}`, deviceId: res.deviceId, deviceKey: res.deviceKey, memberId: res.memberId })
    setMode('server')
    if (input.ops.autostart) setAutostart(true)
    const st = await startServer(input.dataDir, { preventSleep: input.ops.preventSleep, failFast: true })
    let firewall = { ok: false, message: '방화벽 등록을 선택하지 않았습니다.' }
    if (input.ops.registerFirewall) firewall = await registerFirewallRules(true, port)
    const addresses = serverAddresses(port)
    return {
      ok: st.state === 'running',
      error: st.state === 'running' ? undefined : st.message,
      addresses,
      firewall
    }
  })

  handle('server:status', null, () => serverStatus())
  handle('server:restart', null, async () => {
    const cfg = getServerConfig()
    if (!cfg) return serverStatus()
    if (serverStatus().state === 'stopped') return startServer(cfg.dataDir, { preventSleep: cfg.preventSleep })
    return restartServer()
  })
  // Firewall rules: only when the person presses the button; the server PC opens its port, a member PC the program (meetings).
  const fwTarget = (): [boolean, number] => [getMode() === 'server', getServerConfig()?.port ?? DEFAULT_PORT]
  handle('firewall:state', null, () => firewallState(...fwTarget()))
  handle('firewall:register', null, () => registerFirewallRules(...fwTarget()))
  handle('firewall:remove', null, () => removeFirewallRules())

  handle('discovery:scan', null, () => discoverServers())

  handle('update:check', z.object({ serverUrl: z.string().url().nullable(), manual: z.boolean().optional(), force: z.boolean().optional() }), ({ serverUrl, manual, force }) =>
    checkForUpdates(serverUrl, manual, force)
  )
  handle('update:download', null, () => downloadUpdate())
  handle('update:getSettings', null, () => updateSettings())
  handle('update:setSettings', z.object({ auto: z.boolean(), source: z.enum(['auto', 'web', 'lan']) }), (s) => setUpdateSettings(s))
  handle('update:getState', null, () => getUpdateState())
  handle('update:install', null, () => installUpdate())
  handle('update:postpone', null, () => postponeUpdate())
}

function sameDir(a: string, b: string): boolean {
  return resolve(a).toLowerCase() === resolve(b).toLowerCase()
}

function setupErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  const code = (e as NodeJS.ErrnoException | null)?.code
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') {
    return `데이터 폴더의 기존 자료를 옮기지 못했습니다. 다른 프로그램(탐색기, 백신, 실행 중인 다른 TeamHub)이 폴더를 쓰고 있는지 확인하거나 다른 데이터 폴더를 지정하세요. (${msg})`
  }
  if (msg === 'already initialized') return '이 데이터 폴더에는 이미 서버 자료가 있습니다. 다른 데이터 폴더를 지정하세요.'
  return msg
}

/** Called on app start: if this PC is the server, start the embedded server. */
export async function autoStartServer(): Promise<void> {
  if (getMode() !== 'server') return
  const cfg = getServerConfig()
  if (!cfg) return
  const st = await startServer(cfg.dataDir, { preventSleep: cfg.preventSleep })
  if (st.state !== 'running') log.error('server failed to start', st.message)
}

/** Read org name and admins of a backup without changing it. */
function inspectBackup(dir: string): { ok: boolean; error?: string; orgName?: string; teamName?: string; createdAt?: number; admins?: { id: string; name: string }[] } {
  const dbFile = join(dir, 'teamhub.db')
  if (!existsSync(join(dir, 'manifest.json')) || !existsSync(dbFile)) return { ok: false, error: 'TeamHub 백업 폴더가 아닙니다. "TeamHub-날짜" 폴더를 고르세요.' }
  const ro = new DatabaseSync(dbFile, { readOnly: true })
  try {
    const org = ro.prepare(`SELECT value FROM settings WHERE key = 'org'`).get() as { value: string } | undefined
    const o = org ? (JSON.parse(org.value) as { orgName?: string; teamName?: string }) : {}
    const admins = ro.prepare(`SELECT id, name FROM members WHERE role = 'admin' AND status = 'active' ORDER BY name`).all() as { id: string; name: string }[]
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { createdAt: number }
    return { ok: true, orgName: o.orgName, teamName: o.teamName, createdAt: manifest.createdAt, admins }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    ro.close()
  }
}
