/** PC utilities (6.14). Everything runs and stays on this PC; nothing is sent to the server. */

export interface SysResources {
  at: number
  cpu: number
  mem: { used: number; total: number }
  disks: { mount: string; size: number; used: number }[]
  net: { rx: number; tx: number }
  uptime: number
  top: { name: string; pid: number; cpu: number; memMB: number }[]
}

export interface SysInfo {
  pcName: string
  user: string
  os: string
  cpu: string
  cores: number
  ramTotal: number
  ips: { iface: string; ip: string; mac: string }[]
  bootAt: number
}

// ---------- security check ----------
export type CheckStatus = 'good' | 'warn' | 'bad' | 'unknown'

export interface SecurityItem {
  key: string
  label: string
  status: CheckStatus
  detail: string
  fix: string
  settings?: string
}

export interface SecurityRunDto {
  id: string
  runAt: number
  items: SecurityItem[]
}

export interface SecurityProgramDto {
  id: string
  name: string
  processNames: string[]
  serviceNames: string[]
}

/** Raw values collected by the fixed PowerShell script (main/sysutil/security.ts). */
export interface SecurityRaw {
  av: { name: string; state: number }[] | null
  defender: { enabled: boolean; realtime: boolean; signatureAt: string | null } | null
  firewall: { name: string; enabled: boolean }[] | null
  hotfixAt: string | null
  screenSaver: { active: string | null; secure: string | null; timeout: string | null } | null
  /** required: a password has been set (PasswordLastSet exists); PasswordRequired is only an account flag */
  password: { required: boolean; lastSet: string | null } | null
  shares: string[] | null
  autorun: { noDriveTypeAutoRun: number | null; disableAutoplay: number | null } | null
  bitlocker: number | null
  processes: string[]
  services: { name: string; running: boolean }[]
}

const DAY = 86400000
const daysAgo = (iso: string | null, now: number): number | null => {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor((now - t) / DAY) : null
}

/** SecurityCenter2 productState: enabled when bits 12-15 are 1 (third-party values are not official). */
export function avEnabled(state: number): boolean {
  return ((state >> 12) & 0xf) === 1
}

