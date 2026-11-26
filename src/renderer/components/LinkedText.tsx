import { Fragment, useMemo } from 'react'
import { splitLinks } from '@shared/links'
import { invoke } from '@renderer/lib/bridge'
import { cn } from '@renderer/lib/utils'

/**
 * Plain text whose web addresses can be clicked (지시 123): a click opens the address in the PC's
 * web browser, never inside TeamHub.
 */
export function LinkedText({ text, className }: { text: string; className?: string }): React.JSX.Element {
  const parts = useMemo(() => splitLinks(text), [text])
  return (
    <>
      {parts.map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            title={`${p.url}\n누르면 웹 브라우저에서 엽니다`}
            className={cn('cursor-pointer break-all underline underline-offset-2 hover:opacity-80', className)}
            data-testid="message-link"
            onClick={(e) => {
              e.preventDefault()
              e.stopPropagation()
              void invoke('app:openExternal', { url: p.url })
            }}
          >
            {p.text}
          </a>
        ) : (
          <Fragment key={i}>{p.text}</Fragment>
        )
      )}
    </>
  )
}
