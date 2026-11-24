import { useCallback, useEffect, useRef, useState } from 'react'
import { Bug, ExternalLink, Lightbulb, Loader2, Send, ShieldCheck } from 'lucide-react'
import type { FeedbackInfo } from '@shared/ipc'
import { checkItem, tidyLine, tidyText, type FeedbackItemDto, type FeedbackItemState } from '@shared/schemas/feedback'
import { useConn } from '@renderer/app/conn-store'
import { ApiError, request } from '@renderer/lib/api'
import { invoke } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'
import { confirmPii } from '@renderer/lib/pii'

const KINDS = [
  { value: 'feature', label: '기능요청', icon: Lightbulb, hint: '있으면 좋겠다고 생각한 기능, 불편한 점' },
  { value: 'bug', label: '오류신고', icon: Bug, hint: '안 되는 것, 이상하게 동작하는 것' }
] as const

const STATE: Record<FeedbackItemState, string> = { received: '접수됨', bundled: '이번 주 묶음에 포함', uploaded: '개발자에게 전달됨' }

const day = (t: number): string => new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })

/**
 * Window of its own (settings → 기능요청 및 오류신고): write a post. It is handed to the server PC
 * of the team, which hands the posts of a week to the developer. The only thing this PC needs
 * is its connection to the server PC.
 *
 * The offline outbox is not used here: it belongs to the main window (its list, its sending
 * on reconnect), and this window does not follow the connection. A post that cannot be handed
 * over stays in the form and is sent again with the same id, so it is never kept twice.
 */
