// Seals the key of the feedback GitHub App into resources/feedback.bin (read by src/node/feedback.ts).
// The key never goes into the repository:
//   CI     : secrets FEEDBACK_APP_ID, FEEDBACK_APP_KEY (the .pem text, or base64 of it), optional FEEDBACK_INSTALLATION_ID
//   this PC: feedback-key.local.json  { "appId": "...", "privateKey": "-----BEGIN ...", "installationId": "..." }  (gitignored)
// Without a key the file is removed and the app opens the board in the browser instead of posting itself.
//   node scripts/build-feedback.mjs [output file]
import { createCipheriv, createPrivateKey, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const out = resolve(process.argv[2] ?? join(root, 'resources', 'feedback.bin'))
const SEAL_WORDS = ['teamhub', 'feedback', 'board', 'seal', 'v1']

let creds = null
if (process.env.FEEDBACK_APP_ID && process.env.FEEDBACK_APP_KEY) {
  const raw = process.env.FEEDBACK_APP_KEY.trim()
  creds = {
    appId: process.env.FEEDBACK_APP_ID.trim(),
    privateKey: raw.includes('PRIVATE KEY') ? raw.replace(/\\n/g, '\n') : Buffer.from(raw, 'base64').toString('utf8'),
    installationId: (process.env.FEEDBACK_INSTALLATION_ID ?? '').trim() || undefined
  }
} else if (existsSync(join(root, 'feedback-key.local.json'))) {
  creds = JSON.parse(readFileSync(join(root, 'feedback-key.local.json'), 'utf8'))
}

if (!creds?.appId || !creds?.privateKey) {
  rmSync(out, { force: true })
  console.log('feedback: no key configured (the app will open the board in the browser)')
  process.exit(0)
}
// fail the build on a broken key instead of shipping a button that cannot post
createPrivateKey(creds.privateKey)

const salt = randomBytes(16)
const iv = randomBytes(12)
const c = createCipheriv('aes-256-gcm', scryptSync(SEAL_WORDS.join(':'), salt, 32), iv)
const data = Buffer.concat([c.update(JSON.stringify({ appId: String(creds.appId), privateKey: creds.privateKey, installationId: creds.installationId ? String(creds.installationId) : undefined }), 'utf8'), c.final()])
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, Buffer.concat([Buffer.from('THFB1'), salt, iv, c.getAuthTag(), data]))
console.log(`feedback: key of app ${creds.appId} sealed`)
