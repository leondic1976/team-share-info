import { describe, it, expect } from 'vitest'
import {
  canWithdraw,
  collectCreateSchema,
  collectCsvRows,
  collectZipName,
  countStatuses,
  dueReminder,
  isAccepting,
  remainingLabel,
  safeFilePart,
  statusOf,
  uniqueNames,
  zipEntryName,
  type CollectStatusRow
} from '../../src/shared/schemas/collect'

const H = 3600_000
const D = 24 * H

describe('자료 취합 rules', () => {
  it('accepts until the deadline, after it only with 마감 후 제출 허용, never once closed', () => {
    const r = { deadlineAt: 1000, allowLate: false, closedAt: null }
    expect(isAccepting(r, 1000)).toBe(true)
    expect(isAccepting(r, 1001)).toBe(false)
    expect(isAccepting({ ...r, allowLate: true }, 5000)).toBe(true)
    expect(isAccepting({ ...r, allowLate: true, closedAt: 10 }, 20)).toBe(false)
    expect(canWithdraw({ ...r, allowLate: true }, 1000)).toBe(true)
    expect(canWithdraw({ ...r, allowLate: true }, 1001)).toBe(false)
    expect(canWithdraw({ ...r, closedAt: 5 }, 10)).toBe(false)
  })

  it('status: 제출 · 늦게 제출 · 해당 없음 · 미제출, late follows the deadline', () => {
    expect(statusOf(null, 100)).toBe('none')
    expect(statusOf({ kind: 'submitted', submittedAt: 100 }, 100)).toBe('submitted')
    expect(statusOf({ kind: 'submitted', submittedAt: 101 }, 100)).toBe('late')
    expect(statusOf({ kind: 'submitted', submittedAt: 101 }, 200)).toBe('submitted')
    expect(statusOf({ kind: 'na', submittedAt: 500 }, 100)).toBe('na')
    expect(countStatuses(['submitted', 'late', 'na', 'none', 'none'])).toEqual({ total: 5, submitted: 1, late: 1, na: 1, none: 2 })
  })

  it('reminders: a day before, an hour before, none when the deadline was set inside the window', () => {
    const r = { deadlineAt: 10 * D, allowLate: true, closedAt: null, deadlineSetAt: 0 }
    expect(dueReminder(r, 10 * D - 25 * H)).toBeNull()
    expect(dueReminder(r, 10 * D - D)).toBe('day')
    expect(dueReminder(r, 10 * D - 2 * H)).toBe('day')
    expect(dueReminder(r, 10 * D - H)).toBe('hour')
    expect(dueReminder(r, 10 * D - 1)).toBe('hour')
    expect(dueReminder(r, 10 * D)).toBeNull()
    expect(dueReminder({ ...r, closedAt: 1 }, 10 * D - H)).toBeNull()
    // set three hours before the deadline: only the hour one
    const late = { ...r, deadlineSetAt: 10 * D - 3 * H }
    expect(dueReminder(late, 10 * D - 2 * H)).toBeNull()
    expect(dueReminder(late, 10 * D - 30 * 60_000)).toBe('hour')
    // set inside the last hour: nothing
    expect(dueReminder({ ...r, deadlineSetAt: 10 * D - 30 * 60_000 }, 10 * D - 10 * 60_000)).toBeNull()
  })

  it('countdown labels', () => {
    expect(remainingLabel(1000, 2000)).toBe('마감 지남')
    expect(remainingLabel(30_000, 0)).toBe('1분 남음')
    expect(remainingLabel(45 * 60_000, 0)).toBe('45분 남음')
    expect(remainingLabel(5 * H + 10, 0)).toBe('5시간 남음')
    expect(remainingLabel(3 * D + H, 0)).toBe('3일 남음')
  })

  it('file names: ZIP name, <부서>_<이름>_ prefix, no reserved characters, unique', () => {
    expect(collectZipName('2027 예산: 요구서/1차?', new Date(2026, 10, 26, 15).getTime())).toBe('자료취합_2027 예산_ 요구서_1차__20261126.zip')
    expect(zipEntryName('총무팀', '홍길동', '요구서.hwp')).toBe('총무팀_홍길동_요구서.hwp')
    expect(zipEntryName('', '홍길동', 'a\\b.hwp')).toBe('부서없음_홍길동_a_b.hwp')
    expect(safeFilePart('  끝에 점. ')).toBe('끝에 점')
    expect(safeFilePart('')).toBe('_')
    expect(uniqueNames(['a.hwp', 'A.hwp', 'a.hwp', 'b', 'b'])).toEqual(['a.hwp', 'A (2).hwp', 'a (3).hwp', 'b', 'b (2)'])
  })

  it('CSV rows of the 제출 현황', () => {
    const row = (over: Partial<CollectStatusRow>): CollectStatusRow => ({ memberId: 'm', name: '홍길동', deptName: '총무팀', deptPath: ['본부', '총무팀'], title: '주무관', status: 'none', submittedAt: null, text: '', reason: '', files: [], online: false, ...over })
    const rows = collectCsvRows([
      row({ status: 'late', submittedAt: new Date(2026, 10, 26, 9, 5).getTime(), files: [{ id: '1', name: 'a.hwp', size: 1 }, { id: '2', name: 'b.pdf', size: 1 }], text: '메모' }),
      row({ deptPath: [], status: 'na', reason: '없음' })
    ])
    expect(rows).toEqual([
      ['부서', '이름', '직위', '상태', '제출 시각', '파일', '글', '해당 없음 사유'],
      ['본부 > 총무팀', '홍길동', '주무관', '늦게 제출', '2026-11-26 09:05', 'a.hwp, b.pdf', '메모', ''],
      ['총무팀', '홍길동', '주무관', '해당 없음', '', '', '', '없음']
    ])
  })

  it('create schema: a title and a scope are needed; defaults', () => {
    expect(collectCreateSchema.safeParse({ title: ' ', deadlineAt: 1, scope: { type: 'team' } }).success).toBe(false)
    expect(collectCreateSchema.safeParse({ title: 'x', deadlineAt: 1, scope: { type: 'members', memberIds: [] } }).success).toBe(false)
    expect(collectCreateSchema.parse({ title: 'x', deadlineAt: 1, scope: { type: 'team' } })).toMatchObject({ allowLate: true, submitMode: 'file', description: '', attachmentIds: [] })
  })
})
