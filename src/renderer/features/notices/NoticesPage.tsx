import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { Plus, Megaphone, Pin, Paperclip, BellRing, Trash2, CheckCircle2, Clock } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Badge } from '@renderer/components/ui/badge'
import { Card } from '@renderer/components/ui/card'
import { EmptyState, ErrorState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { RichView } from '@renderer/components/Editor'
import { AttachmentList } from '@renderer/components/Attachments'
import { ScopeTags } from '@renderer/components/ScopePicker'
import { api, errorMessage } from '@renderer/lib/api'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { useMe } from '@renderer/lib/queries'
import { NOTICE_LEVEL_LABEL, type NoticeDto, type NoticeSummaryDto, type ReceiptDto } from '@shared/schemas/notices'
import { cn } from '@renderer/lib/utils'
import { NoticeCompose } from './NoticeCompose'
import { FavoriteStar } from '@renderer/features/memos/widgets'

type Filter = 'all' | 'unread' | 'mine'

export function LevelBadge({ level }: { level: NoticeSummaryDto['level'] }): React.JSX.Element | null {
  if (level === 'normal') return null
  return <Badge variant={level === 'urgent' ? 'urgent' : 'important'}>{NOTICE_LEVEL_LABEL[level]}</Badge>
}

const fmt = (t: number | null): string => (t ? format(t, 'M/d HH:mm') : '-')

function ReceiptsBoard({ notice }: { notice: NoticeDto }): React.JSX.Element {
  const [tab, setTab] = useState<'pending' | 'done'>('pending')
  const [msg, setMsg] = useState('')
  const q = useQuery({ queryKey: ['notices', notice.id, 'receipts'], queryFn: () => api.get<ReceiptDto[]>(`/api/notices/${notice.id}/receipts`), refetchInterval: 15000 })
  const renotify = useMutation({
    mutationFn: () => api.post<{ count: number; online: number }>(`/api/notices/${notice.id}/renotify`),
    onSuccess: (r) => setMsg(`${r.count}명에게 다시 알렸습니다 (지금 접속 중 ${r.online}명, 나머지는 접속하면 받습니다).`),
    onError: (e) => setMsg(errorMessage(e))
  })
  const list = q.data ?? []
  const doneOf = (r: ReceiptDto): boolean => (notice.requireAck ? !!r.ackedAt : !!r.readAt)
  const pending = list.filter((r) => !doneOf(r))
  const done = list.filter(doneOf)
  const shown = tab === 'pending' ? pending : done
  return (
    <Card className="mt-6" data-testid="receipts-board">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2">
        <h3 className="text-sm font-semibold">수신 현황</h3>
        <span className="text-xs text-muted-foreground">
          {notice.requireAck ? '확인' : '읽음'} {done.length} / {list.length}
        </span>
        <div className="ml-4 flex gap-1">
          <Button size="sm" variant={tab === 'pending' ? 'secondary' : 'ghost'} onClick={() => setTab('pending')}>
            {notice.requireAck ? '미확인' : '안 읽음'} {pending.length}
          </Button>
          <Button size="sm" variant={tab === 'done' ? 'secondary' : 'ghost'} onClick={() => setTab('done')}>
            {notice.requireAck ? '확인함' : '읽음'} {done.length}
          </Button>
        </div>
        <Button size="sm" variant="outline" className="ml-auto" onClick={() => renotify.mutate()} disabled={!pending.length || renotify.isPending}>
          <BellRing /> 다시 알림
        </Button>
      </div>
      {msg && <p className="px-4 pt-2 text-xs text-muted-foreground">{msg}</p>}
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-1.5">이름</th>
            <th>전달</th>
            <th>읽음</th>
            {notice.requireAck && <th>확인</th>}
            {notice.replyOptions.length > 0 && <th>회신</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {shown.map((r) => (
            <tr key={r.memberId} data-testid={`receipt-${r.name}`}>
              <td className="px-4 py-1.5">
                <span className="flex items-center gap-1.5">
                  <span className={cn('inline-block size-2 rounded-full', r.online ? 'bg-success' : 'bg-muted-foreground/40')} />
                  {r.name} <span className="text-xs text-muted-foreground">{r.deptName}</span>
                </span>
              </td>
              <td className="text-muted-foreground">{fmt(r.deliveredAt)}</td>
              <td>{fmt(r.readAt)}</td>
              {notice.requireAck && <td>{fmt(r.ackedAt)}</td>}
              {notice.replyOptions.length > 0 && <td className="font-medium">{r.reply ?? '-'}</td>}
            </tr>
          ))}
          {shown.length === 0 && (
            <tr>
              <td colSpan={5} className="px-4 py-3 text-center text-xs text-muted-foreground">
                없음
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {notice.replyOptions.length > 0 && (
        <div className="flex gap-3 border-t border-border px-4 py-2 text-xs">
          {notice.replyOptions.map((o) => (
            <span key={o}>
              {o}: <b>{list.filter((r) => r.reply === o).length}</b>
            </span>
          ))}
        </div>
      )}
    </Card>
  )
}

function NoticeDetail({ id }: { id: string }): React.JSX.Element {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { data: me } = useMe()
  const [err, setErr] = useState('')
  const q = useQuery({ queryKey: ['notices', id], queryFn: () => api.get<NoticeDto>(`/api/notices/${id}`) })
  const n = q.data
  const read = useMutation({ mutationFn: () => api.post(`/api/notices/${id}/read`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notices'] }) })
  const ack = useMutation({
    mutationFn: (reply?: string) => api.post(`/api/notices/${id}/ack`, reply ? { reply } : {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['notices'] }),
    onError: (e) => setErr(errorMessage(e))
  })
  const patch = useMutation({ mutationFn: (body: Record<string, unknown>) => api.patch(`/api/notices/${id}`, body), onSuccess: () => void qc.invalidateQueries({ queryKey: ['notices'] }) })
  const del = useMutation({
    mutationFn: () => api.del(`/api/notices/${id}`),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['notices'] })
      navigate('/notices')
    }
  })
  const unread = !!n?.my && !n.my.readAt
  const mutateRead = read.mutate
  useEffect(() => {
    if (unread) mutateRead()
  }, [unread, mutateRead])

  if (q.isLoading) return <Loading />
  if (q.error || !n) return <ErrorState error={q.error ?? '공지를 찾을 수 없습니다.'} />
  const canManage = n.authorId === me?.id || me?.role === 'admin'
  const expired = !!n.expiresAt && n.expiresAt < Date.now()
  return (
    <div className="mx-auto max-w-3xl px-6 py-5" data-testid="notice-detail">
      <div className="flex flex-wrap items-center gap-2">
        <LevelBadge level={n.level} />
        {n.pinned && <Pin className="size-4 text-primary" aria-label="고정" />}
        {!n.publishedAt && (
          <Badge variant="muted">
            <Clock className="size-3" /> 예약 {fmt(n.publishAt)}
          </Badge>
        )}
        {expired && <Badge variant="muted">만료</Badge>}
        <ScopeTags scope={n.scope} />
      </div>
      <h2 className="mt-2 flex items-center gap-1 text-xl font-bold">
        {n.title}
        <FavoriteStar itemType="notice" itemId={n.id} title={n.title} route={`/notices/${n.id}`} />
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        {n.authorName} · {fmt(n.publishedAt ?? n.publishAt)}
        {n.expiresAt ? ` · ${fmt(n.expiresAt)}까지` : ''}
      </p>
      <RichView html={n.bodyHtml} className="mt-4" />
      {n.attachments.length > 0 && (
        <div className="mt-4">
          <AttachmentList items={n.attachments} />
        </div>
      )}
      {n.my && n.requireAck && (
        <div className={cn('mt-6 rounded-lg border-2 p-4', n.my.ackedAt ? 'border-success/40 bg-success/5' : 'border-urgent/40 bg-urgent/5')}>
          {n.my.ackedAt ? (
            <p className="flex items-center gap-2 text-sm text-success">
              <CheckCircle2 className="size-4" /> {fmt(n.my.ackedAt)}에 확인했습니다{n.my.reply ? ` (회신: ${n.my.reply})` : ''}.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">이 공지는 확인이 필요합니다.</span>
              {n.replyOptions.length ? (
                n.replyOptions.map((o) => (
                  <Button key={o} size="sm" onClick={() => ack.mutate(o)}>
                    {o}
                  </Button>
                ))
              ) : (
                <Button size="sm" onClick={() => ack.mutate(undefined)}>
                  <CheckCircle2 /> 확인
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {err && <p className="mt-2 text-sm text-urgent">{err}</p>}
      {canManage && (
        <div className="mt-6 flex gap-2 border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={() => patch.mutate({ pinned: !n.pinned })}>
            <Pin /> {n.pinned ? '고정 해제' : '맨 위에 고정'}
          </Button>
          <Button size="sm" variant="outline" className="text-urgent" onClick={() => window.confirm('이 공지를 삭제할까요?') && del.mutate()}>
            <Trash2 /> 삭제
          </Button>
        </div>
      )}
      {canManage && n.publishedAt && <ReceiptsBoard notice={n} />}
    </div>
  )
}

export function NoticesPage(): React.JSX.Element {
  const { id } = useParams()
  const navigate = useNavigate()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [filter, setFilter] = useState<Filter>('all')
  const [composing, setComposing] = useState(false)
  const q = useQuery({
    queryKey: ['notices', 'list', filter, space],
    queryFn: () => api.get<NoticeSummaryDto[]>('/api/notices', { filter, groupId: space === 'team' ? undefined : space }),
    enabled: online,
    placeholderData: (p) => p
  })

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="공지"
        description="공지와 긴급알림. 받은 사람별로 읽음·확인 여부가 기록됩니다."
        actions={
          <Button onClick={() => setComposing(true)} disabled={!online}>
            <Plus /> 공지 쓰기
          </Button>
        }
      />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-96 shrink-0 flex-col border-r border-border">
          <div className="flex gap-1 border-b border-border p-2">
            {(
              [
                ['all', '전체'],
                ['unread', '안 읽음'],
                ['mine', '내가 쓴 공지']
              ] as const
            ).map(([v, l]) => (
              <Button key={v} size="sm" variant={filter === v ? 'secondary' : 'ghost'} onClick={() => setFilter(v)}>
                {l}
              </Button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto" data-testid="notice-list">
            {!online && !q.data ? (
              <OfflineState />
            ) : q.isLoading ? (
              <Loading />
            ) : !q.data?.length ? (
              <EmptyState icon={Megaphone} title="공지가 없습니다" />
            ) : (
              q.data.map((n) => {
                const unread = !!n.my && !n.my.readAt
                const needAck = !!n.my && n.requireAck && !n.my.ackedAt
                return (
                  <button
                    key={n.id}
                    onClick={() => navigate(`/notices/${n.id}`)}
                    className={cn('block w-full cursor-pointer border-b border-border px-4 py-3 text-left hover:bg-muted', id === n.id && 'bg-primary/5')}
                    data-testid={`notice-item-${n.title}`}
                  >
                    <div className="flex items-center gap-1.5">
                      {unread && <span className="size-2 shrink-0 rounded-full bg-primary" aria-label="안 읽음" />}
                      <LevelBadge level={n.level} />
                      {n.pinned && <Pin className="size-3.5 text-primary" />}
                      <span className={cn('truncate text-sm', unread ? 'font-bold' : 'font-medium')}>{n.title}</span>
                    </div>
                    <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                      <span>{n.authorName}</span>
                      <span>{fmt(n.publishedAt ?? n.publishAt)}</span>
                      {!n.publishedAt && <span className="text-important">예약</span>}
                      {n.attachmentCount > 0 && <Paperclip className="size-3" />}
                      {needAck && <span className="font-semibold text-urgent">확인 필요</span>}
                      {n.stats && (
                        <span className="ml-auto">
                          {n.requireAck ? '확인' : '읽음'} {n.requireAck ? n.stats.acked : n.stats.read}/{n.stats.total}
                        </span>
                      )}
                    </div>
                    <div className="mt-1">
                      <ScopeTags scope={n.scope} />
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto">
          {id ? <NoticeDetail key={id} id={id} /> : <EmptyState icon={Megaphone} title="공지를 선택하세요" />}
        </div>
      </div>
      <NoticeCompose open={composing} onClose={() => setComposing(false)} onCreated={(nid) => navigate(`/notices/${nid}`)} />
    </div>
  )
}
