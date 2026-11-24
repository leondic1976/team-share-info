import { NamedIcon } from '@renderer/components/NamedIcon'

/**
 * Icon of a note page. The stored value is a name of the shared line-icon table; pages made
 * by older versions hold an emoji, which is mapped to its icon (never printed). Nothing is
 * drawn for an empty value unless a fallback is given.
 */
export function NoteIcon({ value, fallback, className }: { value: string | null | undefined; fallback?: string; className?: string }): React.JSX.Element | null {
  if (!value && !fallback) return null
  return <NamedIcon name={value} fallback={fallback ?? 'file-text'} className={className ?? 'inline size-4 align-[-0.15em]'} />
}
