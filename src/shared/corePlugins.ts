import type { PluginManifest, PluginPermission } from './schemas/plugins'

/**
 * Screens written as extensions that are now part of the program (instruction 148): they are
 * served from the program's own files (resources/<id>), are never installed, switched off or
 * listed among the extensions, and change only with a TeamHub update — no version of their own.
 * Their data (server rooms under the same id, local storage) is what the extension used.
 */
export const CORE_PLUGINS: Record<string, { name: string; iconName: string; permissions: PluginPermission[] }> = {
  meal: { name: '식사 신청', iconName: 'utensils', permissions: ['members', 'duty', 'rooms', 'clipboard', 'files', 'storage'] }
}

export const isCorePlugin = (id: string): boolean => Object.hasOwn(CORE_PLUGINS, id)

/** The manifest the host works with (no version of its own: it is the program's). */
export function coreManifest(id: string): PluginManifest {
  const c = CORE_PLUGINS[id]!
  return { id, name: c.name, version: '0.0.0', description: '', author: 'TeamHub', icon: '', iconName: c.iconName, entry: 'index.html', permissions: c.permissions, minAppVersion: '0.1.0' }
}
