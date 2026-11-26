import { app, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { connect } from 'node:net'
import { readdirSync, rmSync, statSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import log from 'electron-log/main'
import { SETTINGS_SHORTCUTS, evaluateSecurity, type NetCheckStep, type SecurityProgramDto, type SecurityRaw, type SecurityRunDto, type SysInfo, type SysResources, type TempEntry } from '../../shared/schemas/sysutil'
import { localDb } from '../localdb'
import { arr, runPs, runPsJson, system32 } from './ps'
import { readCredential } from '../connection'
import { addReminderSource } from '../scheduler'
import { showToast } from '../notifications'

// ---------- PC resources (6.14 ①) ----------
// Sampling runs in a worker thread (sysworker): systeminformation blocks the event loop.
let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

function callWorker<T>(op: 'resources' | 'info' | 'disks'): Promise<T> {
  if (!worker) {
    worker = new Worker(join(import.meta.dirname, 'sysworker.js'))
    worker.on('message', (m: { id: number; data?: unknown; error?: string }) => {
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      if (m.error) p.reject(new Error(m.error))
      else p.resolve(m.data)
    })
    worker.on('error', (e) => log.warn('[sys] worker error', e))
    worker.on('exit', () => {
      worker = null
      for (const p of pending.values()) p.reject(new Error('worker exited'))
      pending.clear()
    })
    worker.unref()
  }
  const id = ++seq
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
    worker!.postMessage({ id, op })
  })
}

export const resources = (): Promise<SysResources> => callWorker<SysResources>('resources')
export const sysInfo = (): Promise<SysInfo> => callWorker<SysInfo>('info')

/** Low disk warning once a day (임계치 경고). */
async function checkDisks(): Promise<void> {
  try {
    const low = (await callWorker<{ mount: string; size: number; used: number }[]>('disks')).filter((d) => d.size > 5e9 && (d.size - d.used) / d.size < 0.1)
    const today = new Date().toDateString()
    if (low.length && localDb().kv.get<string>('sys.diskWarned') !== today) {
      localDb().kv.set('sys.diskWarned', today)
      showToast({ title: '디스크 공간 부족', body: low.map((d) => `${d.mount} 남은 공간 ${Math.round(((d.size - d.used) / d.size) * 100)}%`).join(', '), route: '/utilities' })
    }
  } catch {
    // ignore
  }
}

// ---------- security check (6.14 ②) ----------
const SECURITY_PS = `
$r=@{}
$r.av=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntivirusProduct | ForEach-Object { @{name=[string]$_.displayName; state=[int]$_.productState} })
$m=Get-MpComputerStatus; if($m){ $r.defender=@{enabled=[bool]$m.AntivirusEnabled; realtime=[bool]$m.RealTimeProtectionEnabled; signatureAt=$(if($m.AntivirusSignatureLastUpdated){$m.AntivirusSignatureLastUpdated.ToString('o')}else{$null})} } else { $r.defender=$null }
$fw=Get-NetFirewallProfile; if($fw){ $r.firewall=@($fw | ForEach-Object { @{name=[string]$_.Name; enabled=($_.Enabled -eq $true -or [string]$_.Enabled -eq 'True')} }) } else { $r.firewall=$null }
$hf=Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 1; $r.hotfixAt=$(if($hf){$hf.InstalledOn.ToString('o')}else{$null})
$pol=Get-ItemProperty -LiteralPath 'HKCU:\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop'; $d=Get-ItemProperty -LiteralPath 'HKCU:\\Control Panel\\Desktop'
$r.screenSaver=@{active=[string]$(if($pol.ScreenSaveActive){$pol.ScreenSaveActive}else{$d.ScreenSaveActive}); secure=[string]$(if($pol.ScreenSaverIsSecure){$pol.ScreenSaverIsSecure}else{$d.ScreenSaverIsSecure}); timeout=[string]$(if($pol.ScreenSaveTimeOut){$pol.ScreenSaveTimeOut}else{$d.ScreenSaveTimeOut})}
$u=Get-LocalUser -Name $env:USERNAME; if($u){ $r.password=@{required=[bool]$u.PasswordLastSet; lastSet=$(if($u.PasswordLastSet){$u.PasswordLastSet.ToString('o')}else{$null})} } else { $r.password=$null }
$sh=Get-SmbShare; if($?){ $r.shares=@($sh | Where-Object { $_.Name -notmatch '\\$$' } | ForEach-Object { [string]$_.Name }) } else { $r.shares=$null }
$e1=Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'; $e2=Get-ItemProperty -LiteralPath 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer'; $ap=Get-ItemProperty -LiteralPath 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer\\AutoplayHandlers'
$nd=$(if($e2.NoDriveTypeAutoRun -ne $null){[int]$e2.NoDriveTypeAutoRun}elseif($e1.NoDriveTypeAutoRun -ne $null){[int]$e1.NoDriveTypeAutoRun}else{$null})
$r.autorun=@{noDriveTypeAutoRun=$nd; disableAutoplay=$(if($ap.DisableAutoplay -ne $null){[int]$ap.DisableAutoplay}else{$null})}
try { $b=(New-Object -ComObject Shell.Application).NameSpace('C:').Self.ExtendedProperty('System.Volume.BitLockerProtection'); $r.bitlocker=$(if($b -ne $null){[int]$b}else{$null}) } catch { $r.bitlocker=$null }
$r.processes=@(Get-Process | ForEach-Object { [string]$_.ProcessName } | Sort-Object -Unique)
$r.services=@(Get-Service | ForEach-Object { @{name=[string]$_.Name; running=([string]$_.Status -eq 'Running')} })
$r | ConvertTo-Json -Depth 4 -Compress`