export function evaluateSecurity(raw: SecurityRaw, programs: SecurityProgramDto[], now = Date.now()): SecurityItem[] {
  const items: SecurityItem[] = []

  // antivirus
  {
    const fix = '백신 프로그램을 설치하거나 실시간 감시를 켜세요.'
    if (!raw.av) items.push({ key: 'av', label: '백신', status: 'unknown', detail: '확인 불가', fix, settings: 'defender' })
    else if (!raw.av.length) items.push({ key: 'av', label: '백신', status: 'bad', detail: '설치된 백신이 없습니다.', fix, settings: 'defender' })
    else {
      const third = raw.av.filter((a) => !/defender/i.test(a.name))
      const active = third.filter((a) => avEnabled(a.state))
      if (active.length) items.push({ key: 'av', label: '백신', status: 'good', detail: `${active.map((a) => a.name).join(', ')} 실행 중`, fix })
      else if (raw.defender?.enabled && raw.defender.realtime) {
        const d = daysAgo(raw.defender.signatureAt, now)
        items.push(
          d !== null && d > 7
            ? { key: 'av', label: '백신', status: 'warn', detail: `Microsoft Defender 실시간 감시 켜짐 · 업데이트 ${d}일 전`, fix: 'Windows 보안에서 보호 업데이트를 확인하세요.', settings: 'defender' }
            : { key: 'av', label: '백신', status: 'good', detail: 'Microsoft Defender 실시간 감시 켜짐 · 최신', fix }
        )
      } else if (third.length) items.push({ key: 'av', label: '백신', status: 'warn', detail: `${third.map((a) => a.name).join(', ')} 설치됨 (실행 상태 확인 불가)`, fix })
      else items.push({ key: 'av', label: '백신', status: 'bad', detail: 'Microsoft Defender 실시간 감시가 꺼져 있습니다.', fix, settings: 'defender' })
    }
  }

  // firewall
  if (!raw.firewall) items.push({ key: 'firewall', label: '방화벽', status: 'unknown', detail: '확인 불가', fix: '', settings: 'firewall' })
  else {
    const off = raw.firewall.filter((p) => !p.enabled).map((p) => p.name)
    items.push(
      off.length
        ? { key: 'firewall', label: '방화벽', status: 'bad', detail: `꺼진 프로필: ${off.join(', ')}`, fix: 'Windows 보안 → 방화벽 및 네트워크 보호에서 모든 프로필을 켜세요.', settings: 'firewall' }
        : { key: 'firewall', label: '방화벽', status: 'good', detail: '모든 프로필 켜짐', fix: '' }
    )
  }

  // windows update
  {
    const d = daysAgo(raw.hotfixAt, now)
    const fix = 'Windows 업데이트에서 업데이트를 확인하고 설치하세요.'
    items.push(
      d === null
        ? { key: 'update', label: 'Windows 업데이트', status: 'unknown', detail: '확인 불가', fix, settings: 'windowsupdate' }
        : { key: 'update', label: 'Windows 업데이트', status: d <= 45 ? 'good' : d <= 90 ? 'warn' : 'bad', detail: `최근 설치 ${d}일 전`, fix: d <= 45 ? '' : fix, settings: 'windowsupdate' }
    )
  }

  // screen saver lock
  {
    const s = raw.screenSaver
    const fix = '화면 보호기를 10분 이하로 켜고 "다시 시작할 때 로그온 화면 표시"를 체크하세요.'
    if (!s) items.push({ key: 'screensaver', label: '화면 보호기 잠금', status: 'unknown', detail: '확인 불가', fix, settings: 'screensaver' })
    else {
      const min = s.timeout ? Math.round(Number(s.timeout) / 60) : null
      const on = s.active === '1' && s.secure === '1'
      items.push(
        on && min !== null && min <= 10
          ? { key: 'screensaver', label: '화면 보호기 잠금', status: 'good', detail: `${min}분 뒤 잠금`, fix: '' }
          : on
            ? { key: 'screensaver', label: '화면 보호기 잠금', status: 'warn', detail: `${min ?? '?'}분 뒤 잠금 (10분 이하 권장)`, fix, settings: 'screensaver' }
            : { key: 'screensaver', label: '화면 보호기 잠금', status: 'bad', detail: s.active === '1' ? '화면 보호기 해제 시 암호를 묻지 않습니다.' : '화면 보호기가 꺼져 있습니다.', fix, settings: 'screensaver' }
      )
    }
  }

  // login password
  {
    const p = raw.password
    const fix = '로그인 암호를 설정하고 90일마다 바꾸세요.'
    if (!p) items.push({ key: 'password', label: '로그인 암호', status: 'unknown', detail: '확인 불가 (도메인·Microsoft 계정)', fix, settings: 'signin' })
    else if (!p.required) items.push({ key: 'password', label: '로그인 암호', status: 'bad', detail: '암호 없이 로그인할 수 있습니다.', fix, settings: 'signin' })
    else {
      const d = daysAgo(p.lastSet, now)
      items.push({ key: 'password', label: '로그인 암호', status: d !== null && d > 90 ? 'warn' : 'good', detail: d === null ? '설정됨' : `설정됨 · 변경 ${d}일 전`, fix: d !== null && d > 90 ? fix : '', settings: 'signin' })
    }
  }

  // shared folders
  if (!raw.shares) items.push({ key: 'shares', label: '공유 폴더', status: 'unknown', detail: '확인 불가', fix: '', settings: 'sharing' })
  else
    items.push(
      raw.shares.length
        ? { key: 'shares', label: '공유 폴더', status: 'warn', detail: `공유 중: ${raw.shares.join(', ')}`, fix: '필요 없는 공유는 폴더 속성 → 공유에서 끄세요. 공유한다면 사용 권한을 필요한 사람으로 제한하세요.', settings: 'sharing' }
        : { key: 'shares', label: '공유 폴더', status: 'good', detail: '공유 폴더 없음', fix: '' }
    )

  // USB autorun
  {
    const a = raw.autorun
    const off = !!a && (a.disableAutoplay === 1 || a.noDriveTypeAutoRun === 255 || ((a.noDriveTypeAutoRun ?? 0) & 0x04) === 0x04)
    items.push(
      !a
        ? { key: 'autorun', label: 'USB 자동 실행', status: 'unknown', detail: '확인 불가', fix: '', settings: 'autoplay' }
        : off
          ? { key: 'autorun', label: 'USB 자동 실행', status: 'good', detail: '꺼짐', fix: '' }
          : { key: 'autorun', label: 'USB 자동 실행', status: 'warn', detail: '켜짐', fix: '설정 → 블루투스 및 장치 → 자동 실행에서 끄세요.', settings: 'autoplay' }
    )
  }

  // BitLocker (System.Volume.BitLockerProtection of C:)
  {
    const b = raw.bitlocker
    const fix = '관리자(전산 담당)에게 BitLocker 사용을 문의하세요.'
    items.push(
      b === 1 || b === 3 || b === 6
        ? { key: 'bitlocker', label: '디스크 암호화 (C:)', status: 'good', detail: 'BitLocker 켜짐', fix: '' }
        : b === 2 || b === 4 || b === 5
          ? { key: 'bitlocker', label: '디스크 암호화 (C:)', status: 'warn', detail: 'BitLocker 꺼짐', fix, settings: 'bitlocker' }
          : { key: 'bitlocker', label: '디스크 암호화 (C:)', status: 'unknown', detail: '확인 불가', fix: '' }
    )
  }

  // programs designated by the organization
  const procs = new Set(raw.processes.map((p) => p.toLowerCase().replace(/\.exe$/, '')))
  const svcs = new Map(raw.services.map((s) => [s.name.toLowerCase(), s.running]))
  for (const p of programs) {
    const running = p.processNames.some((n) => procs.has(n.toLowerCase().replace(/\.exe$/, ''))) || p.serviceNames.some((n) => svcs.get(n.toLowerCase()) === true)
    const installed = running || p.serviceNames.some((n) => svcs.has(n.toLowerCase()))
    items.push({
      key: `prog:${p.id}`,
      label: `지정 보안프로그램: ${p.name}`,
      status: running ? 'good' : installed ? 'warn' : 'bad',
      detail: running ? '실행 중' : installed ? '설치됨 · 실행 중 아님' : '찾을 수 없음',
      fix: running ? '' : '기관에서 지정한 프로그램입니다. 설치·실행 방법은 관리자에게 문의하세요.'
    })
  }
  return items
}

