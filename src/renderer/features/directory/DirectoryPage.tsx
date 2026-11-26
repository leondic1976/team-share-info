import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Search, Users, BookUser, UserCog, Plus, Upload, Download, Phone, Smartphone, Pencil, Trash2 } from 'lucide-react'
import { PageHeader } from '@renderer/components/PageHeader'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Card, CardContent } from '@renderer/components/ui/card'
import { Dialog } from '@renderer/components/Dialog'
import { PresenceDot } from '@renderer/components/PresenceDot'
import { ScopePicker, ScopeTags, defaultScope } from '@renderer/components/ScopePicker'
import { EmptyState, OfflineState } from '@renderer/components/EmptyState'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { useHello, useMembers, useMe } from '@renderer/lib/queries'
import { useConn } from '@renderer/app/conn-store'
import { useSpace } from '@renderer/app/space-store'
import { displayName, type MemberDto } from '@shared/schemas/auth'
import type { ContactDto } from '@shared/schemas/work'
import type { ScopeInput } from '@shared/schemas/scope'
import { CONTACT_COLUMNS, csvToContacts, parseCsv, toCsv } from '@shared/csv'
import { decodeText } from '@shared/text-decode'
import { matchesHangul } from '@shared/hangul'
import { MemberCard } from './MemberCard'
import { MemberLink } from '@renderer/components/MemberLink'
import { DeptPicker, deptPathError, type DeptChoice } from '@renderer/components/DeptPicker'
import { useDepartments } from '@renderer/features/org/useOrgData'
import type { DepartmentDto } from '@shared/schemas/org'
import { DEPT_SEP, affiliationText, deptOptions, deptPathText } from '@shared/org'

type Dept = DepartmentDto

