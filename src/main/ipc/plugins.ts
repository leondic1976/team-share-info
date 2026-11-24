import { z } from 'zod'
import { handle } from './registry'
import { recognizeImage } from '../ocr'
import { countDownload, downloadCounts, fetchCatalog, openCopilot, hasPluginPermission, installBuiltin, inspectFile, installFromCatalog, installFromFile, listPlugins, pickPluginFile, pluginOpenFile, pluginSaveFile, setPluginEnabled, uninstallPlugin } from '../plugins'
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
  // builtin: the card showed the copy shipped with the app, so it installs at once without asking the download site
  handle('plugins:installCatalog', z.object({ id: z.string().regex(PLUGIN_ID_RE), builtin: z.boolean().optional() }), async ({ id: pid, builtin }) => {
    const r = await result(() => (builtin ? installBuiltin(pid) : installFromCatalog(pid)))
    if (r.ok) countDownload(pid)
    return r
  })
  handle('plugins:downloadCounts', z.object({ ids: z.array(z.string().regex(PLUGIN_ID_RE)).max(200) }), ({ ids }) => downloadCounts(ids))
  handle('plugins:pickFile', null, () => pickPluginFile())
  handle('plugins:inspectFile', z.object({ path: z.string().max(1000) }), ({ path }) => inspectFile(path))
  handle('plugins:installFile', z.object({ path: z.string().max(1000) }), ({ path }) => result(() => installFromFile(path)))
  handle('plugins:uninstall', id, ({ id: pid }) => uninstallPlugin(pid))
  handle('plugins:saveFile', z.object({ id: z.string().regex(PLUGIN_ID_RE), name: z.string().min(1).max(200), text: z.string().max(6_000_000) }), ({ id: pid, name, text }) => pluginSaveFile(pid, name, text))
  handle('plugins:openFile', z.object({ id: z.string().regex(PLUGIN_ID_RE), exts: z.array(z.string().max(5)).max(6) }), ({ id: pid, exts }) => pluginOpenFile(pid, exts))
  handle('plugins:ocr', z.object({ id: z.string().regex(PLUGIN_ID_RE), image: z.string().max(17_000_000), lang: z.string().max(20).optional() }), ({ id: pid, image, lang }) =>
    hasPluginPermission(pid, 'ocr') ? recognizeImage(image, lang) : { ok: false, error: '이 확장 기능에는 글자 인식 권한이 없습니다.' }
  )
  handle('plugins:openCopilot', id, ({ id: pid }) => (hasPluginPermission(pid, 'copilot') ? openCopilot() : { ok: false, error: '이 확장 기능에는 Copilot을 여는 권한이 없습니다.' }))
  handle('plugins:setEnabled', z.object({ id: z.string().regex(PLUGIN_ID_RE), enabled: z.boolean() }), ({ id: pid, enabled }) => setPluginEnabled(pid, enabled))
}
