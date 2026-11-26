import type { Db } from '../node/sqlite'
import type { ServerSetupInput } from '../shared/schemas/settings'
import { hashPin } from './crypto'
import { createDevice } from './repos/devices'
import { createMember } from './repos/members'
import { isInitialized, writeSetting } from './settings'

export interface SetupResult {
  memberId: string
  deviceId: string
  deviceKey: string
}

/**
 * First-run server initialization (M1-2): store settings and create the admin
 * member plus the server PC's own device (it connects via 127.0.0.1 like any client).
 */
export function initializeServer(
  db: Db,
  input: ServerSetupInput,
  local: { pcName: string; winUser: string; appVersion: string; pcUid?: string }
): SetupResult {
  if (isInitialized(db)) throw new Error('already initialized')
  return db.tx(() => {
    writeSetting(db, 'org', input.org)
    writeSetting(db, 'network', input.network)
    writeSetting(db, 'storage', input.storage)
    writeSetting(db, 'backup', input.backup)
    writeSetting(db, 'ops', {
      disabledFeatures: [],
      preventSleep: input.ops.preventSleep,
      urgentSenders: 'admins',
      groupCreators: 'everyone',
      collectCreators: 'everyone',
      messageRetentionDays: 365
    })
    writeSetting(db, 'dataDir', input.dataDir)
    if (input.adminPin) writeSetting(db, 'adminPinHash', hashPin(input.adminPin))
    const memberId = createMember(db, { ...input.admin, role: 'admin' })
    const dev = createDevice(db, { memberId, pcName: local.pcName, winUser: local.winUser, ip: '127.0.0.1', appVersion: local.appVersion, pcUid: local.pcUid })
    writeSetting(db, 'initialized', true)
    writeSetting(db, 'serverDeviceId', dev.deviceId)
    return { memberId, ...dev }
  })
}
