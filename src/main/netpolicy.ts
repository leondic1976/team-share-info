import { app } from 'electron'
import { listIpv4 } from './netinfo'

/**
 * Whether this run may open ports on the office network (CLAUDE.md rules).
 *
 * Only the installed app does, through the firewall rules registered once at setup. Development,
 * tests and E2E listen on 127.0.0.1 only: every checkout has its own electron.exe, and a socket
 * listening on a LAN address makes Windows ask once more to allow network access for each of them.
 * `TEAMHUB_LAN=1` lets a development run use the LAN on purpose (checking with a second real PC);
 * E2E never does.
 */
export function lanAllowed(): boolean {
  if (process.env.TEAMHUB_E2E) return false
  return app.isPackaged || process.env.TEAMHUB_LAN === '1'
}

/** Addresses members type to reach this server PC; only 127.0.0.1 while the server stays on this PC. */
export function serverAddresses(port: number): string[] {
  if (!lanAllowed()) return [`http://127.0.0.1:${port}`]
  return listIpv4()
    .filter((i) => !i.virtual)
    .map((i) => `http://${i.address}:${port}`)
}
