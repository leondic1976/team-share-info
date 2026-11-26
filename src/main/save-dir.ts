import { app } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { localDb } from './localdb'

/**
 * Where save dialogs start (CLAUDE.md rules). Windows ransomware protection (controlled folder
 * access) guards Documents, Desktop, Pictures, Videos, Music and Favorites and reports a program
 * that writes there: so TeamHub never starts in one of them, and saves there only when the person
 * walks the dialog into it. Start: the folder the person saved into last, else Downloads.
 */
const KV_DIR = 'attachDir'

function protectedFolders(): string[] {
  const out: string[] = []
  for (const k of ['documents', 'desktop', 'pictures', 'videos', 'music'] as const) {
    try {
      out.push(app.getPath(k))
    } catch {
      // not on this PC
    }
  }
  out.push(join(app.getPath('home'), 'Favorites'))
  return out
}

const inside = (child: string, parent: string): boolean => {
  const r = relative(parent.toLowerCase(), child.toLowerCase())
  return r === '' || (!!r && !r.startsWith('..') && !isAbsolute(r))
}

export const isProtectedFolder = (p: string): boolean => protectedFolders().some((f) => inside(p, f))

/** The folder a save starts in: the last one the person chose unless it is a protected folder, else Downloads. */
export function saveDir(): string {
  const d = localDb().kv.get<string>(KV_DIR)
  return d && existsSync(d) && !isProtectedFolder(d) ? d : app.getPath('downloads')
}

/** `defaultPath` for a save dialog. */
export const savePath = (name: string): string => join(saveDir(), name)

/** Remember the folder of a file the person saved through a dialog. */
export function rememberSaveDir(filePath: string): void {
  localDb().kv.set(KV_DIR, dirname(filePath))
}
