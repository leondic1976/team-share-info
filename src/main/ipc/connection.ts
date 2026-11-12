import { app, dialog, BrowserWindow } from 'electron'
import { z } from 'zod'
import log from 'electron-log/main'
import { handle } from './registry'
import { serverSetupSchema } from '../../shared/schemas/settings'
import {
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
import { installBackup } from '../../server/backup'
import { createDevice } from '../../server/repos/devices'
import { getSection, writeSetting } from '../../server/settings'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { winUser } from './app'
import { restartServer, serverStatus, startServer, stopServer } from '../server-host'
import { openServerDb } from '../../server/db'
import { initializeServer } from '../../server/setup'
import { registerFirewallRules } from '../firewall'
import { setAutostart } from '../autostart'
import { discoverServers } from '../discovery'
import { checkForUpdates, getUpdateState, installUpdate } from '../updater'

export function registerConnectionIpc(): void {
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
      appVersion: app.getVersion()
    }
  })

  handle(
    'conn:saveDevice',
    z.object({ serverUrl: z.string().url(), deviceId: z.string().min(1), deviceKey: z.string().min(10), memberId: z.string().min(1) }),
    (c) => {
      writeCredential(c)
      setPendingJoin(null)
      if (!getMode()) setMode('client')
    }
  )

  handle(
    'conn:setPending',
    z.object({ serverUrl: z.string().url(), requestId: z.string(), pollToken: z.string(), name: z.string() }).nullable(),
    (p) => {
      setPendingJoin(p)
      if (p) setMode('client')
    }
  )

  handle('conn:updateServerUrl', z.object({ serverUrl: z.string().url() }), ({ serverUrl }) => updateServerUrl(serverUrl))

  handle('conn:reset', null, async () => {
    if (getMode() === 'server') await stopServer()
    clearCredential()
    setPendingJoin(null)
    setMode(null)
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
    let cred: { deviceId: string; deviceKey: string }
    let port: number
    try {
      installBackup(dir, dataDir)
      const db = openServerDb(dataDir, app.getVersion())
      try {
        const m = db.get<{ id: string }>(`SELECT id FROM members WHERE id = ? AND role = 'admin' AND status = 'active'`, [adminId])
        if (!m) throw new Error('관리자를 찾을 수 없습니다.')
        cred = createDevice(db, { memberId: adminId, pcName: pcName(), winUser: winUser(), ip: '127.0.0.1', appVersion: app.getVersion() })
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
    return { ok: st.state === 'running', error: st.state === 'running' ? undefined : st.message, addresses: listIpv4().filter((i) => !i.virtual).map((i) => `http://${i.address}:${port}`) }
  })

  handle('server:setup', serverSetupSchema, async (input) => {
    if (getMode() === 'server' && readCredential()) return { ok: false, error: '이미 서버로 설정되어 있습니다.' }
    let res
    try {
      const db = openServerDb(input.dataDir, app.getVersion())
      try {
        res = initializeServer(db, input, { pcName: pcName(), winUser: winUser(), appVersion: app.getVersion() })
      } finally {
        db.close()
      }
    } catch (e) {
      log.error('server setup failed', e)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    const port = input.network.port
    setServerConfig({ dataDir: input.dataDir, port, preventSleep: input.ops.preventSleep })
    writeCredential({ serverUrl: `http://127.0.0.1:${port}`, deviceId: res.deviceId, deviceKey: res.deviceKey, memberId: res.memberId })
    setMode('server')
    if (input.ops.autostart) setAutostart(true)
    const st = await startServer(input.dataDir, { preventSleep: input.ops.preventSleep, failFast: true })
    let firewall = { ok: false, message: '방화벽 등록을 선택하지 않았습니다.' }
    if (input.ops.registerFirewall) firewall = await registerFirewallRules(port)
    const addresses = listIpv4()
      .filter((i) => !i.virtual)
      .map((i) => `http://${i.address}:${port}`)
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
  handle('server:registerFirewall', null, async () => registerFirewallRules(getServerConfig()?.port ?? 47800))

  handle('discovery:scan', null, () => discoverServers())

  handle('update:check', z.object({ serverUrl: z.string().url() }), ({ serverUrl }) => checkForUpdates(serverUrl))
  handle('update:getState', null, () => getUpdateState())
  handle('update:install', null, () => installUpdate())
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
