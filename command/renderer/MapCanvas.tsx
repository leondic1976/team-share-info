/**
 * 지도 표기: a picture (map capture, floor plan, aerial photo) with marks drawn over it in SVG.
 * Coordinates are fractions of the picture (0..1). The same component shows a map (read only),
 * edits a scenario's map (local changes) and edits a running drill's map (each change goes to
 * the server at once and everybody sees it).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, Car, Crosshair, DoorOpen, Droplets, Flag, Flame, Hand, LifeBuoy, MapPin, Minus, Pentagon, Route, TriangleAlert, Type, Trash2, Users, type LucideIcon } from 'lucide-react'
import { MARK_COLORS, MARK_ICONS, MARK_ICON_LABEL, type Mark, type MarkIcon, type MarkKind } from '../shared/types'
import { Button, Input, cn, useAsk } from './ui'
import { useBlobUrl } from './host'

export const ICON: Record<MarkIcon, LucideIcon> = {
  command: Flag,
  vehicle: Car,
  fire: Flame,
  rescue: LifeBuoy,
  water: Droplets,
  entrance: DoorOpen,
  hazard: TriangleAlert,
  evacuation: Route,
  assembly: Users,
  point: MapPin
}

type Tool = 'select' | 'pin' | 'line' | 'arrow' | 'area' | 'text'
const TOOLS: { key: Tool; label: string; icon: LucideIcon }[] = [
  { key: 'select', label: '선택·이동', icon: Hand },
  { key: 'pin', label: '표식', icon: MapPin },
  { key: 'line', label: '선', icon: Minus },
  { key: 'arrow', label: '화살표', icon: ArrowUpRight },
  { key: 'area', label: '구역', icon: Pentagon },
  { key: 'text', label: '글자', icon: Type }
]

export interface MapEditOps {
  add(mark: Mark): void
  move(mark: Mark): void
  remove(key: string): void
}

const DEFAULT_W = 1000
const DEFAULT_H = 700
const newKey = (): string => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function MapCanvas({
  imageId,
  width,
  height,
  marks,
  edit,
  highlight,
  className
}: {
  imageId: string | null
  width: number
  height: number
  /** the marks to draw (current ones) */
  marks: Mark[]
  /** editing: what to do with each change (absent: read only) */
  edit?: MapEditOps
  /** keys of marks to make stand out (just added or moved) */
  highlight?: Set<string>
  className?: string
}): React.JSX.Element {
  const url = useBlobUrl(imageId)
  const { ask, dialog } = useAsk()
  const W = width || DEFAULT_W
  const H = height || DEFAULT_H
  const svg = useRef<SVGSVGElement>(null)
  const [tool, setTool] = useState<Tool>('select')
  const [icon, setIcon] = useState<MarkIcon>('fire')
  const [color, setColor] = useState<string>(MARK_COLORS[0])
  const [label, setLabel] = useState('')
  const [draft, setDraft] = useState<[number, number][]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number; points: [number, number][] } | null>(null)
  const [zoom, setZoom] = useState(1)
  const sel = marks.find((m) => m.key === selected) ?? null

  useEffect(() => {
    if (tool !== 'line' && tool !== 'arrow' && tool !== 'area') setDraft([])
  }, [tool])

  const toFrac = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const clamp = (v: number): number => Math.min(1, Math.max(0, v))
    return [clamp((e.clientX - r.left) / r.width), clamp((e.clientY - r.top) / r.height)]
  }

  const finishDraft = (): void => {
    if (!edit) return
    const min = tool === 'area' ? 3 : 2
    if (draft.length >= min) edit.add({ id: '', key: newKey(), kind: tool as MarkKind, color, label: label.trim(), points: draft })
    setDraft([])
  }

  const onClick = (e: React.MouseEvent): void => {
    if (!edit) return
    const p = toFrac(e)
    if (tool === 'pin') edit.add({ id: '', key: newKey(), kind: 'pin', icon, color, label: label.trim() || MARK_ICON_LABEL[icon], points: [p] })
    else if (tool === 'text') {
      const put = (t: string | null): void => {
        if (t?.trim()) edit.add({ id: '', key: newKey(), kind: 'text', color, label: t.trim().slice(0, 60), points: [p] })
      }
      if (label.trim()) put(label)
      else void ask('지도에 표시할 글자').then(put)
    } else if (tool === 'line' || tool === 'arrow' || tool === 'area') setDraft((d) => [...d, p])
    else setSelected(null)
  }

  useEffect(() => {
    if (!edit) return
    const onKey = (e: KeyboardEvent): void => {
      const typing = (e.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')
      if (typing) return
      if (e.key === 'Enter' && draft.length) finishDraft()
      if (e.key === 'Escape') {
        setDraft([])
        setSelected(null)
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        edit.remove(selected)
        setSelected(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const startDrag = (m: Mark, e: React.PointerEvent): void => {
    e.stopPropagation()
    setSelected(m.key)
    if (!edit || tool !== 'select') return
    const p = toFrac(e)
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    setDrag({ key: m.key, dx: p[0], dy: p[1], points: m.points })
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!drag) return
    const p = toFrac(e)
    const ddx = p[0] - drag.dx
    const ddy = p[1] - drag.dy
    setDrag({ ...drag, points: drag.points.map(([x, y]) => [Math.min(1, Math.max(0, x + ddx)), Math.min(1, Math.max(0, y + ddy))]) as [number, number][], dx: p[0], dy: p[1] })
  }
  const endDrag = (): void => {
    if (!drag || !edit) return setDrag(null)
    const m = marks.find((x) => x.key === drag.key)
    if (m && JSON.stringify(m.points) !== JSON.stringify(drag.points)) edit.move({ ...m, points: drag.points })
    setDrag(null)
  }

  const shown = useMemo(() => marks.map((m) => (drag && m.key === drag.key ? { ...m, points: drag.points } : m)), [marks, drag])
  const px = (p: [number, number]): [number, number] => [p[0] * W, p[1] * H]
  const S = Math.max(W, H) / 1000

  return (
    <div className={cn('flex min-h-0 flex-col gap-2', className)} data-testid="map-canvas">
      {edit && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="map-tools">
          {TOOLS.map((t) => (
            <Button key={t.key} size="sm" variant={tool === t.key ? 'default' : 'outline'} onClick={() => setTool(t.key)} title={t.label} aria-pressed={tool === t.key} data-map-tool={t.key}>
              <t.icon /> {t.label}
            </Button>
          ))}
          {tool === 'pin' && (
            <select className="h-8 rounded-md border border-input bg-background px-1.5 text-xs" value={icon} onChange={(e) => setIcon(e.target.value as MarkIcon)} aria-label="표식 종류">
              {MARK_ICONS.map((i) => (
                <option key={i} value={i}>
                  {MARK_ICON_LABEL[i]}
                </option>
              ))}
            </select>
          )}
          <span className="flex items-center gap-0.5" role="radiogroup" aria-label="색">
            {MARK_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={`색 ${c}`} className={cn('size-5 cursor-pointer rounded-full border-2', color === c ? 'border-foreground' : 'border-transparent')} style={{ background: c }} onClick={() => setColor(c)} />
            ))}
          </span>
          <Input className="h-8 w-40 text-xs" placeholder="이름표(선택)" value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} aria-label="이름표" />
          {draft.length > 0 && (
            <Button size="sm" onClick={finishDraft} data-testid="map-finish">
              그리기 끝 ({draft.length}점)
            </Button>
          )}
          {sel && (
            <Button size="sm" variant="outline" className="text-urgent" onClick={() => (edit.remove(sel.key), setSelected(null))} data-testid="map-delete">
              <Trash2 /> "{sel.label || '표식'}" 지우기
            </Button>
          )}
          <span className="ml-auto flex items-center gap-1">
            <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.max(0.5, z - 0.25))} aria-label="축소">
              −
            </Button>
            <span className="w-10 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
            <Button size="sm" variant="ghost" onClick={() => setZoom((z) => Math.min(3, z + 0.25))} aria-label="확대">
              +
            </Button>
          </span>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border bg-muted/40">
        <svg
          ref={svg}
          viewBox={`0 0 ${W} ${H}`}
          className={cn('block select-none', edit && tool !== 'select' && 'cursor-crosshair')}
          style={{ width: `${zoom * 100}%`, minWidth: zoom * 320 }}
          onClick={onClick}
          onDoubleClick={() => draft.length && finishDraft()}
          onPointerMove={onMove}
          onPointerUp={endDrag}
          role="img"
          aria-label="훈련 대상물 지도"
        >
          {url ? (
            <image href={url} x={0} y={0} width={W} height={H} preserveAspectRatio="xMidYMid meet" />
          ) : (
            <g>
              <rect x={0} y={0} width={W} height={H} fill="var(--color-muted)" />
              {Array.from({ length: 10 }, (_, i) => (
                <line key={i} x1={(i * W) / 10} y1={0} x2={(i * W) / 10} y2={H} stroke="var(--color-border)" strokeWidth={S} />
              ))}
              {Array.from({ length: 7 }, (_, i) => (
                <line key={i} x1={0} y1={(i * H) / 7} x2={W} y2={(i * H) / 7} stroke="var(--color-border)" strokeWidth={S} />
              ))}
              <text x={W / 2} y={H / 2} textAnchor="middle" fill="var(--color-muted-foreground)" fontSize={22 * S}>
                {imageId ? '그림을 불러오는 중…' : '지도·도면 이미지가 없습니다'}
              </text>
            </g>
          )}
          <defs>
            <marker id="cmd-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
            </marker>
          </defs>
          {shown.map((m) => {
            const on = selected === m.key
            const hl = highlight?.has(m.key)
            const pts = m.points.map(px)
            const common = { onPointerDown: (e: React.PointerEvent) => startDrag(m, e), style: { cursor: edit && tool === 'select' ? 'move' : undefined }, 'data-mark': m.key }
            if (m.kind === 'pin') {
              const [x, y] = pts[0]
              const I = ICON[m.icon ?? 'point'] ?? MapPin
              return (
                <g key={m.key} {...common} className={hl ? 'cmd-mark-new' : undefined}>
                  {hl && <circle cx={x} cy={y} r={34 * S} fill="none" stroke={m.color} strokeWidth={3 * S} opacity={0.6} />}
                  <circle cx={x} cy={y} r={18 * S} fill={m.color} stroke={on ? '#111827' : '#fff'} strokeWidth={(on ? 4 : 2.5) * S} />
                  <I x={x - 11 * S} y={y - 11 * S} width={22 * S} height={22 * S} color="#fff" strokeWidth={2.4} />
                  {m.label && (
                    <text x={x} y={y + 34 * S} textAnchor="middle" fontSize={16 * S} fontWeight={700} fill={m.color} stroke="#fff" strokeWidth={4 * S} paintOrder="stroke">
                      {m.label}
                    </text>
                  )}
                </g>
              )
            }
            if (m.kind === 'text') {
              const [x, y] = pts[0]
              return (
                <text key={m.key} {...common} x={x} y={y} textAnchor="middle" fontSize={22 * S} fontWeight={800} fill={m.color} stroke={on ? '#facc15' : '#fff'} strokeWidth={5 * S} paintOrder="stroke">
                  {m.label}
                </text>
              )
            }
            const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ') + (m.kind === 'area' ? ' Z' : '')
            const mid = pts[Math.floor(pts.length / 2)]
            return (
              <g key={m.key} {...common}>
                <path d={d} fill={m.kind === 'area' ? m.color : 'none'} fillOpacity={m.kind === 'area' ? 0.22 : 0} stroke={m.color} strokeWidth={(on ? 7 : 5) * S} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={on ? `${12 * S} ${6 * S}` : undefined} markerEnd={m.kind === 'arrow' ? 'url(#cmd-arrow)' : undefined} />
                {/* a wide invisible line makes thin lines easy to grab */}
                <path d={d} fill="none" stroke="transparent" strokeWidth={20 * S} />
                {m.label && mid && (
                  <text x={mid[0]} y={mid[1] - 10 * S} textAnchor="middle" fontSize={16 * S} fontWeight={700} fill={m.color} stroke="#fff" strokeWidth={4 * S} paintOrder="stroke">
                    {m.label}
                  </text>
                )}
              </g>
            )
          })}
          {draft.length > 0 && (
            <g pointerEvents="none">
              <path d={draft.map(px).map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')} fill="none" stroke={color} strokeWidth={4 * S} strokeDasharray={`${10 * S} ${6 * S}`} />
              {draft.map(px).map(([x, y], i) => (
                <circle key={i} cx={x} cy={y} r={6 * S} fill={color} />
              ))}
            </g>
          )}
        </svg>
      </div>
      {dialog}
      {edit && <p className="text-xs text-muted-foreground">표식·글자는 지도를 눌러 놓습니다. 선·화살표·구역은 점을 차례로 누르고 두 번 누르거나 Enter로 끝냅니다. 선택·이동으로 끌어 옮기고, Delete로 지웁니다.</p>}
    </div>
  )
}

/** A legend of the kinds of marks (for print and the side of the map). */
export function MarkLegend(): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {MARK_ICONS.map((i) => {
        const I = ICON[i]
        return (
          <span key={i} className="inline-flex items-center gap-1">
            <I className="size-3.5" /> {MARK_ICON_LABEL[i]}
          </span>
        )
      })}
      <span className="inline-flex items-center gap-1">
        <Crosshair className="size-3.5" /> 선·구역·글자
      </span>
    </div>
  )
}
