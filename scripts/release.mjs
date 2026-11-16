// Version management: pnpm release <patch|minor|major|x.y.z> "변경 내용"
// Bumps package.json, commits, creates an annotated tag vX.Y.Z (the message becomes the
// release notes) and pushes. GitHub Actions then builds, publishes the download site and
// the update feed (.github/workflows/release.yml).
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const [bump = 'patch', ...rest] = process.argv.slice(2)
const notes = rest.join(' ').trim()
const git = (...a) => execFileSync('git', a, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] }).toString().trim()

if (git('status', '--porcelain')) {
  console.error('커밋하지 않은 변경이 있습니다. 먼저 커밋하세요.')
  process.exit(1)
}
const file = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(file, 'utf8'))
const [a, b, c] = pkg.version.split('-')[0].split('.').map(Number)
const next = /^\d+\.\d+\.\d+$/.test(bump) ? bump : bump === 'major' ? `${a + 1}.0.0` : bump === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${c + 1}`
if (!notes) {
  console.error('변경 내용을 적으세요. 예: pnpm release patch "메신저 알림 오류 수정"')
  process.exit(1)
}
pkg.version = next
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`)
git('add', 'package.json')
git('commit', '-m', `release: v${next}`, '-m', notes)
git('tag', '-a', `v${next}`, '-m', notes)
git('push', 'origin', 'HEAD', '--follow-tags')
console.log(`v${next} 태그를 올렸습니다. GitHub Actions에서 빌드·배포가 진행됩니다(release 워크플로가 태그에서 한 번, 이어서 main에서 한 번 실행되어 다운로드 사이트를 갱신합니다).`)
