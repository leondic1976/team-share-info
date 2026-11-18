import { z } from 'zod'
import { FEEDBACK_LIMITS } from '../../node/feedback'
import { feedbackInfo, openFeedbackWindow, sendFeedback } from '../feedback'
import { ensurePcUid } from '../pcid'
import { handle } from './registry'

export function registerFeedbackIpc(): void {
  handle('feedback:open', null, () => openFeedbackWindow())
  handle('feedback:info', null, () => feedbackInfo())
  handle(
    'feedback:submit',
    z.object({
      kind: z.enum(['feature', 'bug']),
      title: z.string().trim().min(FEEDBACK_LIMITS.titleMin).max(FEEDBACK_LIMITS.titleMax),
      body: z.string().trim().min(FEEDBACK_LIMITS.bodyMin).max(FEEDBACK_LIMITS.bodyMax),
      author: z.string().trim().max(FEEDBACK_LIMITS.authorMax),
      includeEnv: z.boolean()
    }),
    (r) => sendFeedback(r)
  )
  // the unique value of this PC is made soon after the first start, not when the first post is written
  setTimeout(() => void ensurePcUid().catch(() => undefined), 15000)
}
