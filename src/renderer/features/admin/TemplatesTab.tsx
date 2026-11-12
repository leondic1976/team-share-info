import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { api, errorMessage } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input, Select } from '@renderer/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Editor, RichView } from '@renderer/components/Editor'
import { Field } from '@renderer/features/setup/SetupFrame'
import { DOC_KIND_LABEL, type TemplateDto } from '@shared/schemas/docs'

const KINDS: Record<string, string> = { ...DOC_KIND_LABEL, report: '보고서(모든 종류)' }

/** Admin: document templates offered when writing records (6.11 양식). */
export function TemplatesTab(): React.JSX.Element {
  const qc = useQueryClient()
  const [kind, setKind] = useState('minutes')
  const [name, setName] = useState('')
  const [body, setBody] = useState('')
  const [ver, setVer] = useState(0)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const q = useQuery({ queryKey: ['docs', 'templates'], queryFn: () => api.get<TemplateDto[]>('/api/doc-templates') })
  const add = useMutation({
    mutationFn: () => api.post('/api/doc-templates', { kind, name, bodyHtml: body }),
    onSuccess: () => {
      setName('')
      setBody('')
      setVer((v) => v + 1)
      void qc.invalidateQueries({ queryKey: ['docs', 'templates'] })
    },
    onError: (e) => setErr(errorMessage(e))
  })
  const del = useMutation({ mutationFn: (id: string) => api.del(`/api/doc-templates/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['docs', 'templates'] }) })
  return (
    <div className="max-w-3xl space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>양식 목록</CardTitle>
        </CardHeader>
        <div className="divide-y divide-border">
          {(q.data ?? []).map((t) => (
            <div key={t.id} className="px-4 py-2 text-sm">
              <div className="flex items-center gap-2">
                <button className="cursor-pointer font-semibold hover:underline" onClick={() => setOpen(open === t.id ? null : t.id)}>
                  {t.name}
                </button>
                <span className="text-xs text-muted-foreground">{KINDS[t.kind] ?? t.kind}</span>
                {t.builtin ? (
                  <span className="ml-auto text-xs text-muted-foreground">기본 양식</span>
                ) : (
                  <Button size="icon-sm" variant="ghost" className="ml-auto" aria-label={`${t.name} 삭제`} onClick={() => del.mutate(t.id)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              {open === t.id && <RichView html={t.bodyHtml} className="mt-2 rounded border border-border p-3" />}
            </div>
          ))}
        </div>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>양식 추가</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="양식 이름">
              <Input aria-label="양식 이름" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="쓰일 곳">
              <Select aria-label="양식 종류" value={kind} onChange={(e) => setKind(e.target.value)}>
                {Object.entries(KINDS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Editor key={ver} value={body} onChange={setBody} minHeight={160} />
          <Button onClick={() => add.mutate()} disabled={!name.trim()}>
            <Plus /> 양식 추가
          </Button>
          {err && <p className="text-sm text-urgent">{err}</p>}
        </CardContent>
      </Card>
    </div>
  )
}
