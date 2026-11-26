import { execFile, execFileSync } from 'node:child_process'
import log from 'electron-log/main'
import { POWERSHELL } from './sysutil/ps'

/**
 * Windows DPAPI (CurrentUser scope) through PowerShell. Unlike Electron safeStorage,
 * the key does not live in Chromium's "Local State" file, so a crash right after
 * writing cannot make the data unreadable (13.14). safeStorage cannot take over either:
 * it could not read device.dpapi, connections.dpapi and cache-key.dpapi written so far.
 * The script is one of two fixed lines; the data goes in through stdin as base64.
 */
const PROLOGUE = 'Add-Type -AssemblyName System.Security; $in=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($in);'

function run(script: string, input: string): string {
  log.info('[dpapi] run')
  return execFileSync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PROLOGUE + script], {
    input,
    windowsHide: true,
    timeout: 20000,
    encoding: 'utf8'
  }).trim()
}

export function dpapiProtect(data: Buffer): Buffer {
  const out = run("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))", data.toString('base64'))
  return Buffer.from(out, 'base64')
}

export function dpapiUnprotect(data: Buffer): Buffer {
  const out = run("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", data.toString('base64'))
  return Buffer.from(out, 'base64')
}

/** The same without blocking the main process (start-up work that can wait for the answer). */
function runAsync(script: string, input: string): Promise<string> {
  log.info('[dpapi] run')
  return new Promise((resolve, reject) => {
    const p = execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', PROLOGUE + script], { windowsHide: true, timeout: 20000, encoding: 'utf8' }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.trim())
    )
    p.stdin?.end(input)
  })
}

export async function dpapiProtectAsync(data: Buffer): Promise<Buffer> {
  return Buffer.from(await runAsync("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))", data.toString('base64')), 'base64')
}

export async function dpapiUnprotectAsync(data: Buffer): Promise<Buffer> {
  return Buffer.from(await runAsync("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))", data.toString('base64')), 'base64')
}
