import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/**
 * The long form of a path: Windows may hand out 8.3 short names (C:\Users\RUNNER~1\..., also for
 * people with long account names), which would not match the home folder in the checks below.
 * The part that exists is expanded; the rest (a folder still to be made) is kept as typed.
 */
export function longPath(p: string): string {
  let cur = resolve(p)
  const rest: string[] = []
  while (!existsSync(cur)) {
    const up = dirname(cur)
    if (up === cur) return resolve(p)
    rest.unshift(basename(cur))
    cur = up
  }
  try {
    return join(realpathSync.native(cur), ...rest)
  } catch {
    return resolve(p)
  }
}
