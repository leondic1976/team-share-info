import { createReadStream } from 'node:fs'

/**
 * A small ZIP writer without dependencies (store method: files are put in as they are, which
 * is what office files that are already compressed — hwp, xlsx, pdf, jpg — need anyway).
 * Entries come from files on disk or from buffers and are streamed, so a bundle of large files
 * never sits in memory. Names are UTF-8 (general purpose flag bit 11), which Windows Explorer
 * reads. No ZIP64: a bundle stays under 4 GB and 65,535 entries (checked by `zipSize`).
 */

export interface ZipEntry {
  /** the name inside the archive ("a/b.txt" for a folder) */
  name: string
  /** a file on disk, or */
  path?: string
  /** the content itself */
  data?: Buffer
  size?: number
  mtime?: Date
}

const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

/** CRC-32 (the ZIP one); pass the previous value to continue over several chunks. */
export function crc32(buf: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

async function fileCrc(path: string): Promise<{ crc: number; size: number }> {
  let crc = 0
  let size = 0
  for await (const chunk of createReadStream(path)) {
    crc = crc32(chunk as Buffer, crc)
    size += (chunk as Buffer).length
  }
  return { crc, size }
}

/** MS-DOS time and date of a moment (local time, as Explorer shows it). */
function dosTime(d: Date): { time: number; date: number } {
  const y = Math.max(1980, d.getFullYear())
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  }
}

const MAX32 = 0xffffffff

export class ZipTooLargeError extends Error {}

/** Exact byte size of the archive the entries make (sizes must be known). */
export function zipSize(entries: { name: string; size: number }[]): number {
  if (entries.length > 0xffff) throw new ZipTooLargeError('한 번에 묶을 수 있는 파일 수(65,535개)를 넘었습니다.')
  let total = 22
  for (const e of entries) {
    const n = Buffer.byteLength(e.name, 'utf8')
    total += 30 + n + e.size + 46 + n
  }
  if (total > MAX32) throw new ZipTooLargeError('파일이 너무 커서(4GB 이상) 한 번에 묶을 수 없습니다.')
  return total
}

function header(sig: number, central: boolean, f: { name: Buffer; crc: number; size: number; time: number; date: number; offset: number }): Buffer {
  const b = Buffer.alloc(central ? 46 : 30)
  let p = 0
  b.writeUInt32LE(sig, p)
  p += 4
  if (central) {
    b.writeUInt16LE(20, p) // made by
    p += 2
  }
  b.writeUInt16LE(20, p) // version needed
  b.writeUInt16LE(0x0800, p + 2) // UTF-8 names
  b.writeUInt16LE(0, p + 4) // stored
  b.writeUInt16LE(f.time, p + 6)
  b.writeUInt16LE(f.date, p + 8)
  b.writeUInt32LE(f.crc, p + 10)
  b.writeUInt32LE(f.size, p + 14)
  b.writeUInt32LE(f.size, p + 18)
  b.writeUInt16LE(f.name.length, p + 22)
  // extra length 0; for central: comment 0, disk 0, internal attr 0, external attr 0, then offset
  if (central) b.writeUInt32LE(f.offset, 42)
  return b
}

/**
 * The archive as a stream of chunks. Each file is read twice (once for its CRC, then into the
 * archive), so nothing has to be held back and the stored sizes are exact.
 */
export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const { crc, size } = e.data ? { crc: crc32(e.data), size: e.data.length } : await fileCrc(e.path!)
    if (offset + 30 + name.length + size > MAX32) throw new ZipTooLargeError('파일이 너무 커서(4GB 이상) 한 번에 묶을 수 없습니다.')
    const { time, date } = dosTime(e.mtime ?? new Date())
    const f = { name, crc, size, time, date, offset }
    yield Buffer.concat([header(0x04034b50, false, f), name])
    if (e.data) yield e.data
    else {
      let n = 0
      for await (const chunk of createReadStream(e.path!)) {
        n += (chunk as Buffer).length
        yield chunk as Buffer
      }
      // the file changed between the two reads: the archive would be broken
      if (n !== size) throw new Error(`파일이 읽는 중에 바뀌었습니다: ${e.name}`)
    }
    central.push(header(0x02014b50, true, f), name)
    offset += 30 + name.length + size
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  yield Buffer.concat([cd, end])
}

/** The whole archive in memory (small bundles, tests). */
export async function zipBuffer(entries: ZipEntry[]): Promise<Buffer> {
  const parts: Buffer[] = []
  for await (const c of zipStream(entries)) parts.push(c)
  return Buffer.concat(parts)
}

/** Read a stored (uncompressed) archive back: name -> content, in order. Checks every CRC. */
export function readStoredZip(buf: Buffer): { name: string; data: Buffer }[] {
  let e = buf.length - 22
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Error('ZIP 파일이 아닙니다.')
  const n = buf.readUInt16LE(e + 10)
  let p = buf.readUInt32LE(e + 16)
  const out: { name: string; data: Buffer }[] = []
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP 목차가 손상되었습니다.')
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const size = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extra = buf.readUInt16LE(p + 30)
    const comment = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    if (method !== 0) throw new Error(`압축된 항목은 읽지 않습니다: ${name}`)
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = Buffer.from(buf.subarray(start, start + size))
    if (crc32(data) !== crc) throw new Error(`CRC가 맞지 않습니다: ${name}`)
    out.push({ name, data })
    p += 46 + nameLen + extra + comment
  }
  return out
}
