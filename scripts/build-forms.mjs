// Packs resources/forms (official form documents: .hwp, .pdf) into ONE file, resources/forms.pack.
// The installer then no longer writes two dozen document files and deletes/rewrites them at
// every update - an unsigned program doing that to documents is exactly what the ransomware
// behaviour guards of security programs look for. The server reads the forms from the pack
// (src/server/forms-seed.ts); the loose folder is only used when running from source.
//   node scripts/build-forms.mjs [output file]
import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dir = join(root, 'resources', 'forms')
const out = resolve(process.argv[2] ?? join(root, 'resources', 'forms.pack'))

if (!existsSync(join(dir, 'index.json'))) {
  rmSync(out, { force: true })
  console.log('forms: nothing to pack')
  process.exit(0)
}
const files = {}
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n)
    if (statSync(p).isDirectory()) walk(p)
    else if (n !== 'index.json') files[relative(dir, p).replace(/\\/g, '/')] = readFileSync(p).toString('base64')
  }
}
walk(dir)
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'))
writeFileSync(out, gzipSync(Buffer.from(JSON.stringify({ format: 1, index, files }), 'utf8'), { level: 9 }))
console.log(`forms: ${Object.keys(files).length} files -> ${relative(root, out)} (${statSync(out).size} bytes)`)
