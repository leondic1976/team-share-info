import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkTarget, copyEntries, normalizeTarget, removeEntries, treeSize, verifyCopy } from '../../src/node/datamove'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'th-move-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const noProtect = (): boolean => false

describe('data folder move (6.20)', () => {
  it('target rules: same, inside, parent, network share, protected, marker', () => {
    const from = join(root, 'a')
    mkdirSync(from)
    const base = { from, marker: 'local.db', needBytes: 10, isProtected: noProtect }
    expect(checkTarget({ ...base, to: from }).error).toMatch(/같습니다/)
    expect(checkTarget({ ...base, to: join(from, 'sub') }).error).toMatch(/안의 폴더/)
    expect(checkTarget({ ...base, to: root }).error).toMatch(/상위 폴더/)
    expect(checkTarget({ ...base, to: '\\\\srv\\share\\x' }).error).toMatch(/네트워크/)
    expect(checkTarget({ ...base, to: join(root, 'b'), isProtected: () => true }).error).toMatch(/시스템/)
    const ok = checkTarget({ ...base, to: join(root, 'b') })
    expect(ok).toMatchObject({ ok: true, hasData: false })
    expect(existsSync(join(root, 'b'))).toBe(true)
    writeFileSync(join(root, 'b', 'local.db'), '')
    expect(checkTarget({ ...base, to: join(root, 'b') }).hasData).toBe(true)
    expect(checkTarget({ ...base, needBytes: Number.MAX_SAFE_INTEGER, to: join(root, 'c') }).error).toMatch(/빈 공간/)
  })

  it('a drive root gets a sub-folder', () => {
    expect(normalizeTarget('D:\\', 'TeamHub 내 자료')).toBe('D:\\TeamHub 내 자료')
    expect(normalizeTarget('D:\\자료', 'TeamHub 내 자료')).toBe('D:\\자료')
  })

  it('copies a live WAL database consistently plus files, verifies, removes the old side files', async () => {
    const from = join(root, 'from')
    const to = join(root, 'to')
    mkdirSync(join(from, 'plugins', 'ladder'), { recursive: true })
    writeFileSync(join(from, 'plugins', 'ladder', 'index.html'), '<p>사다리</p>')
    const db = new DatabaseSync(join(from, 'local.db'))
    db.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (v TEXT)')
    const ins = db.prepare('INSERT INTO t VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run(`행 ${i}`)
    expect(existsSync(join(from, 'local.db-wal'))).toBe(true) // rows still only in the WAL file
    const seen: number[] = []
    const copied = await copyEntries(from, to, ['local.db', 'plugins', 'missing'], (p) => seen.push(p.doneBytes))
    expect(copied.sort()).toEqual(['local.db', join('plugins', 'ladder', 'index.html')].sort())
    expect(seen.length).toBeGreaterThan(0)
    expect(verifyCopy(from, to, copied)).toBeNull()
    const copy = new DatabaseSync(join(to, 'local.db'), { readOnly: true })
    expect((copy.prepare('SELECT count(*) AS n FROM t').get() as { n: number }).n).toBe(500)
    copy.close()
    expect(readFileSync(join(to, 'plugins', 'ladder', 'index.html'), 'utf8')).toBe('<p>사다리</p>')
    db.close()
    expect(removeEntries(from, ['local.db', 'plugins'])).toEqual([])
    expect(['local.db', 'local.db-wal', 'local.db-shm', 'plugins'].some((n) => existsSync(join(from, n)))).toBe(false)
    expect(treeSize(from).files).toBe(0)
  })

  it('verification catches a missing or different file', async () => {
    const from = join(root, 'f')
    const to = join(root, 't')
    mkdirSync(join(from, 'files'), { recursive: true })
    writeFileSync(join(from, 'files', 'x.bin'), 'abcdef')
    const copied = await copyEntries(from, to, ['files'])
    writeFileSync(join(to, 'files', 'x.bin'), 'abc')
    expect(verifyCopy(from, to, copied)).toMatch(/크기가 다른/)
    rmSync(join(to, 'files', 'x.bin'))
    expect(verifyCopy(from, to, copied)).toMatch(/복사되지 않은/)
  })
})
