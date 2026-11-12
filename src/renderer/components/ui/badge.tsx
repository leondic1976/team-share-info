import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@renderer/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[0.75rem] font-medium leading-none',
  {
    variants: {
      variant: {
        default: 'bg-primary/10 text-primary',
        urgent: 'bg-urgent text-white',
        important: 'bg-important/15 text-important',
        muted: 'bg-muted text-muted-foreground',
        success: 'bg-success/15 text-success',
        personal: 'bg-personal/15 text-personal'
      }
    },
    defaultVariants: { variant: 'default' }
  }
)

export function Badge({
  className,
  variant,
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>): React.JSX.Element {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}
