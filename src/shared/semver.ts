export const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/

/** Compare two semver strings. Pre-release versions sort before the release. */
export function compareVersions(a: string, b: string): number {
  const ma = SEMVER_RE.exec(a.trim())
  const mb = SEMVER_RE.exec(b.trim())
  if (!ma || !mb) return a.localeCompare(b)
  for (let i = 1; i <= 3; i++) {
    const d = Number(ma[i]) - Number(mb[i])
    if (d !== 0) return d < 0 ? -1 : 1
  }
  const pa = ma[4]
  const pb = mb[4]
  if (pa === pb) return 0
  if (!pa) return 1
  if (!pb) return -1
  return pa.localeCompare(pb, undefined, { numeric: true })
}
