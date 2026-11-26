import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

/**
 * Rules that keep TeamHub away from what Windows Security, ransomware protection and virus
 * scanners react to (CLAUDE.md, instruction 129). The main process, the server and the
 * Node helpers are scanned like `no-emoji.test.ts` scans what people see.
 */
const root = resolve(__dirname, '..', '..')
const DIRS = ['src/main', 'src/server', 'src/node']

interface Line {
  file: string
  line: number
  text: string
}

function sources(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|mts|cts|js|mjs)$/.test(name)) out.push({ file: relative(root, p).replace(/\\/g, '/'), text: readFileSync(p, 'utf8') })
    }
  }
  for (const d of DIRS) walk(join(root, d))
  return out
}

const files = sources()
// code only: comments may name what is forbidden
const isComment = (t: string): boolean => /^\s*(\/\/|\/\*|\*)/.test(t)
const lines: Line[] = files.flatMap((f) =>
  f.text
    .split(/\r?\n/)
    .map((text, i) => ({ file: f.file, line: i + 1, text }))
    .filter((l) => !isComment(l.text))
)
const where = (hits: Line[]): string[] => hits.map((h) => `${h.file}:${h.line}: ${h.text.trim()}`)
const find = (re: RegExp, allowed: string[] = []): string[] => where(lines.filter((l) => re.test(l.text) && !allowed.includes(l.file)))

describe('system safety rules', () => {
  it('scans the main process, the server and the Node helpers', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(files.some((f) => f.file === 'src/main/firewall.ts')).toBe(true)
  })

  it('never hides or encodes PowerShell', () => {
    expect(find(/-EncodedCommand|-enc\s|-e\s+[A-Za-z0-9+/=]{20,}/i)).toEqual([])
    expect(find(/WindowStyle\s+Hidden|-w\s+hidden/i)).toEqual([])
    expect(find(/ExecutionPolicy\s+(Bypass|Unrestricted)/i)).toEqual([])
    expect(find(/Invoke-Expression|\biex\b|DownloadString|DownloadFile|Invoke-WebRequest|\biwr\b|Start-BitsTransfer/i)).toEqual([])
  })

  it('starts PowerShell only by its full path from sysutil/ps.ts', () => {
    expect(find(/['"`]powershell(\.exe)?['"`]/i, ['src/main/sysutil/ps.ts'])).toEqual([])
    // elevation (Windows administrator prompt) only for the firewall rules the person asked for
    expect(find(/Start-Process|-Verb\s+RunAs/i, ['src/main/firewall.ts'])).toEqual([])
  })

  it('runs programs without a shell and never builds a command line from strings', () => {
    expect(find(/shell:\s*true/)).toEqual([])
    expect(find(/import\s*{[^}]*\b(exec|execSync)\b[^}]*}\s*from\s*['"](node:)?child_process['"]/)).toEqual([])
    expect(find(/child_process['"]\)\.exec\(/)).toEqual([])
  })

  it('does not write to the registry (autostart goes through app.setLoginItemSettings)', () => {
    expect(find(/Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|Remove-Item\s+-Path\s+['"]?HK|New-Item\s+-Path\s+['"]?HK|\breg(\.exe)?['"]?\s*,?\s*\[?\s*['"]?(add|delete|import)\b/i)).toEqual([])
    expect(find(/setAsDefaultProtocolClient/)).toEqual([])
  })

  it('never starts in a protected folder (Documents, Desktop, Pictures, Videos, Music)', () => {
    // Allowed: listing them as places to browse or search (read only), and the list of protected folders itself.
    const READ_ONLY = ['src/main/files/fm.ts', 'src/main/files/index.ts', 'src/main/save-dir.ts']
    expect(find(/getPath\(\s*['"](documents|desktop|pictures|videos|music)['"]\s*\)/, READ_ONLY)).toEqual([])
    for (const f of ['src/main/files/fm.ts', 'src/main/files/index.ts']) {
      // a place listed there is only read: no write call takes it as a target
      const text = files.find((x) => x.file === f)?.text ?? ''
      expect(text).not.toMatch(/writeFileSync\(\s*app\.getPath/)
    }
  })

  it('listens on the office network only for the installed app', () => {
    // every literal "all interfaces" address is the one of the server, behind the `lan` switch
    expect(find(/['"`]0\.0\.0\.0['"`]/, ['src/server/index.ts'])).toEqual([])
    const server = files.find((f) => f.file === 'src/server/index.ts')?.text ?? ''
    expect(server).toMatch(/return lan \? bindIp \|\| '0\.0\.0\.0' : LOOPBACK/)
    expect(server).toMatch(/app\.listen\(\{ port: net\.port, host \}\)/)
    // TCP listeners name their address
    expect(where(lines.filter((l) => /\.listen\(/.test(l.text) && !/host|127\.0\.0\.1/.test(l.text)))).toEqual([])
    // UDP sockets (server search) bind with an address: 127.0.0.1 outside the installed app
    expect(where(lines.filter((l) => /sock\.bind\(/.test(l.text) && !/sock\.bind\([^,]+,/.test(l.text)))).toEqual([])
    const main = files.find((f) => f.file === 'src/main/netpolicy.ts')?.text ?? ''
    expect(main).toMatch(/if \(process\.env\.TEAMHUB_E2E\) return false/)
    expect(main).toMatch(/return app\.isPackaged \|\| process\.env\.TEAMHUB_LAN === '1'/)
  })
})
