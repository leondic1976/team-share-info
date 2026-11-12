import { execFile } from 'node:child_process'

/**
 * Run a fixed PowerShell script (13.1: no wmic, no values from the server).
 * Output is forced to UTF-8 so Korean paths survive. Resolves '' on failure.
 */
export function runPs(script: string, timeoutMs = 30000): Promise<string> {
  const full = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve((stdout ?? '').trim()))
  })
}

export async function runPsJson<T>(script: string, timeoutMs?: number): Promise<T | null> {
  const out = await runPs(script, timeoutMs)
  if (!out) return null
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

/** PowerShell ConvertTo-Json returns a bare object for one element; normalize to an array. */
export const arr = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])
