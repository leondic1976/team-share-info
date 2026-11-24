import { feedbackInfo, openFeedbackWindow } from '../feedback'
import { ensurePcUid } from '../pcid'
import { handle } from './registry'

export function registerFeedbackIpc(): void {
  handle('feedback:open', null, () => openFeedbackWindow())
  handle('feedback:info', null, () => feedbackInfo())
  // the unique value of this PC is made soon after the first start, not when the first post is written
  setTimeout(() => void ensurePcUid().catch(() => undefined), 15000)
}
