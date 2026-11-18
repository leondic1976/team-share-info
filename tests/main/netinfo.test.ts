import { describe, it, expect, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { suggestedDataDir } from '../../src/main/netinfo'

const saved = process.env.TEAMHUB_USERDATA
afterEach(() => {
  if (saved === undefined) delete process.env.TEAMHUB_USERDATA
  else process.env.TEAMHUB_USERDATA = saved
})

describe('suggested server data folder', () => {
  it.runIf(process.platform === 'win32')('is on D: when there is one, otherwise on C:', () => {
    delete process.env.TEAMHUB_USERDATA
    const dir = suggestedDataDir()
    if (dir.startsWith('D:')) {
      expect(dir).toBe('D:\\TeamHubData')
      expect(existsSync('D:\\')).toBe(true)
    } else {
      expect(dir).toBe('C:\\TeamHubData')
    }
  })

  it('stays inside the isolated app data in tests', () => {
    process.env.TEAMHUB_USERDATA = join('X:', 'e2e')
    expect(suggestedDataDir()).toBe(join('X:', 'e2e', 'server-data'))
  })
})
