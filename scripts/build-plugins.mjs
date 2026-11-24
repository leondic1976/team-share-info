// Pack every plugins/<id>/ folder into <out>/<id>-<version>.thplugin and write
// <out>/catalog.json for the download site's plugin cards (확장 기능 모음).
//   node scripts/build-plugins.mjs [outDir=_site/plugins]
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(root, process.argv[2] ?? '_site/plugins')
const src = join(root, 'plugins')
mkdirSync(out, { recursive: true })

const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]))
// one icon table for the app and the site (src/shared/icons.json): the site's cards draw "iconSvg"
const icons = JSON.parse(readFileSync(join(root, 'src', 'shared', 'icons.json'), 'utf8'))
const catalog = []
for (const id of readdirSync(src)) {
  const dir = join(src, id)
  if (!statSync(dir).isDirectory()) continue
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'))
  if (manifest.id !== id) throw new Error(`${id}: manifest id ${manifest.id} differs from folder`)
  const files = {}
  for (const f of walk(dir)) {
    const rel = relative(dir, f).replace(/\\/g, '/')
    if (rel === 'manifest.json' || rel.startsWith('.')) continue
    files[rel] = readFileSync(f).toString('base64')
  }
  // "updated" (YYYY-MM-DD, the gallery's 최신순) is written in the manifest by hand: CI checks out
  // without history, so a date taken from git or the file times would be the same for all.
  const { features, updated, ...m } = manifest
  if (updated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(updated)) throw new Error(`${id}: manifest "updated" must be YYYY-MM-DD`)
  const bundle = Buffer.from(JSON.stringify({ format: 'teamhub-plugin@1', manifest: m, files }))
  const file = `${id}-${m.version}.thplugin`
  writeFileSync(join(out, file), bundle)
  catalog.push({ id, name: m.name, version: m.version, description: m.description ?? '', author: m.author ?? '', icon: m.icon ?? '', iconName: m.iconName ?? '', iconSvg: icons[m.iconName] ?? icons.puzzle, permissions: m.permissions ?? [], file, sha256: createHash('sha256').update(bundle).digest('hex'), size: bundle.length, features: features ?? [], updated: updated ?? '' })
  console.log(`packed ${file} (${bundle.length} bytes)`)
}
writeFileSync(join(out, 'catalog.json'), JSON.stringify(catalog, null, 2))
