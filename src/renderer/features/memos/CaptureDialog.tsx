import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Download, MessagesSquare, StickyNote } from 'lucide-react'
import { Dialog } from '@renderer/components/Dialog'
import { Button } from '@renderer/components/ui/button'
import { invoke, onMain } from '@renderer/lib/bridge'

/** After a screen capture (Win+Shift+S / 화면 캡처), choose where it goes (6.12 ③). */
export function CaptureDialog(): React.JSX.Element {
  const navigate = useNavigate()
  const [img, setImg] = useState<string | null>(null)
  const [msg, setMsg] = useState('')
  useEffect(
    () =>
      onMain('capture:done', ({ dataUrl }) => {
        setMsg('')
        setImg(dataUrl)
      }),
    []
  )
  const close = (): void => setImg(null)
  return (
    <Dialog
      open={!!img}
      onClose={close}
      title="화면 캡처"
      width="max-w-2xl"
      footer={
        <>
          {msg && <span className="mr-auto self-center text-sm text-primary">{msg}</span>}
          <Button
            variant="outline"
            onClick={() => {
              if (!img) return
              void invoke('local:memos.save', { body: `<p><img src="${img}"></p>`, color: 'gray', tags: ['캡처'] }).then(() => {
                close()
                navigate('/memos')
              })
            }}
          >
            <StickyNote /> 메모로 저장
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              close()
              navigate('/chat')
            }}
          >
            <MessagesSquare /> 메신저에 붙여넣기
          </Button>
          <Button
            onClick={() => {
              if (!img) return
              void invoke('capture:saveFile', { dataUrl: img }).then((r) => {
                if (r.ok) setMsg(`저장했습니다: ${r.path}. 자료실에 끌어다 올릴 수 있습니다.`)
                else if (r.error) setMsg(r.error)
              })
            }}
          >
            <Download /> 파일로 저장
          </Button>
        </>
      }
    >
      {img && <img src={img} alt="캡처한 화면" className="mx-auto max-h-[55vh] rounded border border-border" />}
      <p className="mt-2 text-xs text-muted-foreground">캡처한 그림은 클립보드에도 들어 있어 메신저·문서에서 Ctrl+V로 붙여넣을 수 있습니다.</p>
    </Dialog>
  )
}
