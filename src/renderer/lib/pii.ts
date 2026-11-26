import { detectPiiIn, piiMessage, type PiiAck } from '@shared/pii'

/**
 * Before something is sent to other people: if it seems to contain personal information
 * (resident number, phone, card, account…), ask the writer once more.
 * `parts` may be plain text or rich text (HTML). Returns null when the writer backs out;
 * otherwise what to spread into the request body: `{ piiAck: true }` when something was found
 * and confirmed (the server checks the same and refuses it without this), `{}` when nothing was.
 */
export function confirmPii(parts: (string | null | undefined)[], audience = '받는 사람 모두가 보게 되며,'): PiiAck | null {
  const found = detectPiiIn(parts)
  if (!found.length) return {}
  return window.confirm(piiMessage(found, audience)) ? { piiAck: true } : null
}
