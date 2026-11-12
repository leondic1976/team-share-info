import { app } from 'electron'
import { execFile } from 'node:child_process'
import { DISCOVERY_PORT } from '../shared/constants'

/**
 * Register inbound firewall rules for the server (TCP port, UDP discovery) and
 * for the app executable (PC-to-PC meetings). Runs one elevated PowerShell;
 * Windows shows its own UAC consent prompt (13.0 rule 10, 13.13).
 */
export function registerFirewallRules(port: number): Promise<{ ok: boolean; message: string }> {
  if (!app.isPackaged || process.env.TEAMHUB_E2E) {
    return Promise.resolve({ ok: false, message: '개발 실행에서는 방화벽 규칙을 등록하지 않습니다.' })
  }
  const exe = process.execPath.replace(/'/g, "''")
  const cmds = [
    `netsh advfirewall firewall delete rule name='TeamHub Server TCP'`,
    `netsh advfirewall firewall delete rule name='TeamHub Discovery UDP'`,
    `netsh advfirewall firewall delete rule name='TeamHub App'`,
    `netsh advfirewall firewall add rule name='TeamHub Server TCP' dir=in action=allow protocol=TCP localport=${port} profile=private,domain`,
    `netsh advfirewall firewall add rule name='TeamHub Discovery UDP' dir=in action=allow protocol=UDP localport=${DISCOVERY_PORT} profile=private,domain`,
    `netsh advfirewall firewall add rule name='TeamHub App' dir=in action=allow program='${exe}' enable=yes profile=private,domain`
  ].join('; ')
  const inner = cmds.replace(/"/g, '\\"')
  const script = `try { Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',"${inner}"; 'OK' } catch { 'CANCELLED' }`
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 120000 }, (err, stdout) => {
      if (err) resolve({ ok: false, message: `방화벽 등록 실패: ${err.message}` })
      else if (stdout.includes('OK')) resolve({ ok: true, message: '방화벽 규칙을 등록했습니다.' })
      else resolve({ ok: false, message: '관리자 권한 승인이 취소되었습니다. 방화벽 설정에서 수동으로 등록하세요.' })
    })
  })
}
