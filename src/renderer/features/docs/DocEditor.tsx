import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Editor } from '@renderer/components/Editor'
import { ScopePicker, defaultScope, scopeIsValid } from '@renderer/components/ScopePicker'
import { AttachmentInput, type Att } from '@renderer/components/Attachments'
import { Field } from '@renderer/features/setup/SetupFrame'
import { api, errorMessage } from '@renderer/lib/api'
import { useSpace } from '@renderer/app/space-store'
import { DOC_KIND_LABEL, type DocDto, type DocKind, type DocSummaryDto, type TemplateDto } from '@shared/schemas/docs'
import type { ScopeInput } from '@shared/schemas/scope'

export interface DocDraft {
  kind: DocKind
  title?: string
  bodyHtml?: string
  parentId?: string | null
  eventId?: string | null
}

/** Create or edit a knowledge document (6.11). */
export function DocEditor({ draft, edit, onClose, onSaved }: { draft?: DocDraft; edit?: DocDto; onClose: () => void; onSaved: (id: string) => void }): React.JSX.Element {
  const qc = useQueryClient()
  const space = useSpace((s) => s.space)
  const kind = edit?.kind ?? draft!.kind
  const [title, setTitle] = useState(edit?.title ?? draft?.title ?? '')
  const [body, setBody] = useState(edit?.bodyHtml ?? draft?.bodyHtml ?? '')
  const [editorKey, setEditorKey] = useState(0)
  const [tags, setTags] = useState((edit?.tags ?? []).join(', '))
  const [parentId, setParentId] = useState<string | null>(edit?.parentId ?? draft?.parentId ?? null)
  const [scope, setScope] = useState<ScopeInput>(edit ? { type: edit.scope.type, groupIds: edit.scope.groups.map((g) => g.id), memberIds: edit.scope.members.map((m) => m.id) } : defaultScope(space))
  const [atts, setAtts] = useState<Att[]>([])
  const [err, setErr] = useState('')
  const templates = useQuery({ queryKey: ['docs', 'templates'], queryFn: () => api.get<TemplateDto[]>('/api/doc-templates') })
  const manuals = useQuery({ queryKey: ['docs', 'list', 'manual-tree'], queryFn: () => api.get<DocSummaryDto[]>('/api/docs', { kind: 'manual' }), enabled: kind === 'manual' })
  const tagList = tags
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
  const save = useMutation({
    mutationFn: async () => {
      if (edit) {
        await api.patch(`/api/docs/${edit.id}`, { title, bodyHtml: body, tags: tagList, parentId, ...(edit.canDelete ? { scope } : {}) })
        return edit.id
      }
      const r = await api.post<{ id: string }>('/api/docs', { kind, title, bodyHtml: body, tags: tagList, parentId, scope, eventId: draft?.eventId ?? null, attachmentIds: atts.map((a) => a.id) })
      return r.id
    },
    onSuccess: (id) => {
      void qc.invalidateQueries({ queryKey: ['docs'] })
      onSaved(id)
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const applicable = (templates.data ?? []).filter((t) => t.kind === kind || t.kind === 'report')
  return (
    <Dialog
      open
      onClose={onClose}
      title={`${DOC_KIND_LABEL[kind]} ${edit ? '고치기' : '쓰기'}`}
      width="max-w-4xl"
      footer={
        <Button onClick={() => save.mutate()} disabled={!title.trim() || !scopeIsValid(scope) || save.isPending}>
          저장
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-3">
          <div className="flex-1">
            <Field label={kind === 'faq' ? '질문' : '제목'}>
              <Input aria-label="문서 제목" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
            </Field>
          </div>
          {!edit && applicable.length > 0 && (
            <Field label="양식">
              <Select
                aria-label="양식 선택"
                className="w-44"
                value=""
                onChange={(e) => {
                  const t = applicable.find((x) => x.id === e.target.value)
                  if (!t) return
                  if (body && !window.confirm('지금 쓴 내용을 양식으로 바꿀까요?')) return
                  setBody(t.bodyHtml)
                  setEditorKey((k) => k + 1)
                }}
              >
                <option value="">양식 고르기…</option>
                {applicable.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
        </div>
        {kind === 'manual' && (
          <Field label="상위 문서 (목차 위치)">
            <Select aria-label="상위 문서" value={parentId ?? ''} onChange={(e) => setParentId(e.target.value || null)}>
              <option value="">(맨 위)</option>
              {(manuals.data ?? [])
                .filter((m) => m.id !== edit?.id)
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.title}
                  </option>
                ))}
            </Select>
          </Field>
        )}
        <Field label={kind === 'faq' ? '답변' : '내용'}>
          <Editor key={editorKey} value={body} onChange={setBody} minHeight={260} />
        </Field>
        {!edit && <AttachmentInput value={atts} onChange={setAtts} />}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="태그 (쉼표로 구분)">
            <Input aria-label="문서 태그" value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
        {(!edit || edit.canDelete) && (
          <Field label="공개 범위">
            <ScopePicker value={scope} onChange={setScope} initial={edit ? scope : undefined} />
          </Field>
        )}
        {kind === 'mustread' && <p className="text-xs text-muted-foreground">필독 문서는 공개 범위의 모든 사람에게 알림이 가고, 누가 읽었는지 확인할 수 있습니다. 내용을 고치면 다시 읽도록 표시됩니다.</p>}
        {err && <p className="text-sm text-urgent">{err}</p>}
      </div>
    </Dialog>
  )
}
