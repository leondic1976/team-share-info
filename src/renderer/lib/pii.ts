import { detectPii, piiMessage, plainText } from '@shared/pii'

/**
 * Before something is sent to other people: if it seems to contain personal information
 * (resident number, phone, card, account…), ask the writer once more.
 * `parts` may be plain text or rich text (HTML). Returns false when the writer backs out.
 */
export function confirmPii(parts: (string | null | undefined)[], audience = '받는 사람 모두가 보게 되며,'): boolean {
  const found = detectPii(parts.map((p) => plainText(p ?? '')).join('\n'))
  return !found.length || window.confirm(piiMessage(found, audience))
}
