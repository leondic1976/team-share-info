import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { assembleOcr, ocrLanguageName } from '../../src/shared/ocr'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/ocr/ocrtext.js'), 'utf8'), ctx)
const T = ctx.OcrText

const w = (t: string, x: number, y: number, width = 40, h = 20): { t: string; x: number; y: number; w: number; h: number } => ({ t, x, y, w: width, h })

describe('OCR: text put together from what the Windows recognizer returns', () => {
  it('joins words into lines and keeps paragraphs apart', () => {
    const r = assembleOcr([
      [w('회의', 0, 0), w('자료를', 50, 0), w('제출해', 100, 0), w('주세요', 150, 0), w('.', 195, 0, 5)],
      [w('TeamHub', 0, 24), w('release', 90, 24)],
      [w('합계', 0, 90), w('187,500원', 50, 90)]
    ])
    expect(r.lines).toEqual(['회의 자료를 제출해 주세요.', 'TeamHub release', '합계 187,500원'])
    expect(r.text).toBe('회의 자료를 제출해 주세요.\nTeamHub release\n\n합계 187,500원')
  })

  it('copes with the shapes PowerShell prints for a single line or word, and with nothing', () => {
    expect(assembleOcr(undefined)).toEqual({ text: '', lines: [] })
    expect(assembleOcr([])).toEqual({ text: '', lines: [] })
    expect(assembleOcr(w('하나', 0, 0)).text).toBe('하나')
    expect(assembleOcr([w('한', 0, 0), [w('두', 0, 24), w('  ', 30, 24)]]).lines).toEqual(['한', '두'])
    expect(ocrLanguageName('ko')).toBe('한국어')
    expect(ocrLanguageName('en-US')).toBe('영어')
    expect(ocrLanguageName('fr-FR')).toBe('fr-FR')
  })
})

describe('OCR plugin helpers', () => {
  it('sizes a picture for reading: small ones enlarged, huge ones reduced', () => {
    expect(T.targetSize(800, 300, true)).toEqual({ width: 2000, height: 750, scale: 2.5 })
    expect(T.targetSize(800, 300, false)).toEqual({ width: 800, height: 300, scale: 1 })
    expect(T.targetSize(200, 100, true).scale).toBe(3)
    expect(T.targetSize(1920, 1080, true).scale).toBe(1)
    const big = T.targetSize(12000, 6000, true)
    expect(Math.max(big.width, big.height)).toBe(T.MAX_SIDE)
  })

  it('joins lines broken by the edge of the page, not paragraphs, lists or headings', () => {
    const text = ['공공기관의 문서는 정해진 서식에 따라 작성하여야 하며 서식에', '없는 사항은 따로 정하는 바에 따릅니다.', '', '1. 첫째 항목은 다음 줄로', '이어집니다.', '2. 둘째 항목', '- 붙임 자료 inter-', 'national standard'].join('\n')
    expect(T.joinLines(text)).toBe(['공공기관의 문서는 정해진 서식에 따라 작성하여야 하며 서식에 없는 사항은 따로 정하는 바에 따릅니다.', '', '1. 첫째 항목은 다음 줄로 이어집니다.', '2. 둘째 항목', '- 붙임 자료 international standard'].join('\n'))
    expect(T.joinLines('')).toBe('')
    expect(T.titleOf('\n  첫 줄 \n둘째')).toBe('첫 줄')
    expect(T.count('가 나\n\n다')).toEqual({ chars: 3, lines: 2 })
  })
})
