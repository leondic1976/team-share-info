import type { z } from 'zod'
import { AppError } from './errors'

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value)
  if (!r.success) {
    const issue = r.error.issues[0]
    const path = issue?.path?.length ? `${issue.path.join('.')}: ` : ''
    throw new AppError('BAD_REQUEST', `${path}${issue?.message ?? '잘못된 요청입니다.'}`, 400)
  }
  return r.data
}

export function ok<T>(data: T): { data: T } {
  return { data }
}
