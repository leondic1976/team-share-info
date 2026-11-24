import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, UsersRound, Check, X, LogOut, Crown, Archive, Trash2, UserPlus, Bell, BellOff, Lock, Globe, Video } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Badge } from '@renderer/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Dialog } from '@renderer/components/Dialog'
import { MemberPicker } from '@renderer/components/ScopePicker'
import { EmptyState, Loading, OfflineState } from '@renderer/components/EmptyState'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { useDisplayName, useMe } from '@renderer/lib/queries'
import { MemberLink } from '@renderer/components/MemberLink'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { startMeeting } from '@renderer/features/meetings/MeetingsPage'
import { GROUP_COLORS, type GroupDto, type GroupInviteDto, type GroupMemberDto } from '@shared/schemas/scope'
import { cn } from '@renderer/lib/utils'

function useInvalidate(): () => void {
  const qc = useQueryClient()
  // Membership changes affect visibility of every shared item, so refetch everything.
  return () => void qc.invalidateQueries()
}

function CreateGroupDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const inv = useInvalidate()
  const [name, setName] = useState('')
  const [desc, setDesc] = useState('')
  const [color, setColor] = useState<string>(GROUP_COLORS[0])
  const [visibility, setVisibility] = useState<'private' | 'public'>('private')
  const [memberIds, setMemberIds] = useState<string[]>([])
  const [err, setErr] = useState('')
  const create = useMutation({
    mutationFn: () => api.post<GroupDto>('/api/groups', { name, description: desc, color, visibility, memberIds }),
    onSuccess: () => {
      inv()
      setName('')
      setDesc('')
      setMemberIds([])
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="새 그룹 만들기"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            취소
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            만들기
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="그룹 이름">
          <Input aria-label="그룹 이름" value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 행사 준비 TF" />
        </Field>
        <Field label="설명 (선택)">
          <Textarea aria-label="그룹 설명" value={desc} onChange={(e) => setDesc(e.target.value)} className="min-h-14" />
        </Field>
        <Field label="색상">
          <div className="flex gap-2">
            {GROUP_COLORS.map((c) => (
              <button key={c} type="button" aria-label={`색상 ${c}`} onClick={() => setColor(c)} className={cn('size-7 cursor-pointer rounded-full ring-offset-2', color === c && 'ring-2 ring-foreground')} style={{ background: c }} />
            ))}
          </div>
        </Field>
        <Field label="종류">
          <div className="flex gap-2">
            <Button size="sm" variant={visibility === 'private' ? 'default' : 'outline'} onClick={() => setVisibility('private')}>
              <Lock /> 비공개 (초대로만 가입)
            </Button>
            <Button size="sm" variant={visibility === 'public' ? 'default' : 'outline'} onClick={() => setVisibility('public')}>
              <Globe /> 공개 (목록에 보이고 가입 신청 가능)
            </Button>
          </div>
        </Field>
        <Field label="초대할 사람">
          <MemberPicker value={memberIds} onChange={setMemberIds} excludeSelf />
        </Field>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function GroupDetail({ group, onClose }: { group: GroupDto; onClose: () => void }): React.JSX.Element {
  const dn = useDisplayName()
  const inv = useInvalidate()
  const { data: me } = useMe()
  const [inviteIds, setInviteIds] = useState<string[]>([])
  const [err, setErr] = useState('')
  const detail = useQuery({
    queryKey: ['groups', group.id],
    queryFn: () => api.get<GroupDto & { members: GroupMemberDto[] }>(`/api/groups/${group.id}`)
  })
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      setErr('')
      inv()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const g = detail.data ?? { ...group, members: [] }
  const isOwner = g.myRole === 'owner' || me?.role === 'admin'
  const archived = g.state === 'archived'
  return (
    <Dialog open onClose={onClose} title={g.name} width="max-w-2xl">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="size-3 rounded-full" style={{ background: g.color }} />
          {g.visibility === 'private' ? <Badge variant="muted">비공개</Badge> : <Badge>공개</Badge>}
          {archived && <Badge variant="important">보관됨(읽기 전용)</Badge>}
          <span className="text-muted-foreground">그룹장 {g.ownerName} · {g.memberCount}명</span>
        </div>
        {g.description && <p className="text-sm">{g.description}</p>}
        {g.myRole && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() =>
                void startMeeting({ title: `${g.name} 회의`, mode: 'video', scope: { type: 'group', groupIds: [g.id], memberIds: [] } }).catch((e: unknown) => window.alert(errorMessage(e)))
              }
            >
              <Video /> 그룹 회의 시작
            </Button>
            <Button size="sm" variant="outline" onClick={() => run.mutate(() => api.patch(`/api/groups/${g.id}`, { notify: !g.notify }))}>
              {g.notify ? <BellOff /> : <Bell />} {g.notify ? '이 그룹 알림 끄기' : '이 그룹 알림 켜기'}
            </Button>
            {g.myRole === 'member' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (window.confirm(`'${g.name}' 그룹에서 나갈까요? 그룹 자료를 더 이상 볼 수 없습니다.`))
                    run.mutate(() => api.del(`/api/groups/${g.id}/members/${me?.id}`).then(onClose))
                }}
              >
                <LogOut /> 그룹 나가기
              </Button>
            )}
          </div>
        )}
        <Card>
          <CardHeader>
            <CardTitle>구성원</CardTitle>
          </CardHeader>
          <div className="max-h-56 divide-y divide-border overflow-y-auto">
            {g.members.map((m) => (
              <div key={m.memberId} className="flex items-center gap-2 px-4 py-1.5 text-sm">
                {m.role === 'owner' && <Crown className="size-4 text-important" aria-label="그룹장" />}
                <MemberLink memberId={m.memberId} name={m.name}>
                  {dn({ id: m.memberId, name: m.name })}
                </MemberLink>
                <span className="text-xs text-muted-foreground">{m.deptName}</span>
                {isOwner && m.role !== 'owner' && (
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => window.confirm(`${m.name}님에게 그룹장을 넘길까요?`) && run.mutate(() => api.patch(`/api/groups/${g.id}`, { ownerId: m.memberId }))}>
                      그룹장 넘기기
                    </Button>
                    <Button size="sm" variant="ghost" className="text-urgent" onClick={() => window.confirm(`${m.name}님을 내보낼까요?`) && run.mutate(() => api.del(`/api/groups/${g.id}/members/${m.memberId}`))}>
                      내보내기
                    </Button>
                  </span>
                )}
              </div>
            ))}
          </div>
        </Card>
        {isOwner && !archived && (
          <Card>
            <CardHeader>
              <CardTitle>초대하기</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <MemberPicker value={inviteIds} onChange={setInviteIds} excludeSelf />
              <Button size="sm" disabled={!inviteIds.length} onClick={() => run.mutate(() => api.post(`/api/groups/${g.id}/invites`, { memberIds: inviteIds }).then(() => setInviteIds([])))}>
                <UserPlus /> 초대 보내기
              </Button>
            </CardContent>
          </Card>
        )}
        {isOwner && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button size="sm" variant="outline" onClick={() => run.mutate(() => api.patch(`/api/groups/${g.id}`, { state: archived ? 'active' : 'archived' }))}>
              <Archive /> {archived ? '보관 해제' : '보관(읽기 전용으로 남김)'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-urgent"
              onClick={() => {
                if (window.confirm(`'${g.name}' 그룹을 해체할까요? 구성원이 모두 빠지고 그룹 자료는 작성자만 볼 수 있게 됩니다.`)) run.mutate(() => api.del(`/api/groups/${g.id}`).then(onClose))
              }}
            >
              <Trash2 /> 그룹 해체
            </Button>
          </div>
        )}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

