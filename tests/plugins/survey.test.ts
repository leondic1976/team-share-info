import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'

/* eslint-disable @typescript-eslint/no-explicit-any */
const ctx: Record<string, any> = {}
runInNewContext(readFileSync(join(import.meta.dirname, '../../plugins/survey/survey.js'), 'utf8'), ctx)
const S = ctx.Survey

const made = S.cleanSurvey({
  desc: '워크숍',
  questions: [
    { id: 'q1', type: 'single', text: '날짜', options: '5/10\n5/17\n5/10\n', required: true },
    { id: 'q2', type: 'multi', text: '활동', options: ['등산', '볼링', '영화'], required: false },
    { id: 'q3', type: 'rating', text: '작년 만족도', required: false },
    { id: 'q4', type: 'text', text: '건의', required: false }
  ],
  results: 'answered',
  deadline: 5000
})
const room = (over: Record<string, unknown> = {}): any => ({
  id: 'r1',
  title: '워크숍 설문',
  createdBy: 'a',
  closed: false,
  shared: made.survey,
  entries: {
    a: { name: '김', at: 100, value: { answers: { q1: '5/10', q2: ['등산', '영화'], q3: 4, q4: '=SUM(1)' } } },
    b: { name: '이', at: 200, value: { answers: { q1: '5/17', q2: ['등산'], q3: 5 } } },
    c: { name: '박', at: 300, value: { answers: { q1: '없는 보기', q2: 'x', q3: 9 } } }
  },
  ...over
})

describe('survey plugin', () => {
  it('checks a survey before it is saved', () => {
    expect(made.survey.questions[0].options).toEqual(['5/10', '5/17']) // duplicates and blanks dropped
    expect(made.survey).toMatchObject({ app: 'survey', anonymous: false, results: 'answered', deadline: 5000 })
    expect(S.cleanSurvey({ questions: [] }).error).toContain('문항')
    expect(S.cleanSurvey({ questions: [{ type: 'single', text: '', options: 'a\nb' }] }).error).toContain('1번 문항의 질문')
    expect(S.cleanSurvey({ questions: [{ type: 'single', text: '질문', options: '하나' }] }).error).toContain('보기를 2개')
    expect(S.cleanSurvey({ questions: [{ type: 'text', text: '질문' }], results: '???' }).survey.results).toBe('answered')
    expect(S.isSurvey(made.survey)).toBe(true)
    expect(S.isSurvey({ app: 'matjip' })).toBe(false)
  })

  it('checks answers: only offered options, required questions', () => {
    expect(S.cleanAnswers(made.survey, { q2: ['등산'] }).error).toContain('1번 문항')
    expect(S.cleanAnswers(made.survey, { q1: '5/10', q2: ['영화', '해킹'], q3: '3', q4: '  ' }).answers).toEqual({ q1: '5/10', q2: ['영화'], q3: 3 })
  })

  it('tallies answers; values that were never offered are not counted', () => {
    const t = S.tally(room())
    expect(t[0].answered).toBe(2)
    expect(t[0].options.map((o: any) => [o.label, o.count, o.percent])).toEqual([
      ['5/10', 1, 50],
      ['5/17', 1, 50]
    ])
    expect(t[1].options.map((o: any) => o.count)).toEqual([2, 0, 1])
    expect(t[1].options[0].names).toEqual(['김', '이'])
    expect(t[2]).toMatchObject({ average: 4.5, counts: [0, 0, 0, 1, 1], answered: 2 })
    expect(t[3].texts).toEqual([{ name: '김', text: '=SUM(1)' }])
  })

  it('open until closed or past the deadline; who may see the results', () => {
    expect(S.isOpen(room(), 4999)).toBe(true)
    expect(S.isOpen(room(), 5000)).toBe(false)
    expect(S.isOpen(room({ closed: true }), 1)).toBe(false)
    expect(S.canSeeResults(room(), 'a', 1)).toBe(true) // the creator
    expect(S.canSeeResults(room(), 'b', 1)).toBe(true) // answered
    expect(S.canSeeResults(room(), 'z', 1)).toBe(false)
    expect(S.canSeeResults(room(), 'z', 9999)).toBe(true) // closed
    const only = room({ shared: { ...made.survey, results: 'creator' } })
    expect(S.canSeeResults(only, 'b', 9999)).toBe(false)
    expect(S.canSeeResults(room({ shared: { ...made.survey, results: 'closed' } }), 'b', 1)).toBe(false)
  })

  it('CSV: one row per response, formulas made harmless, names left out when hidden', () => {
    const csv = S.toCsv(room())
    const lines = csv.replace('﻿', '').trim().split('\r\n')
    expect(lines[0]).toBe('이름,응답 시각,1. 날짜,2. 활동,3. 작년 만족도,4. 건의')
    expect(lines[1]).toMatch(/^김,.*,5\/10,등산 \/ 영화,4,'=SUM\(1\)$/)
    expect(lines).toHaveLength(4)
    const anon = S.toCsv(room({ shared: { ...made.survey, anonymous: true } }))
    expect(anon).toContain('번호,응답 시각')
    expect(anon).not.toContain('김')
    expect(S.summaryText(room())).toContain('[설문 결과] 워크숍 설문 (응답 3명)')
  })
})
