import type { ErrorCode } from '../shared/constants'

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly status = 400,
    /** extra facts for the client, sent as `error.details` (e.g. the kinds of PII_UNCONFIRMED) */
    readonly details?: Record<string, unknown>
  ) {
    super(message)
  }
}

export const notFound = (what = '항목'): AppError => new AppError('NOT_FOUND', `${what}을(를) 찾을 수 없습니다.`, 404)
export const forbidden = (msg = '권한이 없습니다.'): AppError => new AppError('FORBIDDEN', msg, 403)
export const badRequest = (msg: string): AppError => new AppError('BAD_REQUEST', msg, 400)
export const conflict = (msg: string): AppError => new AppError('CONFLICT', msg, 409)