export function GroupsPage(): React.JSX.Element {
  const online = useConn((s) => s.state === 'online')
  const inv = useInvalidate()
  const setSpace = useSpace((s) => s.setSpace)
  const [creating, setCreating] = useState(false)
  const [selected, setSelected] = useState<GroupDto | null>(null)
  const groups = useQuery({ queryKey: ['groups', 'list'], queryFn: () => api.get<GroupDto[]>('/api/groups'), enabled: online })
  const invites = useQuery({ queryKey: ['groups', 'invites'], queryFn: () => api.get<GroupInviteDto[]>('/api/group-invites'), enabled: online })
  const act = useMutation({
    mutationFn: ({ groupId, id, action }: { groupId: string; id: string; action: string }) => api.patch(`/api/groups/${groupId}/invites/${id}`, { action }),
    onSuccess: inv
  })
  const joinReq = useMutation({ mutationFn: (id: string) => api.post(`/api/groups/${id}/join-requests`), onSuccess: inv })

  if (!online && !groups.data) return <OfflineState />
  const mine = (groups.data ?? []).filter((g) => g.myRole)
  const others = (groups.data ?? []).filter((g) => !g.myRole)

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="그룹"
        description="팀 안에서 일부 구성원끼리만 정보를 나누는 공간입니다."
        actions={
          <Button onClick={() => setCreating(true)} disabled={!online}>
            <Plus /> 새 그룹
          </Button>
        }
      />
      <div className="flex-1 space-y-5 overflow-y-auto p-5">
        {(invites.data?.length ?? 0) > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>받은 초대·가입 신청</CardTitle>
            </CardHeader>
            <div className="divide-y divide-border">
              {invites.data!.map((i) => (
                <div key={i.id} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="group-invite">
                  <span className="size-3 rounded-full" style={{ background: i.groupColor }} />
                  {i.kind === 'invite' ? (
                    <span>
                      <b>{i.groupName}</b> 그룹에 초대받았습니다.
                    </span>
                  ) : (
                    <span>
                      <b>{i.memberName}</b>님이 <b>{i.groupName}</b> 가입을 신청했습니다.
                    </span>
                  )}
                  <span className="ml-auto flex gap-1">
                    <Button size="sm" onClick={() => act.mutate({ groupId: i.groupId, id: i.id, action: i.kind === 'invite' ? 'accept' : 'approve' })}>
                      <Check /> {i.kind === 'invite' ? '수락' : '승인'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => act.mutate({ groupId: i.groupId, id: i.id, action: i.kind === 'invite' ? 'decline' : 'reject' })}>
                      <X /> 거절
                    </Button>
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
        <section>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">내 그룹</h2>
          {groups.isLoading ? (
            <Loading />
          ) : mine.length ? (
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {mine.map((g) => (
                <Card key={g.id} className="cursor-pointer p-4 hover:border-primary" onClick={() => setSelected(g)} data-testid={`group-card-${g.name}`}>
                  <div className="flex items-center gap-2">
                    <span className="size-3 rounded-full" style={{ background: g.color }} />
                    <span className="font-semibold">{g.name}</span>
                    {g.myRole === 'owner' && <Crown className="size-3.5 text-important" aria-label="그룹장" />}
                    {g.state === 'archived' && <Badge variant="important">보관됨</Badge>}
                  </div>
                  <p className="mt-1 line-clamp-2 min-h-8 text-xs text-muted-foreground">{g.description || ' '}</p>
                  <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                    <span>{g.memberCount}명</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation()
                        setSpace(g.id)
                      }}
                    >
                      이 그룹으로 전환
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <EmptyState icon={UsersRound} title="속한 그룹이 없습니다" description="새 그룹을 만들거나 공개 그룹에 가입하세요." />
          )}
        </section>
        {others.length > 0 && (
          <section>
            <h2 className="mb-2 text-sm font-semibold text-muted-foreground">공개 그룹·초대받은 그룹</h2>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {others.map((g) => (
                <Card key={g.id} className="p-4">
                  <div className="flex items-center gap-2">
                    <span className="size-3 rounded-full" style={{ background: g.color }} />
                    <span className="font-semibold">{g.name}</span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    그룹장 {g.ownerName} · {g.memberCount}명
                  </p>
                  <div className="mt-2">
                    {g.myPending === 'request' ? (
                      <Badge variant="muted">가입 신청함</Badge>
                    ) : g.myPending === 'invite' ? (
                      <Button size="sm" onClick={() => act.mutate({ groupId: g.id, id: g.inviteId!, action: 'accept' })}>
                        초대 수락
                      </Button>
                    ) : (
                      <Button size="sm" variant="outline" onClick={() => joinReq.mutate(g.id)}>
                        가입 신청
                      </Button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </section>
        )}
      </div>
      <CreateGroupDialog open={creating} onClose={() => setCreating(false)} />
      {selected && <GroupDetail group={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