function MembersTab(): React.JSX.Element {
  const { data: members } = useMembers()
  const { data: depts } = useDepartments()
  const [q, setQ] = useState('')
  const [card, setCard] = useState<MemberDto | null>(null)
  // the whole affiliation is searched: "총무과" also finds the people of the teams below it
  const list = (members ?? []).filter((m) => !q.trim() || matchesHangul(`${m.name} ${m.nickname ?? ''} ${affiliationText(m)} ${m.title ?? ''} ${m.duty ?? ''} ${m.ext ?? ''}`, q))
  // Org chart: department tree order, members under each department.
  const tree = useMemo(() => {
    const out: { dept: Dept | null; depth: number; path: string[]; members: MemberDto[] }[] = deptOptions(depts ?? []).map((o) => ({
      dept: (depts ?? []).find((d) => d.id === o.id) ?? null,
      depth: o.depth,
      path: o.path,
      members: list.filter((m) => m.deptId === o.id)
    }))
    const none = list.filter((m) => !m.deptId || !(depts ?? []).some((d) => d.id === m.deptId))
    if (none.length) out.push({ dept: null, depth: 0, path: [], members: none })
    return out
  }, [depts, list])
  return (
    <div className="space-y-4">
      <div className="relative max-w-sm">
        <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
        <Input aria-label="구성원 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="이름·부서·업무·내선 검색" />
      </div>
      {tree
        .filter((t) => t.members.length || !q)
        .map((t) => (
          <section key={t.dept?.id ?? 'none'} style={{ marginLeft: t.depth * 20 }}>
            <h3 className="mb-1.5 text-sm font-semibold text-muted-foreground" title={deptPathText(t.path) || undefined} data-testid={t.dept ? `directory-dept-${deptPathText(t.path)}` : undefined}>
              {t.path.length > 1 && (
                <span className="font-normal">
                  {deptPathText(t.path.slice(0, -1))}
                  {DEPT_SEP}
                </span>
              )}
              {t.dept?.name ?? '부서 미지정'} <span className="font-normal">({t.members.length})</span>
            </h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {t.members.map((m) => (
                <button key={m.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-border bg-card px-3 py-2 text-left hover:border-primary" title={affiliationText(m) || undefined} onClick={() => setCard(m)} data-testid={`member-card-${m.name}`}>
                  <PresenceDot presence={m.presence} />
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold">
                      <MemberLink memberId={m.id} name={m.name}>
                        {displayName(m)}
                      </MemberLink>{' '}
                      <span className="font-normal text-muted-foreground">{m.title}</span>
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{[m.ext && `내선 ${m.ext}`, m.duty].filter(Boolean).join(' · ') || ' '}</div>
                  </div>
                </button>
              ))}
            </div>
          </section>
        ))}
      {card && <MemberCard m={card} onClose={() => setCard(null)} />}
    </div>
  )
}

/** My own details (also shown in 설정 → 내 정보). */
export function ProfileTab(): React.JSX.Element {
  const qc = useQueryClient()
  const { data: me } = useMe()
  const { data: depts } = useDepartments()
  const online = useConn((s) => s.state === 'online')
  const hello = useHello()
  const [f, setF] = useState<Record<string, string> | null>(null)
  /** the affiliation chosen or typed here; null: as it is on the server */
  const [dept, setDept] = useState<DeptChoice | null>(null)
  /** a new picker after each save, so what was typed does not stay in it */
  const [round, setRound] = useState(0)
  const [msg, setMsg] = useState('')
  const cur = f ?? { nickname: me?.nickname ?? '', name: me?.name ?? '', title: me?.title ?? '', ext: me?.ext ?? '', mobile: me?.mobile ?? '', duty: me?.duty ?? '', statusMessage: me?.statusMessage ?? '' }
  const set = (k: string, v: string): void => setF({ ...cur, [k]: v })
  const deptFixed = !!me?.adminFields.includes('deptId')
  // a server older than multi-level affiliations takes the department with the other details
  const paths = hello.data?.caps?.includes('deptpath') === true
  const save = useMutation({
    mutationFn: async (): Promise<number> => {
      let created = 0
      const rest = { ...cur, statusMessage: cur.statusMessage || null, nickname: cur.nickname || null }
      if (dept && !deptFixed) {
        if (!paths) {
          await api.patch('/api/me', { ...rest, deptId: 'deptId' in dept ? dept.deptId : null })
          return 0
        }
        created = (await api.put<{ created: number }>('/api/me/dept', dept)).created
      }
      await api.patch('/api/me', rest)
      return created
    },
    onSuccess: (created) => {
      setMsg(created > 0 ? `저장했습니다. 새로 입력한 소속 ${created}개는 최종관리자(서버 PC)가 조직 관리에서 확인합니다.` : '저장했습니다.')
      setDept(null)
      setRound((n) => n + 1)
      void qc.invalidateQueries({ queryKey: ['me'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
    },
    onError: (e) => {
      setMsg(errorMessage(e))
      // the affiliation may have been saved before the rest failed
      void qc.invalidateQueries({ queryKey: ['me'] })
      void qc.invalidateQueries({ queryKey: ['members'] })
    }
  })
  if (!me) return <OfflineState />
  // details the admin (server PC) set are shown but cannot be changed here
  const fixed = (k: string): boolean => me.adminFields.includes(k)
  const fixedHint = (k: string): string | undefined => (fixed(k) ? '서버 PC에서 정한 항목 (바꿀 수 없음)' : undefined)
  const deptError = dept && 'path' in dept ? deptPathError(dept.path) : ''
  return (
    <Card className="max-w-xl" data-testid="profile-card">
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="이름 (본명)" hint={fixedHint('name')}>
            <Input aria-label="내 이름" value={cur.name} disabled={fixed('name')} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="필명 (선택)" hint={`나만 정하고 바꿀 수 있습니다(서버 PC·서무는 못 바꿈). 정하면 "${cur.name || '본명'}(${cur.nickname || '필명'})"으로 표시됩니다.`}>
            <Input aria-label="내 필명" value={cur.nickname} maxLength={20} onChange={(e) => set('nickname', e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Field label="소속" hint={fixedHint('deptId') ?? '여러 단계로 된 조직에서 내가 속한 곳을 고릅니다. 예: 본부 > 과 > 팀'}>
              <DeptPicker key={round} depts={depts ?? []} value={dept ?? { deptId: me.deptId ?? null }} onChange={setDept} disabled={deptFixed} allowTyping={paths} fallbackText={dept ? '' : affiliationText(me)} />
            </Field>
          </div>
          <Field label="직위" hint={fixedHint('title')}>
            <Input aria-label="내 직위" value={cur.title} disabled={fixed('title')} onChange={(e) => set('title', e.target.value)} />
          </Field>
          <Field label="내선번호" hint={fixedHint('ext')}>
            <Input aria-label="내 내선번호" value={cur.ext} disabled={fixed('ext')} onChange={(e) => set('ext', e.target.value)} />
          </Field>
          <Field label="휴대폰 (선택)" hint={fixedHint('mobile')}>
            <Input aria-label="내 휴대폰" value={cur.mobile} disabled={fixed('mobile')} onChange={(e) => set('mobile', e.target.value)} />
          </Field>
          <Field label="상태 메시지">
            <Input aria-label="상태 메시지" value={cur.statusMessage} onChange={(e) => set('statusMessage', e.target.value)} placeholder="예: 회의 중, 외근" />
          </Field>
        </div>
        <Field label="담당 업무" hint={fixedHint('duty')}>
          <Textarea aria-label="담당 업무" value={cur.duty} disabled={fixed('duty')} onChange={(e) => set('duty', e.target.value)} />
        </Field>
        <p className="text-xs text-muted-foreground">휴대폰 번호는 팀원 모두에게 보입니다. 원하지 않으면 비워 두세요.</p>
        {!online && <p className="text-xs text-important">서버 PC에 연결되어 있지 않습니다. 소속 목록은 마지막으로 받은 내용이며, 내 정보는 서버에 연결된 뒤에 저장할 수 있습니다.</p>}
        <div className="flex items-center gap-3">
          <Button onClick={() => save.mutate()} disabled={!online || save.isPending || !!deptError}>
            저장
          </Button>
          {msg && (
            <span className="text-sm text-muted-foreground" data-testid="profile-msg">
              {msg}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

function ContactDialog({ edit, onClose }: { edit?: ContactDto; onClose: () => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const [f, setF] = useState({ org: edit?.org ?? '', name: edit?.name ?? '', title: edit?.title ?? '', phone: edit?.phone ?? '', mobile: edit?.mobile ?? '', email: edit?.email ?? '', memo: edit?.memo ?? '' })
  const [scope, setScope] = useState<ScopeInput>(edit ? { type: edit.scope.type, groupIds: edit.scope.groups.map((g) => g.id), memberIds: edit.scope.members.map((m) => m.id) } : defaultScope(space))
  const [err, setErr] = useState('')
  const save = useMutation({
    mutationFn: () => (edit ? api.patch(`/api/contacts/${edit.id}`, { ...f, scope }) : api.post('/api/contacts', { ...f, scope })),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['contacts'] })
      onClose()
    },
    onError: (e) => setErr(errorMessage(e))
  })
  return (
    <Dialog
      open
      onClose={onClose}
      title={edit ? '연락처 수정' : '연락처 추가'}
      footer={
        <Button onClick={() => save.mutate()} disabled={!f.name.trim()}>
          저장
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          {CONTACT_COLUMNS.filter((c) => c.key !== 'memo').map((c) => (
            <Field key={c.key} label={c.label}>
              <Input aria-label={`연락처 ${c.label}`} value={f[c.key]} onChange={(e) => setF({ ...f, [c.key]: e.target.value })} />
            </Field>
          ))}
        </div>
        <Field label="메모">
          <Textarea aria-label="연락처 메모" value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
        </Field>
        <Field label="공개 범위">
          <ScopePicker value={scope} onChange={setScope} />
        </Field>
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}

function ContactsTab(): React.JSX.Element {
  const qc = useQueryClient()
  const online = useConn((s) => s.state === 'online')
  const space = useSpace((s) => s.space)
  const [q, setQ] = useState('')
  const [dialog, setDialog] = useState<null | { edit?: ContactDto }>(null)
  const [msg, setMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)
  const list = useQuery({ queryKey: ['contacts', q, space], queryFn: () => api.get<ContactDto[]>('/api/contacts', { q, groupId: space === 'team' ? undefined : space }), enabled: online })

  const exportCsv = (): void => {
    const rows = [CONTACT_COLUMNS.map((c) => c.label), ...(list.data ?? []).map((c) => CONTACT_COLUMNS.map((k) => (c[k.key] ?? '') as string))]
    const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = '외부연락처.csv'
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 3000)
  }
  const importCsv = async (file?: File): Promise<void> => {
    if (!file) return
    const rows = csvToContacts(parseCsv(decodeText(new Uint8Array(await file.arrayBuffer()))))
    if (!rows.length) return setMsg('가져올 줄이 없습니다. 첫 줄에 "기관, 이름, 직위, 전화, 휴대폰, 이메일, 메모" 머리글이 있어야 합니다.')
    if (!window.confirm(`${rows.length}명을 가져올까요? 공개 범위는 ${space === 'team' ? '팀 전체' : '지금 고른 그룹'}입니다.`)) return
    try {
      const r = await api.post<{ added: number; errors: string[] }>('/api/contacts/bulk', { rows, scope: defaultScope(space) })
      setMsg(`${r.added}명을 추가했습니다.${r.errors.length ? ` 건너뜀: ${r.errors.slice(0, 3).join(', ')}${r.errors.length > 3 ? ' 등' : ''}` : ''}`)
      void qc.invalidateQueries({ queryKey: ['contacts'] })
    } catch (e) {
      setMsg(errorMessage(e))
    }
    if (fileRef.current) fileRef.current.value = ''
  }
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/contacts/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['contacts'] }) })

  if (!online && !list.data) return <OfflineState />
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="absolute left-2 top-2.5 size-4 text-muted-foreground" />
          <Input aria-label="연락처 검색" className="pl-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="기관·이름·전화번호 검색" />
        </div>
        <Button size="sm" onClick={() => setDialog({})}>
          <Plus /> 연락처 추가
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload /> CSV 가져오기
        </Button>
        <Button size="sm" variant="outline" onClick={exportCsv} disabled={!list.data?.length}>
          <Download /> CSV 내보내기
        </Button>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" aria-label="CSV 파일 선택" onChange={(e) => void importCsv(e.target.files?.[0])} />
      </div>
      {msg && <p className="text-xs text-muted-foreground">{msg}</p>}
      {!list.data?.length ? (
        <EmptyState icon={BookUser} title="외부 연락처가 없습니다" description="유관기관·거래처 연락처를 팀이 함께 씁니다. 엑셀에서 CSV로 저장해 한 번에 가져올 수 있습니다." />
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="px-3 py-2">기관</th>
              <th>이름·직위</th>
              <th>전화</th>
              <th>휴대폰</th>
              <th>이메일</th>
              <th>메모</th>
              <th>공개</th>
              <th className="w-20" />
            </tr>
          </thead>
          <tbody className="selectable divide-y divide-border">
            {list.data.map((c) => (
              <tr key={c.id} data-testid={`contact-${c.name}`}>
                <td className="px-3 py-1.5">{c.org}</td>
                <td>
                  <b>{c.name}</b> <span className="text-muted-foreground">{c.title}</span>
                </td>
                <td>{c.phone && <span className="flex items-center gap-1"><Phone className="size-3" />{c.phone}</span>}</td>
                <td>{c.mobile && <span className="flex items-center gap-1"><Smartphone className="size-3" />{c.mobile}</span>}</td>
                <td className="text-muted-foreground">{c.email}</td>
                <td className="max-w-48 truncate text-xs text-muted-foreground">{c.memo}</td>
                <td>
                  <ScopeTags scope={c.scope} />
                </td>
                <td className="pr-2 text-right">
                  {c.canEdit && (
                    <>
                      <Button size="icon-sm" variant="ghost" aria-label={`${c.name} 수정`} onClick={() => setDialog({ edit: c })}>
                        <Pencil />
                      </Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`${c.name} 삭제`} onClick={() => window.confirm(`${c.name} 연락처를 지울까요?`) && del.mutate(c.id)}>
                        <Trash2 />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {dialog && <ContactDialog edit={dialog.edit} onClose={() => setDialog(null)} />}
    </div>
  )
}

export function DirectoryPage(): React.JSX.Element {
  const [tab, setTab] = useState<'members' | 'contacts' | 'me'>('members')
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="주소록"
        actions={
          <div className="flex gap-1">
            <Button size="sm" variant={tab === 'members' ? 'default' : 'outline'} onClick={() => setTab('members')}>
              <Users /> 팀원·조직도
            </Button>
            <Button size="sm" variant={tab === 'contacts' ? 'default' : 'outline'} onClick={() => setTab('contacts')}>
              <BookUser /> 외부 연락처
            </Button>
            <Button size="sm" variant={tab === 'me' ? 'default' : 'outline'} onClick={() => setTab('me')}>
              <UserCog /> 내 정보
            </Button>
          </div>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto p-5">{tab === 'members' ? <MembersTab /> : tab === 'contacts' ? <ContactsTab /> : <ProfileTab />}</div>
    </div>
  )
}
