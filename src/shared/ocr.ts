/** Text recognition (OCR) of an image, done on this PC by Windows (src/main/ocr.ts). */

export interface OcrWord {
  /** text */
  t: string
  x: number
  y: number
  w: number
  h: number
}

/** What the recognizer script prints. */
export interface OcrRaw {
  ok: boolean
  error?: string
  /** language the text was read in (e.g. ko, en-US) */
  language?: string
  /** languages this PC can read */
  languages?: string[] | string
  lines?: (OcrWord[] | OcrWord)[] | OcrWord
}

export interface OcrResult {
  ok: boolean
  error?: string
  text?: string
  lines?: string[]
  language?: string
  languages?: string[]
}

const many = <T>(v: T | T[] | null | undefined): T[] => (v === null || v === undefined ? [] : Array.isArray(v) ? v : [v])

/**
 * Lines of words -> text. A gap between two lines that is clearly larger than the text
 * height becomes an empty line, so paragraphs of the picture stay apart.
 * (PowerShell prints a bare object for a list of one, hence the loose input type.)
 */
export function assembleOcr(raw: OcrRaw['lines']): { text: string; lines: string[] } {
  const rows = many(raw as (OcrWord[] | OcrWord)[])
    .map((l) => many(l).filter((w) => w && typeof w.t === 'string' && w.t.trim()))
    .filter((l) => l.length)
  const lines: string[] = []
  const out: string[] = []
  let prevBottom: number | null = null
  for (const words of rows) {
    const top = Math.min(...words.map((w) => w.y))
    const height = Math.max(...words.map((w) => w.h))
    const text = words
      .map((w) => w.t.trim())
      .join(' ')
      // a space the recognizer puts before closing punctuation
      .replace(/ ([,.!?:;)\]}%])(?= |$)/g, '$1')
    if (prevBottom !== null && top - prevBottom > height * 0.9) out.push('')
    out.push(text)
    lines.push(text)
    prevBottom = Math.max(...words.map((w) => w.y + w.h))
  }
  return { text: out.join('\n'), lines }
}

/** Language names for the choices shown to the user. */
export const OCR_LANGUAGE_NAMES: Record<string, string> = { ko: '한국어', en: '영어', ja: '일본어', zh: '중국어' }
export const ocrLanguageName = (tag: string): string => OCR_LANGUAGE_NAMES[tag.toLowerCase().split('-')[0]] ?? tag
