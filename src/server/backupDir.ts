import { existsSync } from 'node:fs'
import { mkdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, parse, relative, resolve } from 'node:path'
import { isProtectedPath } from '../shared/fm'
import { longPath } from '../node/longpath'

export { longPath }

/**
 * Checking a new server backup folder (관리 → 조직·운영 설정 → 백업 위치) before it is saved:
 * a folder every later backup fails in (a typo, a drive that is not there, no permission)
 * must be refused at once with a reason, not found out days later. A network folder
 * (\\NAS\share) is fine for backups; it is tried with a time limit so an unreachable one
 * does not hold the server up.
 */

const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').toLowerCase()
const inside = (child: string, parent: string): boolean => {
  const r = relative(norm(parent), norm(child))
  return !r.startsWith('..') && !isAbsolute(r)
}

const env = (): Parameters<typeof isProtectedPath>[1] => ({
  systemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  programFiles: [process.env.ProgramFiles ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'],
  programData: process.env.ProgramData ?? 'C:\\ProgramData',
  usersDir: join(longPath(homedir()), '..'),
  home: longPath(homedir())
})

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((ok, fail) => {
    const t = setTimeout(() => fail(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        ok(v)
      },
      (e) => {
        clearTimeout(t)
        fail(e)
      }
    )
  })
}

/** null when `dir` can hold the backups; otherwise why not, in Korean. '' (the default folder) is always fine. */
export async function checkBackupDir(dir: string, dataDir: string, opts: { timeoutMs?: number; isProtected?: (p: string) => boolean } = {}): Promise<string | null> {
  const d = dir.trim()
  if (!d) return null
  const unc = /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(d)
  if (!unc && !/^[a-z]:[\\/]/i.test(d)) return '백업 위치는 전체 경로(예: E:\\TeamHub 백업 또는 \\\\NAS\\공유\\TeamHub 백업)로 적으세요.'
  if (/[<>"|?*]/.test(d.slice(2))) return '백업 위치에 쓸 수 없는 문자(< > " | ? *)가 있습니다.'
  const isProtected = opts.isProtected ?? ((p: string) => isProtectedPath(p, env()))
  if (isProtected(unc ? d : longPath(d))) return '드라이브 맨 위나 시스템 폴더, 다른 사용자 폴더에는 백업할 수 없습니다. 그 안에 폴더를 만들어 고르세요(예: E:\\TeamHub 백업).'
  if (!unc && !existsSync(parse(resolve(d)).root)) return `${d.slice(0, 2)} 드라이브를 찾을 수 없습니다. USB나 외장 드라이브라면 연결한 뒤 저장하세요.`
  // the live files folder of the server is not a place for copies of itself
  if (inside(d, join(dataDir, 'files'))) return '서버 자료의 files 폴더 안에는 백업할 수 없습니다. 다른 폴더를 고르세요.'
  if (inside(dataDir, d) && norm(dataDir) !== norm(d)) return '서버 자료 폴더를 품고 있는 상위 폴더에는 백업할 수 없습니다. 그 안에 백업용 폴더를 만들어 고르세요.'
  try {
    const st = await withTimeout(stat(d).catch(() => null), opts.timeoutMs ?? 8000)
    if (st && !st.isDirectory()) return '그 경로는 폴더가 아니라 파일입니다. 폴더를 고르세요.'
    await withTimeout(mkdir(d, { recursive: true }), opts.timeoutMs ?? 8000)
    const probe = join(d, `.teamhub-write-test-${process.pid}`)
    await withTimeout(writeFile(probe, 'ok'), opts.timeoutMs ?? 8000)
    await unlink(probe).catch(() => rm(probe, { force: true }))
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ETIMEDOUT') return unc ? '네트워크 폴더에 연결되지 않습니다(NAS·공유 PC가 켜져 있는지, 주소가 맞는지 확인).' : '그 폴더가 응답하지 않습니다.'
    if (code === 'ENOENT' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EBADNAME')
      return unc ? '네트워크 폴더를 찾을 수 없습니다(NAS·공유 PC가 켜져 있는지, 주소가 맞는지 확인).' : '그 위치에 폴더를 만들 수 없습니다(드라이브나 상위 폴더 확인).'
    if (code === 'ENOSPC') return '그 드라이브에 빈 공간이 없습니다.'
    // (Windows reports an unreachable share in several ways: EPERM, UNKNOWN...)
    if (unc) return '네트워크 폴더에 쓸 수 없습니다(NAS·공유 PC가 켜져 있는지, 주소와 쓰기 권한이 맞는지 확인).'
    return '그 폴더에 쓸 수 없습니다(권한 또는 읽기 전용). 다른 폴더를 고르세요.'
  }
  // (a folder made for the test stays: it is where the backups go)
  return null
}
