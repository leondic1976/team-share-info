import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openServerDb } from '../../src/server/db'
import { initializeServer } from '../../src/server/setup'
import { archiveDataDir, inspectDataDir } from '../../src/server/dataDir'
import { getSection } from '../../src/server/settings'
import { setupInput } from './helpers'

const local = { pcName: 'SERVER-PC', winUser: 'admin', appVersion: '0.1.0' }
const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'teamhub-datadir-'))
  dirs.push(d)
  return d
}
function setup(dataDir: string, teamName: string): void {
  const db = openServerDb(dataDir, 'test')
  try {
    initializeServer(db, { ...setupInput({ org: { orgName: '테스트기관', teamName, noticeText: 'x' } }), dataDir }, local)
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 3 })
})

describe('data folder reuse', () => {
  it('reports an empty or missing folder as not initialized', () => {
    const dir = tempDir()
    expect(inspectDataDir(dir)).toEqual({ initialized: false })
    expect(inspectDataDir(join(dir, 'nope'))).toEqual({ initialized: false })
    expect(archiveDataDir(dir)).toBeNull()
  })

  it('reports the team that was set up in the folder', () => {
    const dir = tempDir()
    setup(dir, '행정팀')
    expect(inspectDataDir(dir)).toEqual({ initialized: true, orgName: '테스트기관', teamName: '행정팀' })
  })

  it('a second setup in the same folder fails until the old data is moved aside', () => {
    const dir = tempDir()
    setup(dir, '행정팀')
    mkdirSync(join(dir, 'files'))
    writeFileSync(join(dir, 'files', 'blob'), 'data')
    expect(() => setup(dir, '새팀')).toThrow('already initialized')

    const moved = archiveDataDir(dir)
    expect(moved).not.toBeNull()
    expect(inspectDataDir(dir)).toEqual({ initialized: false })
    // nothing is deleted: the old team is intact in the archive folder
    expect(inspectDataDir(moved!)).toMatchObject({ initialized: true, teamName: '행정팀' })
    expect(existsSync(join(moved!, 'files', 'blob'))).toBe(true)
    expect(existsSync(join(dir, 'files'))).toBe(false)

    setup(dir, '새팀')
    expect(inspectDataDir(dir)).toMatchObject({ initialized: true, teamName: '새팀' })
    const db = openServerDb(dir, 'test')
    try {
      expect(getSection(db, 'org').teamName).toBe('새팀')
      expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM members')?.n).toBe(1)
    } finally {
      db.close()
    }
  })

  it('keeps each replaced team in its own folder', () => {
    const dir = tempDir()
    setup(dir, 'A')
    const a = archiveDataDir(dir)
    setup(dir, 'B')
    const b = archiveDataDir(dir)
    expect(a).not.toBe(b)
    expect(readdirSync(dir).filter((n) => n.startsWith('previous-'))).toHaveLength(2)
  })
})
