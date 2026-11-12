import { z } from 'zod'
import { handle } from './registry'
import { localDb } from '../localdb'
import { launcherInputSchema } from '../../shared/schemas/launcher'
import { autoRegister, iconFor, openLauncherBar, openRecent, recentDocs, runPersonal, runTeam, startMenuPrograms } from '../launcher'
import { deleteTemp, listTemp, networkCheck, openSetting, resources, runSecurityCheck, sysInfo } from '../sysutil'
import { broadcast } from '../tools'

const result = (error: string | null): { ok: boolean; error?: string } => (error ? { ok: false, error } : { ok: true })
const changed = (): void => broadcast('launcher:changed', { count: localDb().launcher.list().length })

/** IPC for the launcher and PC utilities (6.13, 6.14). Everything stays on this PC. */
export function registerLauncherIpc(): void {
  handle('launcher:list', null, () => localDb().launcher.list())
  handle('launcher:save', launcherInputSchema, (i) => {
    const id = localDb().launcher.save(i)
    changed()
    return id
  })
  handle('launcher:remove', z.object({ id: z.string() }), ({ id }) => {
    localDb().launcher.remove(id)
    changed()
  })
  handle('launcher:reorder', z.object({ ids: z.array(z.string()).max(1000) }), ({ ids }) => {
    localDb().launcher.reorder(ids)
    changed()
  })
  handle('launcher:run', z.object({ id: z.string() }), async ({ id }) => result(await runPersonal(id)))
  handle(
    'launcher:runTeam',
    z.object({
      id: z.string(),
      kind: z.enum(['url', 'path', 'template']),
      name: z.string(),
      target: z.string(),
      groupName: z.string(),
      sort: z.number(),
      attachmentId: z.string().nullable(),
      fileName: z.string().nullable()
    }),
    async (item) => result(await runTeam(item))
  )
  handle('launcher:detect', null, async () => {
    const r = await autoRegister(true)
    changed()
    return r
  })
  handle('launcher:startMenu', null, () => startMenuPrograms())
  handle('launcher:icon', z.object({ path: z.string().max(1000) }), ({ path }) => iconFor(path))
  handle('launcher:recent', null, () => recentDocs())
  handle('launcher:openRecent', z.object({ path: z.string().max(1000) }), async ({ path }) => result(await openRecent(path)))
  handle('launcher:pinRecent', z.object({ path: z.string().max(1000), pinned: z.boolean() }), ({ path, pinned }) => localDb().launcher.pinRecent(path, pinned))
  handle('launcher:forgetRecent', z.object({ path: z.string().max(1000) }), ({ path }) => localDb().launcher.forgetRecent(path))
  handle('launcher:openBar', null, () => openLauncherBar())

  handle('sys:resources', null, () => resources())
  handle('sys:info', null, () => sysInfo())
  handle(
    'security:run',
    z.object({ programs: z.array(z.object({ id: z.string(), name: z.string().max(60), processNames: z.array(z.string().max(100)).max(10), serviceNames: z.array(z.string().max(100)).max(10) })).max(50) }),
    ({ programs }) => runSecurityCheck(programs)
  )
  handle('security:history', null, () => localDb().launcher.securityHistory())
  handle('sys:netCheck', z.object({ target: z.string().max(100).optional() }), ({ target }) => networkCheck(target))
  handle('sys:tempList', null, () => listTemp())
  handle('sys:tempDelete', z.object({ paths: z.array(z.string().max(1000)).max(5000) }), ({ paths }) => deleteTemp(paths))
  handle('sys:openSetting', z.object({ key: z.string().max(30) }), ({ key }) => openSetting(key))
}
