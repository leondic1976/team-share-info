import { describe, it, expect } from 'vitest'
import { isSafeTeamTarget, matchKnownApps, parseOpenCommand } from '../../src/shared/schemas/launcher'
import { avEnabled, evaluateSecurity, type SecurityRaw } from '../../src/shared/schemas/sysutil'

describe('program detection (M7-1)', () => {
  it('finds Hangul via App Paths, Office via shortcuts, and falls back to file association', () => {
    const appPaths = [
      { name: 'Hwp.exe', path: 'C:\\Program Files (x86)\\HNC\\Office 2022\\HOffice120\\Bin\\Hwp.exe' },
      { name: 'msedge.exe', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
      { name: 'chrome.exe', path: 'C:\\missing\\chrome.exe' }
    ]
    const shortcuts = [
      { name: 'Excel', target: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE' },
      { name: 'Word', target: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE' },
      { name: '한셀 2022', target: 'C:\\HNC\\Bin\\HCell.exe' },
      { name: 'Excel 도움말', target: 'C:\\help.chm' }
    ]
    const assoc = { '.pdf': '"C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe" "%1"' }
    const found = matchKnownApps(appPaths, shortcuts, assoc, (p) => !p.includes('missing'))
    expect(Object.fromEntries(found.map((f) => [f.key, f.path]))).toEqual({
      hwp: appPaths[0].path,
      hcell: 'C:\\HNC\\Bin\\HCell.exe',
      excel: shortcuts[0].target,
      word: shortcuts[1].target,
      acrobat: 'C:\\Program Files\\Adobe\\Acrobat DC\\Acrobat\\Acrobat.exe',
      edge: appPaths[1].path
    })
    expect(found.find((f) => f.key === 'hwp')?.name).toBe('한글')
  })

  it('parses open commands', () => {
    expect(parseOpenCommand('"C:\\a b\\Hwp.exe" "%1"')).toBe('C:\\a b\\Hwp.exe')
    expect(parseOpenCommand('C:\\x\\notepad.exe %1')).toBe('C:\\x\\notepad.exe')
    expect(parseOpenCommand('rundll32.dll,x')).toBeNull()
  })

  it('team launcher accepts only web addresses, folders and documents', () => {
    expect(isSafeTeamTarget('url', 'https://intra.example.go.kr/approval')).toBe(true)
    expect(isSafeTeamTarget('url', 'javascript:alert(1)')).toBe(false)
    expect(isSafeTeamTarget('url', 'file:///C:/x')).toBe(false)
    expect(isSafeTeamTarget('path', '\\\\FILESERVER\\공용\\양식')).toBe(true)
    expect(isSafeTeamTarget('path', 'D:\\공용\\규정.hwp')).toBe(true)
    expect(isSafeTeamTarget('path', '\\\\srv\\share\\setup.exe')).toBe(false)
    expect(isSafeTeamTarget('path', 'C:\\tools\\run.BAT')).toBe(false)
    expect(isSafeTeamTarget('path', 'C:\\x\\a.lnk')).toBe(false)
    expect(isSafeTeamTarget('path', 'relative\\path')).toBe(false)
  })
})

const NOW = Date.parse('2026-11-12T09:00:00Z')
const base: SecurityRaw = {
  av: [{ name: 'Windows Defender', state: 397568 }],
  defender: { enabled: true, realtime: true, signatureAt: '2026-11-11T00:00:00Z' },
  firewall: [
    { name: 'Domain', enabled: true },
    { name: 'Private', enabled: true },
    { name: 'Public', enabled: true }
  ],
  hotfixAt: '2026-10-20T00:00:00Z',
  screenSaver: { active: '1', secure: '1', timeout: '600' },
  password: { required: true, lastSet: '2026-10-01T00:00:00Z' },
  shares: [],
  autorun: { noDriveTypeAutoRun: null, disableAutoplay: 1 },
  bitlocker: 1,
  processes: ['explorer', 'agent'],
  services: [{ name: 'SecSvc', running: false }]
}
const status = (items: ReturnType<typeof evaluateSecurity>): Record<string, string> => Object.fromEntries(items.map((i) => [i.key, i.status]))

describe('security check evaluation (M7-4)', () => {
  it('a well configured PC is all good', () => {
    expect(status(evaluateSecurity(base, [], NOW))).toEqual({ av: 'good', firewall: 'good', update: 'good', screensaver: 'good', password: 'good', shares: 'good', autorun: 'good', bitlocker: 'good' })
  })

  it('flags problems and shows "unknown" when data is not available', () => {
    const r = evaluateSecurity(
      {
        ...base,
        defender: { enabled: true, realtime: false, signatureAt: null },
        firewall: [{ name: 'Public', enabled: false }],
        hotfixAt: '2026-05-01T00:00:00Z',
        screenSaver: { active: '1', secure: '0', timeout: '300' },
        password: null,
        shares: ['문서'],
        autorun: { noDriveTypeAutoRun: 0x91, disableAutoplay: 0 },
        bitlocker: null
      },
      [
        { id: 'p1', name: '문서보안', processNames: ['agent.exe'], serviceNames: [] },
        { id: 'p2', name: 'PC보안', processNames: [], serviceNames: ['SecSvc'] },
        { id: 'p3', name: '없음', processNames: ['nope'], serviceNames: [] }
      ],
      NOW
    )
    expect(status(r)).toEqual({
      av: 'bad',
      firewall: 'bad',
      update: 'bad',
      screensaver: 'bad',
      password: 'unknown',
      shares: 'warn',
      autorun: 'warn',
      bitlocker: 'unknown',
      'prog:p1': 'good',
      'prog:p2': 'warn',
      'prog:p3': 'bad'
    })
    expect(r.find((i) => i.key === 'firewall')?.settings).toBe('firewall')
  })

  it('third-party antivirus is reported only as installed/running', () => {
    expect(avEnabled(266240)).toBe(true) // 0x41000
    expect(avEnabled(262144)).toBe(false) // 0x40000
    const r = evaluateSecurity({ ...base, av: [{ name: 'V3 Lite', state: 266240 }, { name: 'Windows Defender', state: 393472 }], defender: { enabled: false, realtime: false, signatureAt: null } }, [], NOW)
    expect(r[0]).toMatchObject({ status: 'good', detail: 'V3 Lite 실행 중' })
  })
})
