import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32, readStoredZip, zipBuffer, zipSize, ZipTooLargeError } from '../../src/node/zip'

describe('zip (store method, src/node/zip.ts)', () => {
  it('crc32 matches the standard check value, also in chunks', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.from('56789'), crc32(Buffer.from('1234')))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('writes files from disk and buffers with UTF-8 names; reads back; the size is known beforehand', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamhub-zip-'))
    try {
      const big = Buffer.alloc(300_000, 7)
      big.write('끝', 299_990)
      writeFileSync(join(dir, 'a.bin'), big)
      const entries = [
        { name: '총무팀_홍길동_예산요구서.xlsx', path: join(dir, 'a.bin'), size: big.length, mtime: new Date(2026, 10, 26, 9, 30, 10) },
        { name: '폴더/제출내용.txt', data: Buffer.from('내용'), size: Buffer.byteLength('내용') },
        { name: 'empty.txt', data: Buffer.alloc(0), size: 0 }
      ]
      const zip = await zipBuffer(entries)
      expect(zip.length).toBe(zipSize(entries))
      const back = readStoredZip(zip)
      expect(back.map((e) => e.name)).toEqual(['총무팀_홍길동_예산요구서.xlsx', '폴더/제출내용.txt', 'empty.txt'])
      expect(back[0].data.equals(big)).toBe(true)
      expect(back[1].data.toString()).toBe('내용')
      expect(back[2].data.length).toBe(0)
      // local header: stored, UTF-8 flag, DOS time of the given moment
      expect(zip.readUInt32LE(0)).toBe(0x04034b50)
      expect(zip.readUInt16LE(6)).toBe(0x0800)
      expect(zip.readUInt16LE(8)).toBe(0)
      expect(zip.readUInt16LE(10)).toBe((9 << 11) | (30 << 5) | 5)
      expect(zip.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (11 << 5) | 26)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('an empty archive is valid; a broken CRC is caught; too large bundles are refused', async () => {
    const empty = await zipBuffer([])
    expect(empty.length).toBe(22)
    expect(readStoredZip(empty)).toEqual([])
    const z = await zipBuffer([{ name: 'a.txt', data: Buffer.from('abc') }])
    z[30 + 5] = 'x'.charCodeAt(0)
    expect(() => readStoredZip(z)).toThrow(/CRC/)
    expect(() => zipSize([{ name: 'big', size: 0xffffffff }])).toThrow(ZipTooLargeError)
    expect(() => zipSize(Array.from({ length: 70_000 }, (_, i) => ({ name: String(i), size: 0 })))).toThrow(ZipTooLargeError)
  })
})
