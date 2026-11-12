import { describe, it, expect } from 'vitest'
import { addDays, addWorkdays, convertUnit, dDay, daysBetween, evalExpression, workdaysBetween } from '../../src/shared/calc'

describe('calculation tools (M6-9)', () => {
  it('calculator follows precedence, percent and separators', () => {
    expect(evalExpression('1 + 2 * 3')).toBe(7)
    expect(evalExpression('(1+2)*3')).toBe(9)
    expect(evalExpression('0.1+0.2')).toBe(0.3)
    expect(evalExpression('1,200,000 × 10%')).toBe(120000)
    expect(evalExpression('-2^2')).toBe(-4)
    expect(evalExpression('2^3^2')).toBe(512)
    expect(evalExpression('10 ÷ 4')).toBe(2.5)
    expect(() => evalExpression('1/0')).toThrow('0으로')
    expect(() => evalExpression('1+')).toThrow()
    expect(() => evalExpression('alert(1)')).toThrow()
  })

  it('date math: D-day, days, working days with holidays', () => {
    expect(daysBetween('2026-11-12', '2026-12-25')).toBe(43)
    expect(dDay('2026-11-15', '2026-11-12')).toBe('D-3')
    expect(dDay('2026-11-12', '2026-11-12')).toBe('D-Day')
    expect(dDay('2026-11-10', '2026-11-12')).toBe('D+2')
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01')
    // Mon 2026-11-16 .. Fri 2026-11-20 = 5, minus a holiday on Wed
    expect(workdaysBetween('2026-11-16', '2026-11-22')).toBe(5)
    expect(workdaysBetween('2026-11-22', '2026-11-16', new Set(['2026-11-18']))).toBe(4)
    // 3 working days after Friday 2026-11-20 is Wednesday 2026-11-25
    expect(addWorkdays('2026-11-20', 3)).toBe('2026-11-25')
    expect(addWorkdays('2026-11-25', -3)).toBe('2026-11-20')
  })

  it('unit conversion', () => {
    expect(convertUnit('area', 1, 'pyeong', 'm2')).toBeCloseTo(3.305785, 5)
    expect(convertUnit('area', 84, 'm2', 'pyeong')).toBeCloseTo(25.41, 2)
    expect(convertUnit('length', 1, 'mi', 'km')).toBe(1.609344)
    expect(convertUnit('data', 1, 'GB', 'MB')).toBe(1024)
    expect(convertUnit('weight', 1, 'geun', 'kg')).toBe(0.6)
    expect(convertUnit('temperature', 100, 'C', 'F')).toBe(212)
    expect(convertUnit('temperature', 32, 'F', 'K')).toBe(273.15)
    expect(() => convertUnit('length', 1, 'x', 'm')).toThrow()
  })
})
