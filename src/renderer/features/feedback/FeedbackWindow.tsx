import { useEffect, useState } from 'react'
import { Bug, ExternalLink, Lightbulb, Loader2, Send, ShieldCheck } from 'lucide-react'
import type { FeedbackInfo } from '@shared/ipc'
import { invoke } from '@renderer/lib/bridge'
import { Button } from '@renderer/components/ui/button'
import { Input, Textarea } from '@renderer/components/ui/input'
import { Switch } from '@renderer/components/ui/switch'
import { cn } from '@renderer/lib/utils'

const KINDS = [
  { value: 'feature', label: '기능요청', icon: Lightbulb, hint: '있으면 좋겠다고 생각한 기능, 불편한 점' },
  { value: 'bug', label: '오류신고', icon: Bug, hint: '안 되는 것, 이상하게 동작하는 것' }
] as const

const day = (t: number): string => new Date(t).toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })

/** Window of its own (settings → 기능요청 및 오류신고): write a post for the public board. */
export function FeedbackWindow(): React.JSX.Element {
  const [info, setInfo] = useState<FeedbackInfo | null>(null)
  const [kind, setKind] = useState<'feature' | 'bug'>('feature')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [author, setAuthor] = useState('')
  const [includeEnv, setIncludeEnv] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const load = (): void => void invoke('feedback:info').then(setInfo)
  useEffect(load, [])
  useEffect(() => {
    document.title = '기능요청 및 오류신고'
  }, [])

  const lim = info?.limits
  const problem = !lim
    ? ''
    : title.trim().length < lim.titleMin
      ? '제목을 입력하세요.'
      : body.trim().length < lim.bodyMin
        ? `내용을 ${lim.bodyMin}자 이상 입력하세요.`
        : ''

  const send = async (): Promise<void> => {
    if (problem) return setMsg({ ok: false, text: problem })
    setBusy(true)
    setMsg(null)
    try {
      const r = await invoke('feedback:submit', { kind, title: title.trim(), body: body.trim(), author: author.trim(), includeEnv })
      if (r.ok) {
        setMsg({ ok: true, text: `등록했습니다. 접수번호 ${r.id} (게시판 ${r.number}번). 게시판에는 몇 분 뒤에 보입니다.` })
        setTitle('')
        setBody('')
        load()
      } else setMsg({ ok: false, text: r.error ?? '보내지 못했습니다.' })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const openBoard = (n?: number): void => void invoke('app:openExternal', { url: `${info?.boardUrl ?? ''}${n ? `#${n}` : ''}` })

  return (
    <div className="flex h-screen flex-col bg-background text-foreground" data-testid="feedback-window">
      <div className="border-b border-border px-5 py-3">
        <h1 className="text-base font-semibold">기능요청 및 오류신고</h1>
        <p className="text-xs text-muted-foreground">개발자에게 바로 전달되고, 다운로드 사이트의 게시판에서 처리 상황을 볼 수 있습니다.</p>
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-5 py-4">
        <div className="rounded-md bg-important/10 px-3 py-2 text-xs text-important" role="note">
          올린 글은 <b>누구나 볼 수 있는 공개 게시판</b>에 실립니다. 이름·연락처 같은 개인정보, 기관 내부 정보, 보안 내용은 쓰지 마세요.
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
            <li>PC 이름, Windows 계정, 기관·팀 이름, IP 주소는 보내지 않습니다.</li>
            <li>보안 연결(HTTPS)로만 보내고, 보낼 때마다 새로 발급받은 임시 키를 쓴 뒤 바로 폐기합니다.</li>
          </ul>
        </div>

        {info && !info.configured && (
          <p className="rounded-md bg-urgent/10 px-3 py-2 text-xs text-urgent" role="alert">
            이 설치본에는 보내기 기능이 들어 있지 않습니다. 프로그램을 최신 버전으로 업데이트한 뒤 다시 열어 주세요.
          </p>
        )}

        {info && info.sent.length > 0 && (
          <div>
            <div className="mb-1 text-sm font-medium">이 PC에서 보낸 글</div>
            <ul className="divide-y divide-border rounded-md border border-border text-xs">
              {info.sent.map((s) => (
                <li key={s.id} className="flex items-center gap-2 px-3 py-1.5" data-testid="feedback-sent">
                  <span className={cn('shrink-0 rounded px-1.5 py-0.5', s.kind === 'bug' ? 'bg-urgent/10 text-urgent' : 'bg-primary/10 text-primary')}>{s.kind === 'bug' ? '오류신고' : '기능요청'}</span>
                  <button type="button" className="min-w-0 flex-1 cursor-pointer truncate text-left hover:underline" onClick={() => openBoard(s.number)}>
                    {s.title}
                  </button>
                  <span className="selectable shrink-0 font-mono text-muted-foreground">{s.id}</span>
                  <span className="shrink-0 text-muted-foreground">{day(s.at)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-5 py-3">
        <Button onClick={() => void send()} disabled={busy || !info?.configured}>
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
