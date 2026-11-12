/** Pure IPv4 helpers shared by server (allowed ranges) and UI (preview). */

export function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip.trim())
  if (!m) return null
  const parts = m.slice(1).map(Number)
  if (parts.some((p) => p > 255)) return null
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

/** Strip IPv4-mapped IPv6 prefix ("::ffff:192.168.0.5"). */
export function normalizeIp(ip: string): string {
  const v = ip.trim()
  if (v.startsWith('::ffff:')) return v.slice(7)
  if (v === '::1') return '127.0.0.1'
  return v
}

export function isLoopback(ip: string): boolean {
  const v = normalizeIp(ip)
  return v === '127.0.0.1' || v.startsWith('127.')
}

export function inCidr(ip: string, cidr: string): boolean {
  const [base, bitsStr] = cidr.split('/')
  const bits = Number(bitsStr)
  const a = ipv4ToInt(normalizeIp(ip))
  const b = ipv4ToInt(base)
  if (a === null || b === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return false
  if (bits === 0) return true
  const mask = (0xffffffff << (32 - bits)) >>> 0
  return (a & mask) === (b & mask)
}

/** Empty list means "no restriction". Loopback is always allowed. */
export function ipAllowed(ip: string, cidrs: string[]): boolean {
  if (isLoopback(ip)) return true
  if (!cidrs.length) return true
  return cidrs.some((c) => inCidr(ip, c))
}

/** e.g. 192.168.10.5 + 255.255.255.0 -> 192.168.10.0/24 */
export function cidrOf(ip: string, netmask: string): string | null {
  const a = ipv4ToInt(ip)
  const m = ipv4ToInt(netmask)
  if (a === null || m === null) return null
  let bits = 0
  for (let i = 31; i >= 0; i--) if ((m >>> i) & 1) bits++
  const net = (a & m) >>> 0
  return `${[24, 16, 8, 0].map((s) => (net >>> s) & 255).join('.')}/${bits}`
}

/** Accepts "1.2.3.4", "1.2.3.4:47800", "pc-name", "http://1.2.3.4:47800/" and returns a base URL. */
export function toServerUrl(input: string, defaultPort: number): string | null {
  let v = input.trim()
  if (!v) return null
  v = v.replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
  if (!/^[a-z0-9.\-_]+(:\d{1,5})?$/i.test(v)) return null
  if (!/:\d+$/.test(v)) v = `${v}:${defaultPort}`
  return `http://${v}`
}
