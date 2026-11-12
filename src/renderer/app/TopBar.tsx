import { Search } from 'lucide-react'
import type { ReactNode } from 'react'

/**
 * 44px top bar. The right side is reserved for the native window buttons
 * (titleBarOverlay), so content stops ~140px before the edge.
 */
export function TopBar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }): React.JSX.Element {
  return (
    <header className="drag flex h-[44px] shrink-0 items-center gap-3 border-b border-border pl-3 pr-[150px]">
      <div className="no-drag flex items-center gap-2">
        <img src="./icon.png" alt="" className="size-6" />
        <span className="text-sm font-bold tracking-tight">TeamHub</span>
        {left}
      </div>
      <div className="flex flex-1 justify-center">
        {center ?? (
          <div className="no-drag flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-border bg-muted/60 px-2.5 text-sm text-muted-foreground">
            <Search className="size-4" aria-hidden />
            <span>검색 (Ctrl+K)</span>
          </div>
        )}
      </div>
      <div className="no-drag flex items-center gap-1">{right}</div>
    </header>
  )
}