export function FeedbackWindow(): React.JSX.Element {
  const loadConn = useConn((s) => s.load)
  const [joined, setJoined] = useState<boolean | null>(null)
  const [info, setInfo] = useState<FeedbackInfo | null>(null)
  const [mine, setMine] = useState<FeedbackItemDto[]>([])
  const [kind, setKind] = useState<'feature' | 'bug'>('feature')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [author, setAuthor] = useState('')
  const [includeEnv, setIncludeEnv] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  /** a post whose hand-over got no answer: the same text is sent again under the same id */
  const pending = useRef<{ key: string; submissionId: string; createdAt: string } | null>(null)

  const loadMine = useCallback((): void => {
    void request<FeedbackItemDto[]>('/api/feedback/mine')
      .then(setMine)
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    document.title = '기능요청 및 오류신고'
    void invoke('feedback:info').then(setInfo)
    void invoke('conn:get').then((c) => {
      loadConn(c)
      setJoined(!!c.deviceId && !!c.serverUrl)
      if (c.deviceId && c.serverUrl) loadMine()
    })
  }, [loadConn, loadMine])

  const lim = info?.limits
  const problem = !lim
    ? ''
    : title.trim().length < lim.titleMin
      ? '제목을 입력하세요.'
      : body.trim().length < lim.bodyMin
        ? `내용을 ${lim.bodyMin}자 이상 입력하세요.`
        : ''

  const send = async (): Promise<void> => {
    if (!info || !lim || !joined) return
    if (problem) return setMsg({ ok: false, text: problem })
    if (!confirmPii([title, body, author], '서버 PC를 거쳐 개발자에게 전달되고 누구나 볼 수 있는 공개 게시판에 실리며,')) return
    const key = JSON.stringify([kind, title, body, author, includeEnv])
    if (pending.current?.key !== key) pending.current = { key, submissionId: crypto.randomUUID(), createdAt: new Date().toISOString() }
    // the one document that leaves this PC: exactly these fields
    const item = {
      kind,
      title: tidyLine(title, lim.titleMax),
      body: tidyText(body, lim.bodyMax),
      author: tidyLine(author, lim.authorMax),
      installId: info.installId,
      submissionId: pending.current.submissionId,
      createdAt: pending.current.createdAt
    }
    let made = checkItem(includeEnv ? { ...item, app: info.app } : item)
    // a version the format does not know (a development build): the post goes without it
    if (!made.ok && includeEnv) made = checkItem(item)
    if (!made.ok) return setMsg({ ok: false, text: '제목이나 내용에 보낼 수 없는 글자가 있거나 길이가 맞지 않습니다. 고친 뒤 다시 보내 주세요.' })
    setBusy(true)
    setMsg(null)
    try {
      const r = await request<FeedbackItemDto>('/api/feedback', { method: 'POST', body: made.value })
      pending.current = null
      setMsg({ ok: true, text: `서버 PC에 접수했습니다. 접수번호 ${r.receipt}. 서버 PC가 주 1회 모아 개발자에게 보냅니다.` })
      setTitle('')
      setBody('')
      loadMine()
    } catch (e) {
      const text =
        e instanceof ApiError && (e.code === 'NETWORK' || e.code === 'NO_SERVER')
          ? '서버 PC에 연결할 수 없습니다. 서버 PC에 연결된 뒤 보내세요. 쓴 내용은 이 창에 그대로 있습니다.'
          : e instanceof ApiError && e.status === 404
            ? '서버 PC의 프로그램이 이전 버전이라 접수하지 못했습니다. 서버 PC를 업데이트한 뒤 보내 주세요.'
            : e instanceof Error
              ? e.message
              : String(e)
      setMsg({ ok: false, text })
    } finally {
      setBusy(false)
    }
  }

  const openBoard = (receipt?: string): void => void invoke('app:openExternal', { url: `${info?.boardUrl ?? ''}${receipt ? `#${receipt}` : ''}` })
  const cannot = joined === false ? '팀의 서버 PC에 연결(사용 승인)된 뒤에 보낼 수 있습니다.' : ''

  return (
    <div className="flex h-screen flex-col bg-background text-foreground" data-testid="feedback-window">
      <div className="border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">기능요청 및 오류신고</h1>
        <p className="text-xs text-muted-foreground">서버 PC에 접수되고, 서버 PC가 주 1회 모아 개발자에게 보냅니다. 처리 상황은 다운로드 사이트의 게시판에서 볼 수 있습니다.</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="rounded-md bg-important/10 px-3 py-2 text-xs text-important" role="note">
          올린 글은 개발자에게 전달된 뒤 <b>누구나 볼 수 있는 공개 게시판</b>에 실립니다. 이름·연락처 같은 개인정보, 기관 내부 정보, 보안 내용은 쓰지 마세요.
        </div>

        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="분류">
          {KINDS.map((k) => (
            <button
              key={k.value}
              type="button"
              role="radio"
              aria-checked={kind === k.value}
              onClick={() => setKind(k.value)}
              className={cn('cursor-pointer rounded-md border px-3 py-2 text-left', kind === k.value ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted')}
            >
              <div className="flex items-center gap-1.5 text-sm font-semibold">
                <k.icon className="size-4" /> {k.label}
              </div>
              <div className="text-xs text-muted-foreground">{k.hint}</div>
            </button>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium">제목</span>
          <Input aria-label="제목" value={title} maxLength={lim?.titleMax} onChange={(e) => setTitle(e.target.value)} placeholder={kind === 'bug' ? '예: 자료실에서 큰 파일을 올리면 멈춥니다' : '예: 일정에 색을 지정하고 싶습니다'} autoFocus />
        </label>

        <label className="block space-y-1">
          <span className="flex items-baseline text-sm font-medium">
            내용
            <span className="ml-auto text-xs font-normal text-muted-foreground">
              {body.length} / {lim?.bodyMax ?? 5000}
            </span>
          </span>
          <Textarea
            aria-label="내용"
            className="h-44 resize-none"
            value={body}
            maxLength={lim?.bodyMax}
            onChange={(e) => setBody(e.target.value)}
            placeholder={kind === 'bug' ? '무엇을 하다가, 어떤 화면에서, 어떻게 되었는지 순서대로 적어 주세요.' : '어떤 일을 할 때 필요한지, 어떻게 되면 좋을지 적어 주세요.'}
          />
        </label>

        <div className="grid grid-cols-[1fr_auto] items-end gap-4">
          <label className="block space-y-1">
            <span className="text-sm font-medium">작성자 표시 (선택)</span>
            <Input aria-label="작성자 표시" value={author} maxLength={lim?.authorMax} onChange={(e) => setAuthor(e.target.value)} placeholder="비우면 익명" />
          </label>
          <label className="flex items-center gap-2 pb-1.5 text-sm">
            <Switch checked={includeEnv} onCheckedChange={setIncludeEnv} label="버전 정보 함께 보내기" />
            버전 정보 함께 보내기
          </label>
        </div>

        <div className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground">
          <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck className="size-3.5 text-success" /> 함께 보내는 것
          </div>
          <ul className="list-disc space-y-0.5 pl-4">
            <li>
              이 PC의 고유값 <code className="selectable font-mono text-foreground" data-testid="feedback-install-id">{info?.installId ?? '…'}</code> — 설치할 때 한 번 만들어 둔 값입니다. IP·MAC 주소를 섞어 만들지만 주소 자체는 들어 있지 않고 되돌려 알아낼 수도 없습니다.
            </li>
            {includeEnv && <li>{info?.environment}</li>}
            <li>PC 이름, Windows 계정, 기관·팀 이름, IP 주소는 보내지 않습니다. 개발자에게 가는 묶음에는 누가 썼는지(구성원 정보)도 들어가지 않습니다.</li>
            <li>이 PC는 인터넷에 연결되어 있지 않아도 됩니다. 글은 팀의 서버 PC에 보관되고, 서버 PC의 관리자가 받은 글을 볼 수 있습니다.</li>
          </ul>
        </div>

        {cannot && (
          <p className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground" role="note" data-testid="feedback-not-joined">
            {cannot} 게시판은 지금도 [게시판 보기]로 볼 수 있습니다.
          </p>
        )}

        {mine.length > 0 && (
          <div>
            <div className="mb-1 text-sm font-medium">내가 보낸 글</div>
            <ul className="divide-y divide-border rounded-md border border-border text-xs">
              {mine.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="feedback-sent">
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5', s.kind === 'bug' ? 'bg-urgent/10 text-urgent' : 'bg-primary/10 text-primary')}>{s.kind === 'bug' ? '오류신고' : '기능요청'}</span>
                  <span className="min-w-0 flex-1 truncate">{s.title}</span>
                  <span className="selectable shrink-0 font-mono text-muted-foreground">{s.receipt}</span>
                  <span className="shrink-0 text-muted-foreground">{day(s.receivedAt)}</span>
                  {s.state === 'uploaded' ? (
                    <button type="button" className="shrink-0 cursor-pointer text-primary hover:underline" onClick={() => openBoard(s.receipt)} title="공개 게시판에서 이 글 찾기">
                      {STATE[s.state]}
                    </button>
                  ) : (
                    <span className="shrink-0 text-muted-foreground">{STATE[s.state]}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-5 py-3">
        <Button onClick={() => void send()} disabled={busy || !info || !joined} title={cannot || undefined}>
          {busy ? <Loader2 className="animate-spin" /> : <Send />} 보내기
        </Button>
        <Button variant="outline" onClick={() => openBoard()}>
          <ExternalLink /> 게시판 보기
        </Button>
        {msg && (
          <span className={cn('min-w-0 flex-1 text-xs', msg.ok ? 'text-success' : 'text-urgent')} role="status">
            {msg.text}
          </span>
        )}
      </div>
    </div>
  )
}
