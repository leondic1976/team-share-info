/**
 * Web addresses in a message (지시 123): http(s)://… and www.… become links. Only the ASCII URL
 * characters count, so Korean right after an address (https://a.kr에서) is left out, and so is
 * punctuation that ends the sentence (a trailing . , ! ? ; : or a closing bracket with no opening one).
 */
export type TextPart = { text: string; url?: undefined } | { text: string; url: string }

const URL_RE = /\b(?:https?:\/\/|www\.)[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/gi

function trimEnd(s: string): string {
  let out = s
  for (;;) {
    const last = out.at(-1)
    if (!last) return out
    if ('.,!?;:\'"'.includes(last)) out = out.slice(0, -1)
    else if (last === ')' && count(out, '(') < count(out, ')')) out = out.slice(0, -1)
    else if (last === ']' && count(out, '[') < count(out, ']')) out = out.slice(0, -1)
    else return out
  }
}

const count = (s: string, c: string): number => s.split(c).length - 1

export function splitLinks(text: string): TextPart[] {
  const parts: TextPart[] = []
  let at = 0
  for (const m of text.matchAll(URL_RE)) {
    const raw = trimEnd(m[0])
    // "www." alone or "http://" alone is not an address
    if (!/^(?:https?:\/\/|www\.)[A-Za-z0-9-]/i.test(raw) || /^(?:https?:\/\/)?www\.$/i.test(raw)) continue
    const start = m.index
    if (start > at) parts.push({ text: text.slice(at, start) })
    parts.push({ text: raw, url: /^https?:\/\//i.test(raw) ? raw : `http://${raw}` })
    at = start + raw.length
  }
  if (at < text.length) parts.push({ text: text.slice(at) })
  return parts
}
