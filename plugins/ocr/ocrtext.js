/* Text helpers of the OCR plugin (no DOM). Exposed as globalThis.OcrText; unit-tested in tests/plugins. */
;(function (g) {
  'use strict'

  /** Longest side sent to the recognizer (Windows refuses more than 10,000 px; larger only slows it down). */
  const MAX_SIDE = 4000

  /**
   * Size to draw a picture (or a selected part) at before reading it: small pictures are
   * enlarged (small print reads much better at twice the size), huge ones are reduced.
   */
  function targetSize(w, h, enlarge) {
    let scale = 1
    const long = Math.max(w, h)
    if (enlarge && long < 1600) scale = Math.min(3, Math.max(1, Math.round((2000 / long) * 2) / 2))
    if (long * scale > MAX_SIDE) scale = MAX_SIDE / long
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale }
  }

  const sentenceEnd = /[.!?。…:;)\]"'”’]$|[다요죠음함임됨까]\.?$/
  const bullet = /^([-•·*○●\u25b6□■◇◆※]|\d{1,2}[.)]|[가-하][.)]|\(\d{1,2}\)|[①-⑳])\s?/

  /**
   * Lines of a scanned paragraph end where the paper ends, not where the sentence does:
   * join them into paragraphs. Empty lines, list items and short heading-like lines stay apart.
   */
  function joinLines(text) {
    const out = []
    let cur = ''
    const flush = () => {
      if (cur) out.push(cur)
      cur = ''
    }
    const lines = String(text || '').split(/\r?\n/)
    const longest = Math.max(1, ...lines.map((l) => l.trim().length))
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) {
        flush()
        if (out.length && out[out.length - 1] !== '') out.push('')
        continue
      }
      if (bullet.test(line)) flush()
      if (!cur) cur = line
      else {
        // a word cut by a hyphen at the end of an English line
        const cut = /[A-Za-z]-$/.test(cur) && /^[a-z]/.test(line)
        cur = cut ? cur.slice(0, -1) + line : cur + ' ' + line
      }
      // a line that stops well before the right edge ends its paragraph
      if (line.length < longest * 0.6 && sentenceEnd.test(line)) flush()
    }
    flush()
    while (out.length && out[out.length - 1] === '') out.pop()
    return out.join('\n')
  }

  /** Short title for the history list. */
  function titleOf(text) {
    const first = String(text || '').split('\n').map((l) => l.trim()).find(Boolean) || ''
    return first.length > 40 ? first.slice(0, 40) + '…' : first
  }

  const count = (text) => ({ chars: String(text || '').replace(/\s/g, '').length, lines: String(text || '').split('\n').filter((l) => l.trim()).length })

  g.OcrText = { MAX_SIDE, targetSize, joinLines, titleOf, count }
})(typeof window !== 'undefined' ? window : globalThis)
