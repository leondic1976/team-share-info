/**
 * Text files made on Korean Windows PCs are often not UTF-8: Notepad and Excel still save
 * CP949 (EUC-KR) and some tools write UTF-16. Pick the encoding from the bytes:
 * UTF-16 BOM -> UTF-16, valid UTF-8 (with or without BOM) -> UTF-8, otherwise CP949.
 */
export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr'

export function detectTextEncoding(bytes: Uint8Array): TextEncodingName {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return 'utf-8'
  } catch {
    return 'euc-kr'
  }
}

/** Decode with the detected encoding; a leading BOM is dropped. */
export function decodeText(bytes: Uint8Array): string {
  const enc = detectTextEncoding(bytes)
  const text = enc === 'euc-kr' ? decodeCp949(bytes) : new TextDecoder(enc).decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/*
 * CP949 = EUC-KR (KS X 1001) + the 8,822 Hangul syllables KS X 1001 lacks (똠, 쏼, 햏 ...), put
 * in Unicode order on lead bytes 0x81-0xC6 with trail bytes below 0xA1. Chromium's
 * TextDecoder('euc-kr') knows them, Node's (ICU) does not, so the extension is decoded here and
 * the rest is left to TextDecoder: the same result in the renderer, the main process and tests.
 */
let extTable: string[] | null = null

/** Position of a trail byte in the extension rows, or -1. */
function trailIndex(t: number): number {
  if (t >= 0x41 && t <= 0x5a) return t - 0x41
  if (t >= 0x61 && t <= 0x7a) return t - 0x61 + 26
  if (t >= 0x81 && t <= 0xfe) return t - 0x81 + 52
  return -1
}

/** Index into the extension table for a byte pair, or -1 for a KS X 1001 (or invalid) pair. */
function extIndex(lead: number, trail: number): number {
  const ti = trailIndex(trail)
  if (ti < 0) return -1
  if (lead >= 0x81 && lead <= 0xa0) return (lead - 0x81) * 178 + ti
  if (lead >= 0xa1 && lead <= 0xc6 && ti < 84 && (lead < 0xc6 || trail <= 0x52)) return 32 * 178 + (lead - 0xa1) * 84 + ti
  return -1
}

function extensionTable(): string[] {
  if (extTable) return extTable
  // the 2,350 KS X 1001 syllables are rows 0xB0-0xC8; every other syllable is in the extension
  const ks = new Uint8Array(25 * 94 * 2)
  let k = 0
  for (let lead = 0xb0; lead <= 0xc8; lead++)
    for (let trail = 0xa1; trail <= 0xfe; trail++) {
      ks[k++] = lead
      ks[k++] = trail
    }
  const inKs = new Set(new TextDecoder('euc-kr').decode(ks))
  const out: string[] = []
  for (let c = 0xac00; c <= 0xd7a3; c++) {
    const ch = String.fromCharCode(c)
    if (!inKs.has(ch)) out.push(ch)
  }
  extTable = out
  return out
}

export function decodeCp949(bytes: Uint8Array): string {
  const std = new TextDecoder('euc-kr')
  let out = ''
  let from = 0
  let i = 0
  while (i < bytes.length) {
    const b = bytes[i] as number
    if (b < 0x81 || b === 0xff || i + 1 >= bytes.length) {
      i++
      continue
    }
    const x = extIndex(b, bytes[i + 1] as number)
    if (x >= 0) {
      out += std.decode(bytes.subarray(from, i)) + (extensionTable()[x] ?? '�')
      from = i + 2
    }
    i += 2
  }
  return out + std.decode(bytes.subarray(from))
}
