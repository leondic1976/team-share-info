import { useEffect, useRef, useState } from 'react'
import { ImagePlus, ShieldCheck, Trash2 } from 'lucide-react'
import { maxStrength, veilFor, WALLPAPER_CATEGORIES, WALLPAPERS, worstContrast, type WallpaperCategory } from '@shared/wallpapers'
import { Card, CardContent, CardHeader, CardTitle } from '@renderer/components/ui/card'
import { Button } from '@renderer/components/ui/button'
import { usePrefs } from '@renderer/app/prefs-store'
import { loadCustomImage, MAX_CUSTOM_WALLPAPERS, resolveWallpaper, useIsDark, useWallpapers } from '@renderer/app/wallpaper-store'
import { cn } from '@renderer/lib/utils'

type Tab = 'all' | WallpaperCategory | 'mine'

/**
 * Settings → 배경화면: 100 built-in designs by category plus the user's own pictures.
 * Strength and blur are the user's; the readability guard caps the strength per wallpaper
 * and theme, and the card shows the resulting text contrast.
 */
export function WallpaperCard(): React.JSX.Element {
  const prefs = usePrefs()
  const { customs, load, add, remove } = useWallpapers()
  const dark = useIsDark()
  const theme = dark ? 'dark' : 'light'
  const [tab, setTab] = useState<Tab>('all')
  const [msg, setMsg] = useState('')
  const [preview, setPreview] = useState<{ id: string; url: string | null } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    if (!prefs.wallpaper.startsWith('custom:')) return
    let alive = true
    const id = prefs.wallpaper
    void loadCustomImage(id.slice(7)).then((url) => alive && setPreview({ id, url }))
    return () => {
      alive = false
    }
  }, [prefs.wallpaper])

  const current = resolveWallpaper(prefs.wallpaper, customs, preview?.id === prefs.wallpaper ? preview.url : null)
  const currentName = prefs.wallpaper.startsWith('custom:')
    ? (customs.find((c) => `custom:${c.id}` === prefs.wallpaper)?.name ?? '')
    : (WALLPAPERS.find((w) => w.id === prefs.wallpaper)?.name ?? '')
  const cap = current ? maxStrength(theme, current.extremes) : 100
  const shown = Math.min(prefs.wallpaperStrength, cap)
  const veil = current ? veilFor(theme, current.extremes, prefs.wallpaperStrength) : 1
  const worst = current ? worstContrast(theme, current.extremes, veil) : null

  const addFiles = async (files: FileList | null): Promise<void> => {
    setMsg('')
    let last = ''
    for (const f of Array.from(files ?? [])) {
      try {
        last = `custom:${(await add(f)).id}`
      } catch (e) {
        setMsg(e instanceof Error ? e.message : String(e))
        break
      }
    }
    if (last) prefs.update({ wallpaper: last })
    if (fileRef.current) fileRef.current.value = ''
  }

  const list = tab === 'all' ? WALLPAPERS : WALLPAPERS.filter((w) => w.category === tab)
  const tabs: { key: Tab; label: string }[] = [{ key: 'all', label: `전체 ${WALLPAPERS.length}` }, ...WALLPAPER_CATEGORIES, { key: 'mine', label: `내 그림${customs.length ? ` ${customs.length}` : ''}` }]

  return (
    <Card data-testid="wallpaper-card">
      <CardHeader>
        <CardTitle>배경화면</CardTitle>
        <span className="text-xs text-muted-foreground" data-testid="wallpaper-current">
          {current ? currentName : '사용 안 함'}
        </span>
        <Button size="sm" variant="outline" className="ml-auto" disabled={!prefs.wallpaper} onClick={() => prefs.update({ wallpaper: '' })}>
          사용 안 함
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1" role="tablist" aria-label="배경화면 분류">
          {tabs.map((t) => (
            <Button key={t.key} size="sm" role="tab" aria-selected={tab === t.key} variant={tab === t.key ? 'default' : 'outline'} onClick={() => setTab(t.key)}>
              {t.label}
            </Button>
          ))}
        </div>

        {tab === 'mine' ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              좋아하는 사진(가족·여행·연예인·캐릭터 등)을 넣어 배경으로 씁니다. 그림은 이 PC에만 저장되고 서버로 보내지 않습니다. 최대 {MAX_CUSTOM_WALLPAPERS}개, 큰 그림은 자동으로 줄입니다.
            </p>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2">
              {customs.map((c) => {
                const id = `custom:${c.id}`
                return (
                  <div key={c.id} className="relative">
                    <button
                      className={cn('block w-full cursor-pointer overflow-hidden rounded-md border-2 text-left', prefs.wallpaper === id ? 'border-primary' : 'border-border hover:border-primary/50')}
                      aria-label={`내 그림 ${c.name}`}
                      aria-pressed={prefs.wallpaper === id}
                      data-testid="wallpaper-custom"
                      onClick={() => prefs.update({ wallpaper: id })}
                    >
                      <div className="h-16" style={{ background: `url("${c.thumb}") center / cover no-repeat` }} />
                      <div className="truncate bg-card px-1.5 py-0.5 text-xs">{c.name}</div>
                    </button>
                    <button className="absolute right-1 top-1 cursor-pointer rounded bg-card/90 p-1 text-urgent hover:bg-card" aria-label={`내 그림 ${c.name} 지우기`} onClick={() => void remove(c.id)}>
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                )
              })}
              <button
                className="flex h-[5.4rem] cursor-pointer flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed border-border text-xs text-muted-foreground hover:border-primary hover:text-primary"
                onClick={() => fileRef.current?.click()}
              >
                <ImagePlus className="size-5" /> 그림 추가
              </button>
            </div>
            <input ref={fileRef} type="file" accept="image/*" multiple hidden aria-label="배경 그림 파일" onChange={(e) => void addFiles(e.target.files)} />
            {msg && <p className="text-xs text-urgent">{msg}</p>}
          </div>
        ) : (
          <div className="grid max-h-72 grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 overflow-y-auto pr-1">
            {list.map((w) => (
              <button
                key={w.id}
                className={cn('cursor-pointer overflow-hidden rounded-md border-2 text-left', prefs.wallpaper === w.id ? 'border-primary' : 'border-border hover:border-primary/50')}
                aria-label={`배경 ${w.name}`}
                aria-pressed={prefs.wallpaper === w.id}
                data-testid="wallpaper-option"
                onClick={() => prefs.update({ wallpaper: w.id })}
              >
                {/* drawn at 3× and scaled down, so a thumbnail shows the pattern as the window will */}
                <div className="h-16 overflow-hidden">
                  <div style={{ width: '300%', height: '300%', transform: 'scale(0.3334)', transformOrigin: '0 0', background: w.css }} />
                </div>
                <div className="truncate bg-card px-1.5 py-0.5 text-xs">{w.name}</div>
              </button>
            ))}
          </div>
        )}

        {current && (
          <div className="space-y-2 border-t border-border pt-3 text-sm">
            <label className="flex items-center gap-3">
              <span className="w-24 shrink-0">배경 진하기</span>
              <input type="range" className="flex-1" aria-label="배경 진하기" min={0} max={cap} value={shown} onChange={(e) => prefs.update({ wallpaperStrength: Number(e.target.value) })} />
              <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground" data-testid="wallpaper-strength">
                {shown}% / 최대 {cap}%
              </span>
            </label>
            {current.custom && (
              <label className="flex items-center gap-3">
                <span className="w-24 shrink-0">흐리게</span>
                <input type="range" className="flex-1" aria-label="배경 흐리게" min={0} max={20} value={prefs.wallpaperBlur} onChange={(e) => prefs.update({ wallpaperBlur: Number(e.target.value) })} />
                <span className="w-28 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{prefs.wallpaperBlur}px</span>
              </label>
            )}
            <div className="relative isolate overflow-hidden rounded-md border border-border" data-testid="wallpaper-preview">
              {current.css && (
                <div aria-hidden className="absolute inset-0 -z-10">
                  <div className="absolute" style={{ inset: current.custom && prefs.wallpaperBlur ? -prefs.wallpaperBlur * 2 : 0, background: current.css, filter: current.custom && prefs.wallpaperBlur ? `blur(${prefs.wallpaperBlur}px)` : undefined }} />
                  <div className="absolute inset-0" style={{ background: 'var(--background)', opacity: veil }} />
                </div>
              )}
              <div className="px-3 py-2">
                <div className="font-semibold">미리 보기 — 본문 글자는 이렇게 보입니다</div>
                <div className="text-xs text-muted-foreground">보조 글자(설명·날짜)는 이렇게 보입니다 · <span className="text-primary">강조색 글자</span></div>
              </div>
            </div>
            {worst && (
              <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="wallpaper-guard">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
                <span>
                  가독성 보호 적용: 이 배경의 가장 어둡고 밝은 곳에서도 글자 대비가 기준 이상이 되도록 진하기를 최대 {cap}%로 제한합니다. 지금 가장 낮은 대비는 {worst.name} <b>{worst.ratio.toFixed(1)}:1</b>입니다(본문 7:1, 보조 글자 4.5:1,
                  강조색 3:1 이상 유지). 밝게/어둡게 테마에 따라 한도가 달라집니다.
                </span>
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
