import { z } from 'zod'
import { handle } from './registry'
import { fetchCatalog, inspectFile, installFromCatalog, installFromFile, listPlugins, pickPluginFile, pluginOpenFile, pluginSaveFile, setPluginEnabled, uninstallPlugin } from '../plugins'
import { PLUGIN_ID_RE } from '../../shared/schemas/plugins'

const result = async <T,>(fn: () => Promise<T> | T): Promise<{ ok: boolean; error?: string; data?: T }> => {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** IPC for plugins (확장 기능). Installing always happens here, in the app. */
export function registerPluginIpc(): void {
  const id = z.object({ id: z.string().regex(PLUGIN_ID_RE) })
  handle('plugins:list', null, () => listPlugins())
  handle('plugins:catalog', null, () => result(fetchCatalog))
  handle('plugins:installCatalog', id, ({ id: pid }) => result(() => installFromCatalog(pid)))
  handle('plugins:pickFile', null, () => pickPluginFile())
  handle('plugins:inspectFile', z.object({ path: z.string().max(1000) }), ({ path }) => inspectFile(path))
  handle('plugins:installFile', z.object({ path: z.string().max(1000) }), ({ path }) => result(() => installFromFile(path)))
  handle('plugins:uninstall', id, ({ id: pid }) => uninstallPlugin(pid))
  handle('plugins:saveFile', z.object({ id: z.string().regex(PLUGIN_ID_RE), name: z.string().min(1).max(200), text: z.string().max(6_000_000) }), ({ id: pid, name, text }) => pluginSaveFile(pid, name, text))
  handle('plugins:openFile', z.object({ id: z.string().regex(PLUGIN_ID_RE), exts: z.array(z.string().max(5)).max(6) }), ({ id: pid, exts }) => pluginOpenFile(pid, exts))
  handle('plugins:setEnabled', z.object({ id: z.string().regex(PLUGIN_ID_RE), enabled: z.boolean() }), ({ id: pid, enabled }) => setPluginEnabled(pid, enabled))
}
