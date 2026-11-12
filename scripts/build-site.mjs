// Builds the GitHub Pages site (_site/) for a release (CI, .github/workflows/release.yml):
//   _site/index.html          download page (site/index.html)
//   _site/releases.json       version history (previous history + this release)
//   _site/updates/latest.yml  electron-updater feed (generic provider)
//   _site/updates/TeamHub-Setup-x.y.z.exe(.blockmap)
// Only the newest installer is hosted; older versions stay in the GitHub Releases of the repo.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const out = join(root, '_site')
const releaseDir = join(root, 'release')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const site = process.env.SITE_URL ?? 'https://leondic1976.github.io/team-share-info/'
const notes = (process.env.RELEASE_NOTES ?? '').trim()

// Plugin/site-only deploys (no new app build): reuse the installer that is already online.
if (!existsSync(join(releaseDir, 'latest.yml'))) {
  mkdirSync(releaseDir, { recursive: true })
  const resp = await fetch(`${site}updates/latest.yml`, { cache: 'no-store' }).catch(() => null)
  if (!resp || !resp.ok) {
    // nothing published yet: deploy the pages and plugins without an installer
    rmSync(out, { recursive: true, force: true })
    mkdirSync(out, { recursive: true })
    for (const f of readdirSync(join(root, 'site'))) copyFileSync(join(root, 'site', f), join(out, f))
    writeFileSync(join(out, 'releases.json'), '[]')
    writeFileSync(join(out, '.nojekyll'), '')
    execFileSync(process.execPath, [join(root, 'scripts', 'build-plugins.mjs'), join(out, 'plugins')], { stdio: 'inherit' })
    console.log('site built without an installer (no release yet)')
    process.exit(0)
  }
  const y = await resp.text()
  writeFileSync(join(releaseDir, 'latest.yml'), y)
  const p = (/^path:\s*'?([^'\n]+)'?/m.exec(y)?.[1] ?? '').trim()
  for (const f of [p, `${p}.blockmap`]) {
    const r = await fetch(`${site}updates/${encodeURIComponent(f)}`)
    if (r.ok) writeFileSync(join(releaseDir, f), Buffer.from(await r.arrayBuffer()))
  }
  process.env.REUSE_RELEASE = '1'
}
const yml = readFileSync(join(releaseDir, 'latest.yml'), 'utf8')
const field = (k) => (new RegExp(`^${k}:\\s*'?([^'\\n]+)'?\\s*$`, 'm').exec(yml)?.[1] ?? '').trim()
const version = field('version')
const file = field('path')
const sha512 = field('sha512')
if (version !== pkg.version && !process.env.REUSE_RELEASE) throw new Error(`latest.yml version ${version} != package.json ${pkg.version}`)
if (!existsSync(join(releaseDir, file))) throw new Error(`installer not found: ${file}`)

let history = []
try {
  const r = await fetch(`${site}releases.json`, { cache: 'no-store' })
  if (r.ok) history = await r.json()
} catch {
  // first release or site not reachable
}
const d = new Date()
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
if (!process.env.REUSE_RELEASE || !history.some((h) => h.version === version))
  history = [{ version, date, file, size: statSync(join(releaseDir, file)).size, sha512, notes }, ...history.filter((h) => h.version !== version)].slice(0, 100)

rmSync(out, { recursive: true, force: true })
mkdirSync(join(out, 'updates'), { recursive: true })
for (const f of readdirSync(join(root, 'site'))) copyFileSync(join(root, 'site', f), join(out, f))
writeFileSync(join(out, 'releases.json'), JSON.stringify(history, null, 2))
writeFileSync(join(out, '.nojekyll'), '')
for (const f of ['latest.yml', file, `${file}.blockmap`]) if (existsSync(join(releaseDir, f))) copyFileSync(join(releaseDir, f), join(out, 'updates', f))
execFileSync(process.execPath, [join(root, 'scripts', 'build-plugins.mjs'), join(out, 'plugins')], { stdio: 'inherit' })
console.log(`site built for v${version} (${history.length} versions in history)`)
