import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkTarget, copyEntries, finishCopy, MOVE_MARK, tableCounts, treeSize, treeSizeAsync, unfinishedCopy, verifyCopy } from '../../src/node/datamove'

/** Moving a data folder (instruction 132): checks that leave nothing behind, unfinished copies, verification. */
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'th-move-safe-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const noProtect = (): boolean => false
const base = (from: string): { from: string; marker: string; needBytes: number; isProtected: (p: string) => boolean } => ({ from, marker: 'local.db', needBytes: 10, isProtected: noProtect })

function makeDb(file: string, rows: number): DatabaseSync {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS memo (v TEXT)')
  const ins = db.prepare('INSERT INTO memo VALUES (?)')
  for (let i = 0; i < rows; i++) ins.run(`메모 ${i}`)
  return db
}

describe('target check (instruction 132)', () => {
  it('a check does not leave the folders it created to test writing (cancel leaves nothing)', () => {
    const from = join(root, 'a')
    mkdirSync(from)
    const to = join(root, '새 폴더 이름', '팀 허브 자료')
    const c = checkTarget({ ...base(from), to })
    expect(c).toMatchObject({ ok: true, hasData: false })
    expect(existsSync(join(root, '새 폴더 이름'))).toBe(false)
    // an existing folder stays, and nothing is written into it
    mkdirSync(to, { recursive: true })
    expect(checkTarget({ ...base(from), to }).ok).toBe(true)
    expect(readdirSync(to)).toEqual([])
  })

  it('refuses relative paths, missing drives, files, and says why', () => {
    const from = join(root, 'a')
    mkdirSync(from)
    expect(checkTarget({ ...base(from), to: 'TeamHub 자료' }).error).toMatch(/전체 경로/)
    // a drive letter that is not there on this PC
    const missing = ['Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y'].find((l) => !existsSync(`${l}:\\`))
    if (missing) expect(checkTarget({ ...base(from), to: `${missing}:\\TeamHub` }).error).toMatch(/드라이브를 찾을 수 없습니다/)
    writeFileSync(join(root, 'file.txt'), 'x')
    expect(checkTarget({ ...base(from), to: join(root, 'file.txt') }).error).toMatch(/폴더가 아닙니다/)
    expect(checkTarget({ ...base(from), to: '\\\\없는서버\\공유\\TeamHub' }).error).toMatch(/네트워크/)
    expect(checkTarget({ ...base(from), to: '' }).ok).toBe(false)
  })

  it('a folder with an unfinished copy is not "TeamHub data"', () => {
    const from = join(root, 'a')
    mkdirSync(from)
    const to = join(root, 'b')
    mkdirSync(to)
    writeFileSync(join(to, 'local.db'), '')
    expect(checkTarget({ ...base(from), to }).hasData).toBe(true)
    writeFileSync(join(to, MOVE_MARK), '{}')
    expect(unfinishedCopy(to)).toBe(true)
    expect(checkTarget({ ...base(from), to })).toMatchObject({ ok: true, hasData: false })
  })
})

describe('copy, verify, switch (instruction 132)', () => {
  it('a marked copy stays "unfinished" until it is verified and finished', async () => {
    const from = join(root, 'from')
    const to = join(root, '옮길 곳')
    mkdirSync(join(from, 'plugins'), { recursive: true })
    writeFileSync(join(from, 'plugins', 'a.txt'), 'abc')
    const db = makeDb(join(from, 'local.db'), 50)
    const copied = await copyEntries(from, to, ['local.db', 'plugins'], undefined, { mark: true })
    expect(unfinishedCopy(to)).toBe(true)
    expect(verifyCopy(from, to, copied)).toBeNull()
    finishCopy(to)
    expect(unfinishedCopy(to)).toBe(false)
    expect(existsSync(join(to, MOVE_MARK))).toBe(false)
    db.close()
  })

  it('verification compares rows per table, not only the file check', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    mkdirSync(from)
    const db = makeDb(join(from, 'teamhub.db'), 20)
    const copied = await copyEntries(from, to, ['teamhub.db'])
    expect(verifyCopy(from, to, copied)).toBeNull()
    expect(tableCounts(join(to, 'teamhub.db'))).toEqual({ memo: 20 })
    // a copy that lost rows (a stale WAL, a cut-off copy) is caught
    const c = new DatabaseSync(join(to, 'teamhub.db'))
    c.exec('DELETE FROM memo WHERE rowid <= 3')
    c.close()
    expect(verifyCopy(from, to, copied)).toMatch(/memo.*행 수/)
    db.close()
  })

  it('treeSizeAsync agrees with treeSize', async () => {
    mkdirSync(join(root, 'x', 'y'), { recursive: true })
    for (let i = 0; i < 30; i++) writeFileSync(join(root, 'x', 'y', `f${i}`), 'a'.repeat(i))
    writeFileSync(join(root, 'x', 'top'), 'hello')
    expect(await treeSizeAsync(root)).toEqual(treeSize(root))
    expect(await treeSizeAsync(root, ['x', 'missing'])).toEqual(treeSize(root, ['x', 'missing']))
    expect(await treeSizeAsync(join(root, 'none'))).toEqual({ files: 0, bytes: 0 })
  })
})