export async function runSecurityCheck(programs: SecurityProgramDto[]): Promise<SecurityRunDto> {
  const raw = await runPsJson<SecurityRaw>('security check', SECURITY_PS, 90000)
  const norm: SecurityRaw = {
    av: raw ? arr(raw.av) : null,
    defender: raw?.defender ?? null,
    firewall: raw?.firewall ? arr(raw.firewall) : null,
    hotfixAt: raw?.hotfixAt ?? null,
    screenSaver: raw?.screenSaver ?? null,
    password: raw?.password ?? null,
    shares: raw?.shares ? arr(raw.shares) : null,
    autorun: raw?.autorun ?? null,
    bitlocker: raw?.bitlocker ?? null,
    processes: arr(raw?.processes),
    services: arr(raw?.services)
  }
  // Results stay in the local DB only (2.3, 6.14).
  return localDb().launcher.saveSecurity(evaluateSecurity(norm, programs))
}

/** Monthly reminder when the last check is older than 30 days (6.14 ②). */
function securityReminderSource(from: number, to: number): { key: string; fireAt: number; title: string; body: string; route: string }[] {
  const last = localDb().launcher.securityHistory()[0]?.runAt ?? 0
  if (Date.now() - last < 30 * 86400000) return []
  const d = new Date()
  const at = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0).getTime()
  if (at < from || at > to) return []
  return [{ key: `sec:${d.getFullYear()}-${d.getMonth() + 1}`, fireAt: at, title: '보안 점검', body: '이번 달 PC 보안 점검을 해 주세요.', route: '/utilities' }]
}

// ---------- network diagnosis & tools (6.14 ③) ----------
function tcpCheck(host: string, port: number, timeout = 3000): Promise<number | null> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const s = connect({ host, port })
    const done = (v: number | null): void => {
      s.destroy()
      resolve(v)
    }
    s.setTimeout(timeout, () => done(null))
    s.once('connect', () => done(Date.now() - t0))
    s.once('error', () => done(null))
  })
}

/** ping.exe with fixed switches; the host is checked and passed as its own argument. "TTL=" is in every language's reply line. */
function ping(host: string): Promise<boolean> {
  if (!/^[\w.-]+$/.test(host) || host.startsWith('-')) return Promise.resolve(false)
  log.info(`[sys] ping ${host}`)
  return new Promise((resolve) => {
    execFile(system32('PING.EXE'), ['-n', '2', '-w', '1500', host], { windowsHide: true, timeout: 15000 }, (_err, stdout) =>
      resolve(/TTL=/i.test(String(stdout ?? '')))
    )
  })
}