/** Windows settings shortcuts (6.14 ③). Renderer sends only the key; main opens the URI. */
export const SETTINGS_SHORTCUTS: { key: string; label: string; uri: string; group: string }[] = [
  { key: 'printers', label: '프린터·스캐너', uri: 'ms-settings:printers', group: '장치' },
  { key: 'bluetooth', label: '블루투스·장치', uri: 'ms-settings:bluetooth', group: '장치' },
  { key: 'display', label: '디스플레이', uri: 'ms-settings:display', group: '장치' },
  { key: 'sound', label: '소리', uri: 'ms-settings:sound', group: '장치' },
  { key: 'autoplay', label: '자동 실행', uri: 'ms-settings:autoplay', group: '장치' },
  { key: 'network', label: '네트워크·인터넷', uri: 'ms-settings:network', group: '네트워크' },
  { key: 'proxy', label: '프록시', uri: 'ms-settings:network-proxy', group: '네트워크' },
  { key: 'sharing', label: '고급 공유 설정', uri: 'ms-settings:network-advancedsettings', group: '네트워크' },
  { key: 'windowsupdate', label: 'Windows 업데이트', uri: 'ms-settings:windowsupdate', group: '보안' },
  { key: 'defender', label: 'Windows 보안', uri: 'windowsdefender:', group: '보안' },
  { key: 'firewall', label: '방화벽', uri: 'windowsdefender://network', group: '보안' },
  { key: 'signin', label: '로그인 옵션(암호)', uri: 'ms-settings:signinoptions', group: '보안' },
  { key: 'screensaver', label: '화면 보호기·잠금 화면', uri: 'ms-settings:lockscreen', group: '보안' },
  { key: 'bitlocker', label: '장치 암호화', uri: 'ms-settings:deviceencryption', group: '보안' },
  { key: 'storage', label: '저장소(디스크 정리)', uri: 'ms-settings:storagesense', group: '시스템' },
  { key: 'apps', label: '설치된 앱', uri: 'ms-settings:appsfeatures', group: '시스템' },
  { key: 'power', label: '전원·절전', uri: 'ms-settings:powersleep', group: '시스템' },
  { key: 'datetime', label: '날짜·시간', uri: 'ms-settings:dateandtime', group: '시스템' },
  { key: 'about', label: 'PC 정보', uri: 'ms-settings:about', group: '시스템' }
]

/** Fixed system programs the utilities page may start (no arguments from the renderer). */
export const SYSTEM_TOOLS: { key: string; label: string }[] = [
  { key: 'taskmgr', label: '작업 관리자' },
  { key: 'devmgmt', label: '장치 관리자' },
  { key: 'control', label: '제어판' },
  { key: 'cleanmgr', label: '디스크 정리' }
]

export interface NetCheckStep {
  key: string
  label: string
  status: CheckStatus
  detail: string
}

export interface TempEntry {
  path: string
  name: string
  size: number
  mtime: number
  dir: boolean
}
