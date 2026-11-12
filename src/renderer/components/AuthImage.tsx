import { useEffect, useState } from 'react'
import { authHeaders, buildUrl } from '@renderer/lib/api'

/** Image loaded with auth headers (attachments are not public URLs). */
export function AuthImage({ path, alt, className, onClick }: { path: string; alt: string; className?: string; onClick?: () => void }): React.JSX.Element {
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let revoke: string | null = null
    let alive = true
    void fetch(buildUrl(path, { inline: '1' }), { headers: authHeaders() })
      .then(async (r) => {
        if (!r.ok) throw new Error()
        const b = await r.blob()
        if (!alive) return
        revoke = URL.createObjectURL(b)
        setUrl(revoke)
      })
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
      if (revoke) URL.revokeObjectURL(revoke)
    }
  }, [path])
  if (failed) return <span className="text-xs text-muted-foreground">(사진을 불러오지 못했습니다)</span>
  if (!url) return <span className="inline-block h-24 w-32 animate-pulse rounded bg-muted" />
  return <img src={url} alt={alt} className={className} onClick={onClick} />
}