export async function networkCheck(target?: string): Promise<NetCheckStep[]> {
  const steps: NetCheckStep[] = []
  const ifs = Object.entries(os.networkInterfaces()).flatMap(([name, a]) => (a ?? []).filter((x) => x.family === 'IPv4' && !x.internal).map((x) => `${name} ${x.address}`))
  steps.push({ key: 'adapter', label: '네트워크 연결', status: ifs.length ? 'good' : 'bad', detail: ifs.length ? ifs.join(', ') : '연결된 네트워크가 없습니다. 랜선·와이파이를 확인하세요.' })
  const gw = (await runPs('default gateway', `(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop`, 15000)).trim()
  if (gw && /^[\d.]+$/.test(gw)) {
    const ok = await ping(gw)
    steps.push({ key: 'gateway', label: '게이트웨이(공유기)', status: ok ? 'good' : 'warn', detail: ok ? `${gw} 응답` : `${gw} 응답 없음 (핑을 막아 둔 경우도 있습니다)` })
  } else steps.push({ key: 'gateway', label: '게이트웨이(공유기)', status: 'unknown', detail: '기본 게이트웨이를 찾지 못했습니다.' })
  const cred = readCredential()
  if (cred?.serverUrl) {
    const u = new URL(cred.serverUrl)
    const ms = await tcpCheck(u.hostname, Number(u.port || 80))
    steps.push({ key: 'server', label: 'TeamHub 서버', status: ms !== null ? 'good' : 'bad', detail: ms !== null ? `${u.host} 연결됨 (${ms}ms)` : `${u.host}에 연결할 수 없습니다. 서버 PC가 켜져 있는지, 방화벽을 확인하세요.` })
  }
  try {
    await lookup('www.google.com')
    const ms = await tcpCheck('www.google.com', 443)
    steps.push({ key: 'internet', label: '인터넷', status: ms !== null ? 'good' : 'warn', detail: ms !== null ? `연결됨 (${ms}ms)` : '이름은 찾았지만 연결되지 않습니다.' })
  } catch {
    steps.push({ key: 'internet', label: '인터넷', status: 'unknown', detail: '인터넷에 연결되지 않습니다. 폐쇄망(업무망)이면 정상입니다.' })
  }
  if (target?.trim()) {
    const host = target.trim()
    const ok = await ping(host)
    steps.push({ key: 'ping', label: `핑: ${host}`, status: ok ? 'good' : 'bad', detail: ok ? '응답' : '응답 없음' })
  }
  return steps
}

const tempRoot = (): string => app.getPath('temp')

function sizeOf(p: string, depth = 0): number {
  try {
    const s = statSync(p)
    if (!s.isDirectory()) return s.size
    if (depth > 6) return 0
    return readdirSync(p).reduce((sum, n) => sum + sizeOf(join(p, n), depth + 1), 0)
  } catch {
    return 0
  }
}

/** Top-level entries of the user temp folder, for the user to choose what to delete. */
export function listTemp(): TempEntry[] {
  const root = tempRoot()
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  return names
    .slice(0, 3000)
    .map((name) => {
      const p = join(root, name)
      try {
        const s = statSync(p)
        return { path: p, name, size: sizeOf(p), mtime: s.mtimeMs, dir: s.isDirectory() }
      } catch {
        return null
      }
    })
    .filter((x): x is TempEntry => !!x)
    .sort((a, b) => a.mtime - b.mtime)
}

/** Delete chosen entries; only direct children of the temp folder. Files in use are skipped. */
export function deleteTemp(paths: string[]): { deleted: number; skipped: number; freed: number } {
  const root = tempRoot().toLowerCase()
  let deleted = 0
  let skipped = 0
  let freed = 0
  for (const p of paths) {
    const parent = p.replace(/[\\/][^\\/]+$/, '').toLowerCase()
    if (parent !== root) {
      skipped++
      continue
    }
    const size = sizeOf(p)
    try {
      rmSync(p, { recursive: true, force: true, maxRetries: 0 })
      deleted++
      freed += size
    } catch {
      skipped++
    }
  }
  return { deleted, skipped, freed }
}

const TOOL_COMMANDS: Record<string, [string, string[]]> = {
  taskmgr: ['taskmgr.exe', []],
  devmgmt: ['mmc.exe', ['devmgmt.msc']],
  control: ['control.exe', []],
  cleanmgr: ['cleanmgr.exe', []]
}

/** Open a Windows settings page or system tool from the fixed list. */
export async function openSetting(key: string): Promise<boolean> {
  const s = SETTINGS_SHORTCUTS.find((x) => x.key === key)
  if (s) {
    await shell.openExternal(s.uri)
    return true
  }
  const cmd = TOOL_COMMANDS[key]
  if (!cmd) return false
  log.info(`[sys] open ${cmd[0]} ${cmd[1].join(' ')}`)
  spawn(system32(cmd[0]), cmd[1], { detached: true, stdio: 'ignore' }).unref()
  return true
}

export function startSysutil(): void {
  addReminderSource('security', securityReminderSource)
  setTimeout(() => void checkDisks(), 60_000)
  setInterval(() => void checkDisks(), 6 * 3600_000)
}
