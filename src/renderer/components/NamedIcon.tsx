import { DEFAULT_ICON, ICONS, resolveIconName } from '@shared/icons'
import { cn } from '@renderer/lib/utils'

interface NamedIconProps {
  /** an icon name of the shared whitelist (extension "iconName", note or ledger icon); anything else shows the fallback */
  name: string | null | undefined
  fallback?: string
  className?: string
  /** says what the icon means; without it the icon is decorative */
  label?: string
}

/**
 * Line icon chosen by name from the shared whitelist (`src/shared/icons.json`, lucide paths).
 * Emoji are never rendered: an unknown value (an older or third-party manifest with only an
 * emoji `icon`) falls back to the default icon.
 */
export function NamedIcon({ name, fallback = DEFAULT_ICON, className, label }: NamedIconProps): React.JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn('size-4 shrink-0', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      // static markup from the program's own table, never user input
      dangerouslySetInnerHTML={{ __html: ICONS[resolveIconName(name, fallback)]! }}
    />
  )
}

/** Icon of an extension: its manifest's `iconName`; the emoji `icon` of older manifests is not shown. */
export function PluginIcon({ manifest, className }: { manifest: { iconName?: string }; className?: string }): React.JSX.Element {
  return <NamedIcon name={manifest.iconName} className={className} />
}
