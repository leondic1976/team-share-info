import { MEMO_COLORS, type MemoColor } from '@shared/schemas/tools'
import { cn } from '@renderer/lib/utils'

const COLOR_LABEL: Record<MemoColor, string> = { yellow: '노랑', green: '초록', blue: '파랑', pink: '분홍', gray: '회색' }

export function ColorPicker({ value, onChange }: { value: MemoColor; onChange: (c: MemoColor) => void }): React.JSX.Element {
  return (
    <div className="flex gap-1" role="radiogroup" aria-label="메모 색상">
      {(Object.keys(MEMO_COLORS) as MemoColor[]).map((c) => (
        <button
          key={c}
          role="radio"
          aria-checked={value === c}
          aria-label={COLOR_LABEL[c]}
          title={COLOR_LABEL[c]}
          className={cn('size-5 cursor-pointer rounded-full border border-black/10', value === c && 'ring-2 ring-primary ring-offset-1')}
          style={{ background: MEMO_COLORS[c] }}
          onClick={() => onChange(c)}
        />
      ))}
    </div>
  )
}
