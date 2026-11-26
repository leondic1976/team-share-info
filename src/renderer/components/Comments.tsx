import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import { Send, Trash2 } from 'lucide-react'
import type { CommentDto } from '@shared/schemas/work'
import { sendOrQueue } from '@renderer/lib/outbox'
import { api, errorMessage } from '@renderer/lib/api'
import { useMe } from '@renderer/lib/queries'
import { Button } from './ui/button'
import { MemberLink } from './MemberLink'
import { Textarea } from './ui/input'
import { confirmPii } from '@renderer/lib/pii'
import type { PiiAck } from '@shared/pii'

/** Comment thread of a board post (6.9). */
export function Comments({ type, id }: { type: 'post'; id: string }): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const [body, setBody] = useState('')
  const [err, setErr] = useState('')
  const key = ['comments', type, id]
  const q = useQuery({ queryKey: key, queryFn: () => api.get<CommentDto[]>(`/api/comments/${type}/${id}`) })
  const done = () => {
    void qc.invalidateQueries({ queryKey: key })
    void qc.invalidateQueries({ queryKey: ['boards'] })
  }
  const add = useMutation({
    mutationFn: (pii: PiiAck) => sendOrQueue({ kind: 'comment', label: `댓글: ${body.trim().slice(0, 60)}`, path: `/api/comments/${type}/${id}`, body: { body, ...pii } }),
    onSuccess: () => {
      setBody('')
      setErr('')
      done()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const del = useMutation({ mutationFn: (cid: string) => api.del(`/api/comments/${cid}`), onSuccess: done })
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">댓글 {q.data?.length ?? 0}</h3>
      {q.data?.map((c) => (
        <div key={c.id} className="group rounded-md bg-muted/60 px-3 py-2 text-sm" data-testid="comment">
          <div className="flex items-center gap-2 text-xs">
            <MemberLink memberId={c.authorId} name={c.authorName} className="font-bold" />
            <span className="text-muted-foreground">{format(c.createdAt, 'M/d HH:mm')}</span>
            {(c.authorId === me?.id || me?.role === 'admin') && (
              <button className="invisible ml-auto cursor-pointer text-muted-foreground group-hover:visible" aria-label="댓글 삭제" onClick={() => del.mutate(c.id)}>
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
          <p className="selectable mt-0.5 whitespace-pre-wrap">{c.body}</p>
        </div>
      ))}
      <div className="flex gap-2">
        <Textarea aria-label="댓글 입력" className="min-h-10" rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="댓글을 입력하세요" />
        <Button size="icon" aria-label="댓글 등록" onClick={() => {
            const pii = confirmPii([body], '이 글을 보는 모든 사람이 보게 되며,')
            if (pii) add.mutate(pii)
          }} disabled={!body.trim() || add.isPending}>
          <Send />
        </Button>
      </div>
      {err && <p className="text-xs text-urgent">{err}</p>}
    </div>
  )
}
