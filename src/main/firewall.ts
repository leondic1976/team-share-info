import { app } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import log from 'electron-log/main'
import { DISCOVERY_PORT } from '../shared/constants'
import type { FirewallRule, FirewallState } from '../shared/ipc'
import { resourcePath } from './paths'
import { POWERSHELL, system32 } from './sysutil/ps'

/**
 * Inbound firewall rules of TeamHub (13.0 rule 10, CLAUDE.md): added or removed only when the
 * person presses the button (setup wizard, settings > server connection), after Windows' own
 * administrator prompt. The work is done by a fixed batch file shipped with the app
 * (resources/system/firewall.cmd: netsh with fixed rule names); TeamHub passes it nothing but
 * an action word and two port numbers.
 */
const RULES = { tcp: 'TeamHub Server TCP', udp: 'TeamHub Discovery UDP', app: 'TeamHub App' } as const


/** What the button adds, in the words shown to the person. Server PC: three rules; member PC: the program only. */
export function firewallRules(server: boolean, port: number): FirewallRule[] {
  const program: FirewallRule = { name: RULES.app, label: 'TeamHub 프로그램 (화상회의의 PC 간 연결)' }
  if (!server) return [program]
  return [{ name: RULES.tcp, label: `TCP ${port} (TeamHub 서버)` }, { name: RULES.udp, label: `UDP ${DISCOVERY_PORT} (서버 찾기)` }, program]
}

const devRun = (): boolean => !app.isPackaged || !!process.env.TEAMHUB_E2E

/** netsh with fixed arguments, without administrator rights: does a rule of this name exist? */
function ruleExists(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(system32('netsh.exe'), ['advfirewall', 'firewall', 'show', 'rule', `name=${name}`], { windowsHide: true, timeout: 15000 }, (err) => resolve(!err))
  })
}

export async function firewallState(server: boolean, port: number): Promise<FirewallState> {
  const rules = firewallRules(server, port)
  if (devRun()) return { available: false, rules, registered: [] }
  const registered: string[] = []
  for (const r of rules) if (await ruleExists(r.name)) registered.push(r.name)
  return { available: true, rules, registered }
}

/**
 * Start firewall.cmd with administrator rights. Only PowerShell's Start-Process can ask Windows for
 * them without a helper program; its script is fixed and the arguments come through the
 * environment (numbers and the action word, checked here and again in the batch file).
 */
const ELEVATE_PS =
  "try { $p = Start-Process -FilePath $env:TEAMHUB_FW_CMD -ArgumentList $env:TEAMHUB_FW_ARGS -Verb RunAs -Wait -PassThru; [Console]::Out.Write('EXIT:' + $p.ExitCode) } catch { [Console]::Out.Write('CANCELLED') }"

function runElevated(args: string[]): Promise<'cancelled' | number> {
  const script = resourcePath('system', 'firewall.cmd')
  if (!existsSync(script)) return Promise.resolve(3)
  // cmd /s /c "<"file" args>": cmd removes exactly the outer quotes, so the path may contain spaces
  const cmdArgs = `/d /s /c ""${script}" ${args.join(' ')}"`
  log.info(`[firewall] elevated: cmd.exe ${cmdArgs}`)
  return new Promise((resolve) => {
    execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', ELEVATE_PS],
      { windowsHide: true, timeout: 180000, encoding: 'utf8', env: { ...process.env, TEAMHUB_FW_CMD: system32('cmd.exe'), TEAMHUB_FW_ARGS: cmdArgs } },
      (err, stdout) => {
        const out = (stdout ?? '').trim()
        if (out === 'CANCELLED') return resolve('cancelled')
        const m = /^EXIT:(-?\d+)$/.exec(out)
        if (err || !m) {
          log.warn('[firewall] failed', err?.message ?? out)
          return resolve(3)
        }
        resolve(Number(m[1]))
      }
    )
  })
}

const validPort = (p: number): boolean => Number.isInteger(p) && p >= 1 && p <= 65535

export async function registerFirewallRules(server: boolean, port: number): Promise<{ ok: boolean; message: string }> {
  if (devRun()) return { ok: false, message: '개발 실행에서는 방화벽 규칙을 등록하지 않습니다(이 PC 안에서만 연결).' }
  if (server && !validPort(port)) return { ok: false, message: '포트 번호가 올바르지 않습니다.' }
  const code = await runElevated(server ? ['add-server', String(port), String(DISCOVERY_PORT)] : ['add-app'])
  log.info(`[firewall] register (${server ? 'server' : 'member'}) -> ${code}`)
  if (code === 'cancelled') return { ok: false, message: '관리자 권한 승인이 취소되었습니다. 나중에 설정 → 서버 연결에서 다시 등록하거나 방화벽 설정에서 직접 등록하세요.' }
  if (code !== 0) return { ok: false, message: `방화벽 규칙을 등록하지 못했습니다(코드 ${code}). 방화벽 설정에서 직접 등록하세요.` }
  return { ok: true, message: '방화벽 규칙을 등록했습니다.' }
}

export async function removeFirewallRules(): Promise<{ ok: boolean; message: string }> {
  if (devRun()) return { ok: false, message: '개발 실행에서는 방화벽 규칙을 바꾸지 않습니다.' }
  const code = await runElevated(['remove'])
  log.info(`[firewall] remove -> ${code}`)
  if (code === 'cancelled') return { ok: false, message: '관리자 권한 승인이 취소되었습니다. 규칙은 그대로 있습니다.' }
  if (code !== 0) return { ok: false, message: `방화벽 규칙을 지우지 못했습니다(코드 ${code}).` }
  return { ok: true, message: 'TeamHub 방화벽 규칙을 지웠습니다. 다른 PC에서 이 PC로 들어오는 연결은 Windows가 다시 묻거나 막습니다.' }
}
