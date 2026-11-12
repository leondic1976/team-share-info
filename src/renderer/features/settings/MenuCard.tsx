import { ChevronDown, ChevronUp, Eye, EyeOff, RotateCcw } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { MENU } from '@renderer/app/menu'
import { usePrefs } from '@renderer/app/prefs-store'
import { cn } from '@renderer/lib/utils'

/** Settings: hide menus and change their order (this PC only, 5.2 메뉴 편집). */
export function MenuCard(): React.JSX.Element {
  const { menuOrder, hiddenMenus, update } = usePrefs()
  const order = [...MENU].sort((a, b) => {
    const ia = menuOrder.indexOf(a.key)
    const ib = menuOrder.indexOf(b.key)
    return (ia === -1 ? 999 + MENU.indexOf(a) : ia) - (ib === -1 ? 999 + MENU.indexOf(b) : ib)
  })
  const move = (i: number, d: -1 | 1): void => {
    const keys = order.map((m) => m.key)
    const j = i + d
    if (j < 0 || j >= keys.length) return
    ;[keys[i], keys[j]] = [keys[j], keys[i]]
    update({ menuOrder: keys })
  }
  const toggle = (k: string): void => update({ hiddenMenus: hiddenMenus.includes(k) ? hiddenMenus.filter((x) => x !== k) : [...hiddenMenus, k] })
  return (
    <Card data-testid="menu-card">
      <CardHeader>
        <CardTitle>메뉴 편집</CardTitle>
        <Button size="sm" variant="ghost" onClick={() => update({ menuOrder: [], hiddenMenus: [] })}>
          <RotateCcw /> 처음대로
        </Button>
      </CardHeader>
      <CardContent className="space-y-0.5">
        <p className="mb-2 text-xs text-muted-foreground">쓰지 않는 메뉴는 숨기고 자주 쓰는 메뉴를 위로 올리세요. 이 PC에만 적용됩니다. 관리자가 꺼 둔 기능은 여기서 켤 수 없습니다.</p>
        {order.map((m, i) => (
          <div key={m.key} className="flex items-center gap-2 text-sm" data-testid="menu-row">
            <m.icon className="size-4 text-muted-foreground" />
            <span className={cn('flex-1', hiddenMenus.includes(m.key) && 'text-muted-foreground line-through')}>{m.label}</span>
            <Button size="icon-sm" variant="ghost" aria-label={`${m.label} 위로`} disabled={i === 0} onClick={() => move(i, -1)}>
              <ChevronUp />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`${m.label} 아래로`} disabled={i === order.length - 1} onClick={() => move(i, 1)}>
              <ChevronDown />
            </Button>
            <Button size="icon-sm" variant="ghost" aria-label={`${m.label} ${hiddenMenus.includes(m.key) ? '보이기' : '숨기기'}`} disabled={m.key === 'home'} onClick={() => toggle(m.key)}>
              {hiddenMenus.includes(m.key) ? <Eye /> : <EyeOff />}
            </Button>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
