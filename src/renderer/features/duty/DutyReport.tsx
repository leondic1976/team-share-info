import { Fragment, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { format } from 'date-fns'
import { ko } from 'date-fns/locale'
import { Printer } from 'lucide-react'
import { dayPart, type DutyBoardDto, type DutyMemberDto } from '@shared/schemas/duty'
import { deptPathText } from '@shared/org'
import type { DutySection } from '@shared/dutySections'
import { dutyAbsentGroups, dutyTotals, entriesByMember } from '@shared/dutyDay'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { DAY, fmtRange } from '@renderer/lib/dates'
import { useDisplayName } from '@renderer/lib/queries'
import './duty-report.css'

type Section = DutySection<DutyMemberDto>

export interface DutyReportProps {
  board: DutyBoardDto
  sections: Section[]
  /** local midnight of the reported day */
  day: number
  holiday?: string
  /** 기관·팀 name for the heading */
  org: string
  /** the department the screen is narrowed to, or '' for every department */
  scope: string
  author: string
  madeAt: number
}

/** "2026. 11. 26.(목)" */
export const reportDate = (ms: number): string => format(ms, 'yyyy. M. d.(EEE)', { locale: ko })
export const reportTitle = (day: number): string => `일일 근무상황 보고 (${reportDate(day)})`

/** 일일 근무상황 보고: the day's 인원 총괄 and the people away by 소속, on one sheet of A4. */
export function DutyReport({ board, sections, day, holiday, org, scope, author, madeAt, testId }: DutyReportProps & { testId?: string }): React.JSX.Element {
  const dn = useDisplayName()
  const byMember = useMemo(() => entriesByMember(board.entries), [board])
  const { types, all, rows } = useMemo(() => dutyTotals(sections, byMember, day), [sections, byMember, day])
  const groups = useMemo(() => dutyAbsentGroups(sections, byMember, day), [sections, byMember, day])
  const d1 = day + DAY
  const cell = (n: number, away = false): React.JSX.Element => <td className={away && n ? 'n away' : n ? 'n' : 'n zero'}>{n || (away ? 0 : '·')}</td>
  return (
    <article className="duty-sheet" data-testid={testId}>
      <h1>{reportTitle(day)}</h1>
      {holiday && <div className="sheet-holiday">공휴일: {holiday}</div>}
      <div className="sheet-meta">
        <span>
          <b>소속</b>
          {[org, scope].filter(Boolean).join(' · ') || '전체'}
        </span>
        <span>
          <b>작성 시각</b>
          {format(madeAt, 'yyyy. M. d. HH:mm')}
        </span>
        <span>
          <b>작성자</b>
          {author}
        </span>
      </div>

      <h2>1. 인원 총괄</h2>
      <table data-testid="duty-report-totals">
        <thead>
          <tr>
            <th rowSpan={2} style={{ width: '36%' }}>
              부서
            </th>
            <th rowSpan={2}>총원</th>
            <th rowSpan={2}>현재원</th>
            <th colSpan={1 + types.length}>사고</th>
          </tr>
          <tr>
            <th>계</th>
            {types.map((t) => (
              <th key={t}>{t}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="sum">
            <td>계</td>
            <td className="n">{all.total}</td>
            <td className="n">{all.present}</td>
            {cell(all.away, true)}
            {types.map((t) => (
              <Fragment key={t}>{cell(all.byType[t])}</Fragment>
            ))}
          </tr>
          {rows.map((r) => (
            <tr key={r.key} className={r.subtotal ? 'sub' : undefined}>
              <td className={r.own ? 'dept own' : 'dept'} style={{ paddingLeft: `${1.6 + r.depth * 4}mm` }}>
                {r.own ? '직속' : r.depth === 0 && r.section.path.length > 1 ? (
                  <>
                    <span className="up">{deptPathText(r.section.path.slice(0, -1))} &gt; </span>
                    {r.section.dept?.name}
                  </>
                ) : (
                  (r.section.dept?.name ?? '부서 미지정')
                )}
                {r.subtotal && ' (소계)'}
              </td>
              <td className="n">{r.total}</td>
              <td className="n">{r.present}</td>
              {cell(r.away, true)}
              {types.map((t) => (
                <Fragment key={t}>{cell(r.byType[t])}</Fragment>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      <h2>2. 사고자 명단</h2>
      {!groups.length ? (
        <div className="sheet-none">사고자 없음</div>
      ) : (
        <table data-testid="duty-report-people">
          <thead>
            <tr>
              <th>부서</th>
              <th>성명</th>
              <th>직위</th>
              <th>사유</th>
              <th>시간</th>
              <th>행선지·비고</th>
            </tr>
          </thead>
          <tbody>
            {groups.map(({ section: s, people }) => {
              const lines = people.flatMap(({ m, entries }) => entries.map((e) => ({ m, e })))
              const dept = `${deptPathText(s.path) || '부서 미지정'}${s.childCount > 0 ? ' (직속)' : ''}`
              return lines.map(({ m, e }, i) => (
                <tr key={`${e.id}:${e.key}`} data-testid="duty-report-row">
                  {i === 0 && (
                    <td className="dept" rowSpan={lines.length}>
                      {dept}
                    </td>
                  )}
                  <td style={{ whiteSpace: 'nowrap' }}>{dn(m)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{m.title ?? ''}</td>
                  <td className="n">{e.type}</td>
                  <td className="n">{dayPart(e, day, d1)}</td>
                  <td>
                    {[e.place, e.note].filter(Boolean).join(' · ')}
                    {e.end - e.start > DAY && <span style={{ color: 'var(--sheet-muted)' }}>{[e.place, e.note].some(Boolean) ? ' / ' : ''}{fmtRange(e.start, e.end, e.allDay)}</span>}
                  </td>
                </tr>
              ))
            })}
          </tbody>
        </table>
      )}
      <div className="sheet-foot">TeamHub 근무현황에서 작성</div>
    </article>
  )
}

/**
 * The preview of the report with 인쇄. While it is open a copy sits on the body for the printer,
 * and html.duty-printing hides the rest of the page while the print dialog reads it.
 */
export function DutyReportDialog({ onClose, ...p }: Omit<DutyReportProps, 'madeAt'> & { onClose: () => void }): React.JSX.Element {
  const [madeAt] = useState(() => Date.now())
  useEffect(() => () => document.documentElement.classList.remove('duty-printing'), [])
  const print = (): void => {
    const html = document.documentElement
    html.classList.add('duty-printing')
    window.addEventListener('afterprint', () => html.classList.remove('duty-printing'), { once: true })
    window.print()
  }
  return (
    <>
      <Dialog
        open
        onClose={onClose}
        title="일일 근무상황 보고 미리 보기"
        width="max-w-4xl"
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              닫기
            </Button>
            <Button onClick={print}>
              <Printer /> 인쇄
            </Button>
          </>
        }
      >
        <div className="rounded-md bg-muted p-3">
          <DutyReport {...p} madeAt={madeAt} testId="duty-report" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">A4 세로로 인쇄됩니다. 인쇄 창에서 PDF로 저장할 수도 있습니다.</p>
      </Dialog>
      {createPortal(
        <div className="duty-print-root" aria-hidden>
          <DutyReport {...p} madeAt={madeAt} />
        </div>,
        document.body
      )}
    </>
  )
}
