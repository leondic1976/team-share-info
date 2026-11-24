import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join as pathJoin } from 'node:path'
import type { InjectOptions, LightMyRequestResponse } from 'fastify'
import { openServerDb } from '../../src/server/db'
import { buildApp, type BuiltApp } from '../../src/server/app'
import { initializeServer } from '../../src/server/setup'
import { serverSetupSchema, type ServerSetupInput } from '../../src/shared/schemas/settings'
import { PROTOCOL_VERSION } from '../../src/shared/constants'

export interface Cred {
  deviceId: string
  deviceKey: string
  winUser: string
  memberId: string
}

export interface TestServer extends BuiltApp {
  dataDir: string
  admin: Cred
  close: () => Promise<void>
  req: (cred: Cred | null, opts: InjectOptions & { ip?: string }) => Promise<LightMyRequestResponse>
  /** Create a member through the real join + approve flow. */
  join: (name: string, opts?: { ip?: string; winUser?: string; deptName?: string; deptPath?: string[] }) => Promise<Cred>
}

export function setupInput(over: Partial<ServerSetupInput> = {}): ServerSetupInput {
  return serverSetupSchema.parse({
    org: { orgName: '테스트기관', teamName: '행정팀' },
    admin: { name: '관리자', deptName: '행정팀' },
    network: {},
    dataDir: 'C:/TeamHubData',
    storage: {},
    backup: {},
    ops: {},
    ...over
  })
}

export async function createTestServer(over: Partial<ServerSetupInput> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(pathJoin(tmpdir(), 'teamhub-test-'))
  const db = openServerDb(dataDir, 'test')
  const setup = initializeServer(db, { ...setupInput(over), dataDir }, { pcName: 'SERVER-PC', winUser: 'admin', appVersion: '0.1.0' })
  const built = await buildApp({ db, dataDir, version: '0.1.0', jobs: false })
  const admin: Cred = { deviceId: setup.deviceId, deviceKey: setup.deviceKey, winUser: 'admin', memberId: setup.memberId }

  const req: TestServer['req'] = (cred, opts) => {
    const headers: Record<string, string> = { 'x-protocol': String(PROTOCOL_VERSION), ...(opts.headers as Record<string, string>) }
    if (cred) {
      headers.authorization = `Bearer ${cred.deviceId}.${cred.deviceKey}`
      headers['x-win-user'] = encodeURIComponent(cred.winUser)
    }
    return built.app.inject({ ...opts, headers, remoteAddress: opts.ip ?? '127.0.0.1' })
  }

  const joinMember: TestServer['join'] = async (name, o = {}) => {
    const winUser = o.winUser ?? `user-${name}`
    const ip = o.ip ?? '192.168.10.20'
    const r = await req(null, {
      method: 'POST',
      url: '/api/join',
      ip,
      payload: { name, deptName: o.deptName ?? (o.deptPath ? (o.deptPath[o.deptPath.length - 1] ?? '') : '행정팀'), ...(o.deptPath ? { deptPath: o.deptPath } : {}), pcName: `PC-${name}`, winUser, appVersion: '0.1.0' }
    })
    if (r.statusCode !== 200) throw new Error(`join failed: ${r.body}`)
    const { requestId, pollToken } = r.json().data
    const a = await req(admin, { method: 'PATCH', url: `/api/admin/join-requests/${requestId}`, payload: { action: 'approve' } })
    if (a.statusCode !== 200) throw new Error(`approve failed: ${a.body}`)
    const p = await req(null, { method: 'GET', url: `/api/join/${requestId}?token=${pollToken}`, ip })
    const d = p.json().data
    return { deviceId: d.deviceId, deviceKey: d.deviceKey, winUser, memberId: d.memberId }
  }

  return {
    ...built,
    dataDir,
    admin,
    req,
    join: joinMember,
    close: async () => {
      await built.app.close()
      db.close()
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}
