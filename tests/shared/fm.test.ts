import { describe, it, expect } from 'vitest'
import { categoryOf, crumbs, isProtectedPath, parentOf, parseSearch, uniqueName, validName } from '../../src/shared/fm'

const env = {
  systemRoot: String.raw`C:\Windows`,
  programFiles: [String.raw`C:\Program Files`, String.raw`C:\Program Files (x86)`],
  programData: String.raw`C:\ProgramData`,
  usersDir: String.raw`C:\Users`,
  home: String.raw`C:\Users\kim`
}

describe('file management helpers (M7-10)', () => {
  it('protects system folders, drive roots and other users', () => {
    expect(isProtectedPath(String.raw`C:\Windows\System32`, env)).toBe(true)
    expect(isProtectedPath(String.raw`c:\program files (x86)\HNC`, env)).toBe(true)
    expect(isProtectedPath('C:\\', env)).toBe(true)
    expect(isProtectedPath('D:', env)).toBe(true)
    expect(isProtectedPath(String.raw`C:\Users\lee\Documents`, env)).toBe(true)
    expect(isProtectedPath(String.raw`D:\$RECYCLE.BIN\x`, env)).toBe(true)
    expect(isProtectedPath(String.raw`C:\Users\kim\Documents\보고서.hwp`, env)).toBe(false)
    expect(isProtectedPath(String.raw`C:\Users\Public\Documents`, env)).toBe(false)
    expect(isProtectedPath(String.raw`D:\업무\2026`, env)).toBe(false)
    expect(isProtectedPath(String.raw`C:\WindowsApps2\x`, env)).toBe(false)
  })

  it('makes unique names and validates names', () => {
    const taken = new Set(['보고서.hwp', '보고서 (2).hwp', '새 폴더'])
    expect(uniqueName('보고서.hwp', (n) => taken.has(n))).toBe('보고서 (3).hwp')
    expect(uniqueName('새 폴더', (n) => taken.has(n), true)).toBe('새 폴더 (2)')
    expect(uniqueName('메모.txt', (n) => taken.has(n))).toBe('메모.txt')
    expect(validName('a/b')).not.toBeNull()
    expect(validName('CON')).not.toBeNull()
    expect(validName('끝에 점.')).not.toBeNull()
    expect(validName('2026 예산(최종).xlsx')).toBeNull()
  })

  it('breadcrumbs and parents', () => {
    expect(crumbs(String.raw`C:\Users\kim\문서`).map((c) => c.path)).toEqual(['C:\\', 'C:\\Users', String.raw`C:\Users\kim`, String.raw`C:\Users\kim\문서`])
    expect(crumbs(String.raw`\\FS01\공용\양식`).map((c) => c.name)).toEqual([String.raw`\\FS01\공용`, '양식'])
    expect(parentOf('C:\\')).toBeNull()
    expect(parentOf(String.raw`C:\a\b`)).toBe(String.raw`C:\a`)
    expect(categoryOf('예산.XLSX')).toBe('sheet')
    expect(categoryOf('x', true)).toBe('folder')
  })

  it('search text becomes FTS terms and LIKE patterns', () => {
    expect(parseSearch('업무보고 2026 *.hwp')).toEqual({ fts: ['"업무보고"', '"2026"'], like: ['%.hwp'] })
    expect(parseSearch('예산')).toEqual({ fts: [], like: ['%예산%'] })
    expect(parseSearch('"주간 보고"')).toEqual({ fts: ['"주간 보고"'], like: [] })
  })
})
