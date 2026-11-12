import type { ReactNode } from 'react'

/** Centered frame for first-run screens (wizard, join, pending). */
export function SetupFrame({ title, subtitle, children, wide }: { title: string; subtitle?: string; children: ReactNode; wide?: boolean }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col overflow-y-auto bg-muted/40">
      <div className="drag h-[44px] shrink-0" />
      <div className="flex flex-1 items-start justify-center px-6 pb-10">
        <div className={wide ? 'w-full max-w-3xl' : 'w-full max-w-xl'}>
          <div className="mb-5 flex items-center gap-3">
            <img src="./icon.png" alt="" className="size-10" />
            <div>
              <h1 className="text-xl font-bold">{title}</h1>
              {subtitle && <p className="text-sm text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-sm font-medium">{label}</div>
      {children}
      {hint && !error && <p className="text-xs text-muted-foreground">{hint}</p>}
      {error && <p className="text-xs text-urgent">{error}</p>}
    </div>
  )
}
