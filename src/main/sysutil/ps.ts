import { execFile } from 'node:child_process'
import { join } from 'node:path'
import log from 'electron-log/main'

/** A program of Windows by full path, so a program of the same name elsewhere on PATH is never started. */
export const system32 = (...parts: string[]): string => join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', ...parts)
export const POWERSHELL = system32('WindowsPowerShell', 'v1.0', 'powershell.exe')

/**
 * Run a fixed PowerShell script (13.1: no wmic, no values from the server, nothing typed by the
 * person spliced into it: values go through the environment or stdin). Read-only queries only.
 * Output is forced to UTF-8 so Korean paths survive. Resolves '' on failure.
 * No "-ExecutionPolicy Bypass", "-EncodedCommand" or hidden-window switches: security programs
 * count those as signs of malware (M9-1), and the policy does not apply to -Command anyway.
 * `name` goes into the log, so every run can be traced.
 */
export function runPs(name: string, script: string, timeoutMs = 30000): Promise<string> {
  const full = `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ${script}`
  log.info(`[ps] ${name}`)
  return new Promise((resolve) => {
    execFile(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', full], { windowsHide: true, timeout: timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }, (_err, stdout) => resolve((stdout ?? '').trim()))
  })
}

export async function runPsJson<T>(name: string, script: string, timeoutMs?: number): Promise<T | null> {
  const out = await runPs(name, script, timeoutMs)
  if (!out) return null
  try {
    return JSON.parse(out) as T
  } catch {
    return null
  }
}

/** PowerShell ConvertTo-Json returns a bare object for one element; normalize to an array. */
export const arr = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])
