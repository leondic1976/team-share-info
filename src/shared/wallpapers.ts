/**
 * Personal wallpapers (settings → 배경화면): 100 built-in designs drawn with CSS/SVG
 * (no image files), and the readability guard that decides how strongly a wallpaper may show.
 *
 * Readability guard: the wallpaper is always covered by a veil of the theme's background
 * colour. `minVeil` is the smallest veil opacity at which the text colours still reach
 * their contrast targets on the wallpaper's worst-case colour, so a wallpaper can never be
 * shown more strongly than that — whatever the user picks.
 */
import { ICONS } from './icons'

export type WallpaperCategory = 'pretty' | 'men' | 'fun' | 'stage' | 'comic' | 'nature' | 'simple' | 'season'

export const WALLPAPER_CATEGORIES: { key: WallpaperCategory; label: string }[] = [
  { key: 'pretty', label: '예쁜' },
  { key: 'men', label: '남성용' },
  { key: 'fun', label: '재미' },
  { key: 'stage', label: '스타·무대' },
  { key: 'comic', label: '코믹' },
  { key: 'nature', label: '자연' },
  { key: 'simple', label: '심플' },
  { key: 'season', label: '계절·기념일' }
]

export interface Wallpaper {
  id: string
  name: string
  category: WallpaperCategory
  /** value of the CSS `background` property */
  css: string
  /** a picture with colours we cannot list: assume anything from black to white */
  wild?: boolean
}

// ---------- drawing helpers (hex colours only, so the guard can read every colour used) ----------

const lin = (deg: number, ...c: string[]): string => `linear-gradient(${deg}deg, ${c.join(', ')})`
type Spot = [x: number, y: number, color: string, radius: number]
const glow = (bg: string, ...spots: Spot[]): string => [...spots.map(([x, y, c, r]) => `radial-gradient(circle at ${x}% ${y}%, ${c} 0, transparent ${r}%)`), bg].join(', ')
const stripes = (deg: number, a: string, b: string, w: number): string => `repeating-linear-gradient(${deg}deg, ${a} 0 ${w}px, ${b} ${w}px ${w * 2}px)`
const dots = (bg: string, dot: string, r: number, gap: number): string => `radial-gradient(circle, ${dot} ${r}px, transparent ${r + 0.5}px) 0 0 / ${gap}px ${gap}px, ${bg}`
const grid = (bg: string, line: string, gap: number): string =>
  `linear-gradient(${line} 1px, transparent 1px) 0 0 / ${gap}px ${gap}px, linear-gradient(90deg, ${line} 1px, transparent 1px) 0 0 / ${gap}px ${gap}px, ${bg}`
const rays = (a: string, b: string, step: number, at = '50% 50%'): string => `repeating-conic-gradient(from 0deg at ${at}, ${a} 0 ${step}deg, ${b} ${step}deg ${step * 2}deg)`
const svg = (w: number, h: number, body: string): string =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'>${body}</svg>`)}")`
const tile = (w: number, h: number, body: string, bg: string): string => `${svg(w, h, body)} 0 0 / ${w}px ${h}px, ${bg}`
/** full-window picture (hills, waves): stretched to the window */
const scene = (body: string, bg: string): string => `${svg(1600, 900, body).replace("width='1600' height='900'", "preserveAspectRatio='none'")} center / 100% 100% no-repeat, ${bg}`
/** x, y of the top-left corner and size of the four icons of a tile */
const ICON_POS = [
  [14, 14, 34],
  [92, 48, 26],
  [50, 102, 30],
  [120, 130, 22]
] as const
/** scattered line icons (names of the shared icon table), tiled; every colour is a hex the guard can read */
const icons = (bg: string, colors: string[], ...list: string[]): string =>
  tile(
    170,
    170,
    list
      .map((name, i) => {
        const [x, y, size] = ICON_POS[i % 4]!
        return `<g transform='translate(${x} ${y}) scale(${size / 24})' fill='none' stroke='${colors[i % colors.length]}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' opacity='.9'>${ICONS[name] ?? ''}</g>`
      })
      .join(''),
    bg
  )
const word = (text: string, fill: string, stroke: string, bg: string): string =>
  tile(260, 180, `<text x='20' y='80' font-size='54' font-weight='900' font-family='Arial Black, Impact, sans-serif' fill='${fill}' stroke='${stroke}' stroke-width='3' transform='rotate(-10 130 90)'>${text}</text>`, bg)
const hills = (sky: string, ...c: string[]): string =>
  scene(
    c
      .map((col, i) => {
        const y = 520 + i * 110
        return `<path d='M0 ${y} C 300 ${y - 150 + i * 30}, 520 ${y + 60}, 800 ${y - 60} S 1300 ${y - 140 + i * 40}, 1600 ${y - 20} V900 H0 Z' fill='${col}'/>`
      })
      .join(''),
    sky
  )
const waves = (sky: string, ...c: string[]): string =>
  scene(
    c
      .map((col, i) => {
        const y = 560 + i * 90
        return `<path d='M0 ${y} q 100 -50 200 0 t 200 0 t 200 0 t 200 0 t 200 0 t 200 0 t 200 0 t 200 0 V900 H0 Z' fill='${col}'/>`
      })
      .join(''),
    sky
  )
const stars = (bg: string, c: string): string =>
  tile(
    220,
    220,
    [
      [20, 30, 1.6],
      [90, 70, 1],
      [160, 24, 1.3],
      [200, 120, 1.8],
      [60, 150, 1.2],
      [130, 190, 1],
      [30, 205, 1.4],
      [110, 115, 0.9]
    ]
      .map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='${c}'/>`)
      .join(''),
    bg
  )
const hex = (bg: string, line: string): string =>
  tile(56, 97, `<path d='M28 0 L56 16 V48 L28 64 L0 48 V16 Z M28 64 V97 M0 48 L-28 64 M56 48 L84 64' fill='none' stroke='${line}' stroke-width='1.5'/>`, bg)
const camo = (a: string, b: string, c: string, d: string): string =>
  tile(
    240,
    240,
    `<rect width='240' height='240' fill='${a}'/><path d='M20 30 q40 -30 80 0 t40 50 q-30 40 -80 20 t-40 -70z' fill='${b}'/><path d='M150 120 q50 -20 70 30 t-30 70 q-50 10 -60 -40 t20 -60z' fill='${c}'/><path d='M10 160 q30 -20 60 10 t10 50 q-40 20 -60 -10 t-10 -50z' fill='${d}'/><path d='M170 10 q30 0 40 30 t-30 40 q-30 -10 -30 -40 t20 -30z' fill='${d}'/>`,
    a
  )
const confetti = (bg: string, ...c: string[]): string =>
  tile(
    200,
    200,
    [
      [20, 20, 12, 5, 20],
      [120, 40, 5, 12, -30],
      [70, 90, 12, 5, 60],
      [160, 120, 10, 5, 10],
      [30, 150, 5, 12, 40],
      [110, 170, 12, 5, -20],
      [180, 20, 6, 6, 45],
      [80, 30, 6, 6, 0]
    ]
      .map(([x, y, w, h, r], i) => `<rect x='${x}' y='${y}' width='${w}' height='${h}' rx='1.5' fill='${c[i % c.length]}' transform='rotate(${r} ${x} ${y})'/>`)
      .join(''),
    bg
  )
const bokeh = (bg: string, ...c: string[]): string =>
  glow(bg, [12, 22, `${c[0]}aa`, 14], [78, 14, `${c[1 % c.length]}99`, 11], [34, 68, `${c[2 % c.length]}88`, 16], [88, 72, `${c[0]}77`, 13], [58, 38, `${c[1 % c.length]}66`, 9], [20, 90, `${c[2 % c.length]}77`, 10])
/** stage: beams of light from above */
const beams = (bg: string, a: string, b: string): string =>
  `conic-gradient(from 160deg at 25% -10%, transparent 0deg, ${a}66 12deg, transparent 26deg), conic-gradient(from 172deg at 75% -10%, transparent 0deg, ${b}66 12deg, transparent 26deg), conic-gradient(from 166deg at 50% -10%, transparent 0deg, ${a}44 10deg, transparent 22deg), ${bg}`
const halftone = (bg: string, dot: string): string => `radial-gradient(circle, ${dot} 3px, transparent 3.5px) 0 0 / 14px 14px, radial-gradient(circle, ${dot} 3px, transparent 3.5px) 7px 7px / 14px 14px, ${bg}`
const plaid = (bg: string, a: string, b: string): string => `${stripes(0, `${a}55`, 'transparent', 22)}, ${stripes(90, `${b}55`, 'transparent', 22)}, ${bg}`

const W = (id: string, name: string, category: WallpaperCategory, css: string, wild = false): Wallpaper => ({ id, name, category, css, ...(wild ? { wild } : {}) })

export const WALLPAPERS: Wallpaper[] = [
  // ----- 예쁜 (15) -----
  W('pretty-01', '벚꽃 물결', 'pretty', lin(135, '#ffe4ec', '#ffc2d6', '#ffd9e8')),
  W('pretty-02', '라벤더 안개', 'pretty', lin(160, '#ede9fe', '#ddd6fe', '#fbcfe8')),
  W('pretty-03', '복숭아 우유', 'pretty', lin(120, '#fff1e6', '#ffd8be', '#ffe5d9')),
  W('pretty-04', '민트 소다', 'pretty', lin(140, '#e0fbf4', '#b8f2e6', '#d8f3ff')),
  W('pretty-05', '솜사탕', 'pretty', glow(lin(135, '#fde2f3', '#e0f2fe'), [20, 25, '#ffffff', 28], [80, 70, '#fbcfe8', 30])),
  W('pretty-06', '로즈 골드', 'pretty', lin(135, '#f7cac9', '#e8b4a0', '#f9e4d4')),
  W('pretty-07', '하트 뿅뿅', 'pretty', tile(90, 90, `<path d='M45 62 C20 44 24 24 36 24 c6 0 9 5 9 8 c0 -3 3 -8 9 -8 c12 0 16 20 -9 38z' fill='#ff8fab'/>`, '#fff0f5')),
  W('pretty-08', '파스텔 물방울', 'pretty', dots('#fdf2f8', '#f9a8d4', 5, 34)),
  W('pretty-09', '진주빛 새벽', 'pretty', glow('#f8f7ff', [30, 30, '#e0d9ff', 40], [75, 60, '#ffe3f1', 42], [50, 95, '#dff6ff', 36])),
  W('pretty-10', '레몬 셔벗', 'pretty', lin(150, '#fffbe0', '#fff1a8', '#ffe0c2')),
  W('pretty-11', '리본 체크', 'pretty', plaid('#fff5f8', '#f9a8d4', '#fbcfe8')),
  W('pretty-12', '유니콘', 'pretty', lin(110, '#ffd6e8', '#e2d6ff', '#cdeaff', '#d7ffe9')),
  W('pretty-13', '꽃밭', 'pretty', icons('#fff7fb', ['#e85d9a', '#f08a5d', '#e0a800', '#c86bd6'], 'flower-2', 'flower', 'sprout', 'clover')),
  W('pretty-14', '반짝이', 'pretty', stars(lin(135, '#fdebf7', '#ece4ff'), '#f472b6')),
  W('pretty-15', '오로라 핑크', 'pretty', glow('#fff5fb', [15, 80, '#ffc8dd', 45], [85, 20, '#cdb4db', 45], [55, 50, '#bde0fe', 35])),

  // ----- 남성용 (15) -----
  W('men-01', '미드나잇 네이비', 'men', lin(160, '#0b132b', '#1c2541', '#0b132b')),
  W('men-02', '카본 파이버', 'men', `${stripes(45, '#1f2329', '#16191d', 4)}, ${stripes(-45, '#22262c88', '#00000000', 4)}, #16191d`),
  W('men-03', '강철', 'men', lin(180, '#8e9eab', '#cfd9df', '#8e9eab')),
  W('men-04', '블루프린트', 'men', grid('#0f3a66', '#5b9bd588', 28)),
  W('men-05', '육각 메시', 'men', hex('#12161c', '#3a4654')),
  W('men-06', '숲 위장', 'men', camo('#4b5d3a', '#2f3e24', '#6b7a4c', '#1f2a18')),
  W('men-07', '도시 위장', 'men', camo('#6b7280', '#374151', '#9ca3af', '#1f2937')),
  W('men-08', '위스키', 'men', lin(135, '#2b1608', '#6b3a12', '#a8641f')),
  W('men-09', '검은 가죽', 'men', dots('#15120f', '#2a241d', 1, 6)),
  W('men-10', '레이싱 스트라이프', 'men', `${lin(90, '#00000000 44%', '#c1121f 44% 48%', '#f1f1f1 48% 52%', '#c1121f 52% 56%', '#00000000 56%')}, #14171c`),
  W('men-11', '심해', 'men', lin(180, '#0a2540', '#0a3d62', '#051923')),
  W('men-12', '건메탈', 'men', lin(135, '#232526', '#414345', '#232526')),
  W('men-13', '회로 기판', 'men', tile(120, 120, `<path d='M10 20 H60 V60 H100 M60 60 V110 M20 90 H40 V110' fill='none' stroke='#2dd4bf' stroke-width='1.5'/><circle cx='10' cy='20' r='3' fill='#2dd4bf'/><circle cx='100' cy='60' r='3' fill='#2dd4bf'/><circle cx='20' cy='90' r='3' fill='#2dd4bf'/>`, '#06231f')),
  W('men-14', '헤링본 수트', 'men', `${stripes(45, '#3b4252', '#2e3440', 6)} 0 0 / 34px 34px, #2e3440`),
  W('men-15', '화산석', 'men', glow('#161616', [20, 85, '#7f1d1d', 40], [80, 90, '#b45309', 30])),

  // ----- 재미 (12) -----
  W('fun-01', '색종이 파티', 'fun', confetti('#fffdf5', '#ef476f', '#ffd166', '#06d6a0', '#118ab2')),
  W('fun-02', '무지개 줄무늬', 'fun', lin(90, '#ff595e 0 16%', '#ffca3a 16% 33%', '#8ac926 33% 50%', '#1982c4 50% 67%', '#6a4c93 67% 84%', '#ff924c 84%')),
  W('fun-03', '레트로 게임', 'fun', grid('#1a1033', '#ff2e97aa', 32)),
  W('fun-04', '풍선 껌', 'fun', dots('#ffd6f6', '#ff70c8', 9, 48)),
  W('fun-05', '간식 타임', 'fun', icons('#fff4d6', ['#d9480f', '#e8590c', '#c2255c', '#9c36b5'], 'donut', 'pizza', 'popcorn', 'cake-slice')),
  W('fun-06', '게임 한 판', 'fun', icons('#e9e7ff', ['#5f3dc4', '#1c7ed6', '#c2255c', '#2b8a3e'], 'gamepad-2', 'joystick', 'ghost', 'dices')),
  W('fun-07', '멤피스', 'fun', tile(160, 160, `<circle cx='30' cy='30' r='14' fill='#ffbe0b'/><rect x='90' y='20' width='40' height='14' fill='#fb5607' transform='rotate(25 110 27)'/><path d='M20 110 l12 -18 l12 18 l12 -18 l12 18' fill='none' stroke='#3a86ff' stroke-width='4'/><path d='M110 100 l26 0 l-13 24z' fill='#ff006e'/>`, '#fdfcf0')),
  W('fun-08', '우주 여행', 'fun', icons('#141833', ['#ffd43b', '#74c0fc', '#ffa8a8', '#b197fc'], 'rocket', 'orbit', 'star', 'satellite')),
  W('fun-09', '젤리 곰', 'fun', glow('#fff0f3', [15, 20, '#ff8fa3', 16], [70, 15, '#ffd60a', 14], [40, 60, '#80ed99', 17], [85, 65, '#74c0fc', 15], [20, 90, '#c77dff', 13])),
  W('fun-10', '동물 친구들', 'fun', icons('#e8f7ee', ['#8d6e63', '#e8590c', '#343a40', '#2b8a3e'], 'dog', 'cat', 'panda', 'rabbit')),
  W('fun-11', '소용돌이', 'fun', rays('#ffe66d', '#ff6b6b', 15)),
  W('fun-12', '네온 사인', 'fun', glow('#120b26', [25, 30, '#ff2e97', 26], [75, 65, '#00e5ff', 28], [50, 95, '#b5179e', 24])),

  // ----- 스타·무대 (12) -----
  W('stage-01', '스포트라이트', 'stage', beams('#0c0a1d', '#fff3b0', '#ffd6ff')),
  W('stage-02', '콘서트 응원봉', 'stage', bokeh('#0d0b21', '#c77dff', '#48cae4', '#ff8fab')),
  W('stage-03', '레드 카펫', 'stage', lin(180, '#3d0508', '#9b111e', '#5a0a10')),
  W('stage-04', '골드 글리터', 'stage', stars(lin(135, '#3a2a05', '#8a6d1a', '#3a2a05'), '#ffe9a8')),
  W('stage-05', '아이돌 핑크', 'stage', beams('#2a0a24', '#ff5db1', '#ffb3de')),
  W('stage-06', '팬클럽 블루', 'stage', bokeh('#04142e', '#4cc9f0', '#4895ef', '#bde0fe')),
  W('stage-07', '시상식의 밤', 'stage', glow('#0b0b12', [50, 0, '#ffd700', 45], [10, 100, '#3a2a05', 40], [90, 100, '#3a2a05', 40])),
  W('stage-08', '뮤직 스테이지', 'stage', icons('#160f2e', ['#ff6bcb', '#74c0fc', '#ffd43b', '#b197fc'], 'mic', 'headphones', 'music', 'sparkles')),
  W('stage-09', '디스코 볼', 'stage', dots(lin(135, '#1b1035', '#3c1053'), '#e0aaff', 2, 18)),
  W('stage-10', '필름 무비', 'stage', `${stripes(90, '#00000000', '#00000000', 20)}, ${lin(180, '#111111 0 8%', '#00000000 8% 92%', '#111111 92%')}, ${dots('#00000000', '#f5f5f5', 4, 40)}, #26211c`),
  W('stage-11', '오렌지 라이트', 'stage', beams('#1f0d02', '#ff9e00', '#ffd166')),
  W('stage-12', '에메랄드 조명', 'stage', bokeh('#031a14', '#2dd4bf', '#34d399', '#a7f3d0')),

  // ----- 코믹 (12) -----
  W('comic-01', '집중선', 'comic', rays('#fff8dc', '#ffd23f', 6)),
  W('comic-02', '하프톤 옐로', 'comic', halftone('#ffe14d', '#ff9f1c')),
  W('comic-03', 'POW!', 'comic', word('POW!', '#ffdd00', '#111111', '#e63946')),
  W('comic-04', 'ㅋㅋㅋ', 'comic', word('ㅋㅋㅋ', '#ffffff', '#111111', '#3a86ff')),
  W('comic-05', '웃음 폭탄', 'comic', icons('#fff3bf', ['#e8590c', '#c2255c', '#1c7ed6', '#2b8a3e'], 'laugh', 'smile', 'smile-plus', 'annoyed')),
  W('comic-06', '만화 하늘', 'comic', halftone('#8ecae6', '#bfe6f5')),
  W('comic-07', '말풍선', 'comic', tile(180, 150, `<path d='M30 30 h110 a14 14 0 0 1 14 14 v40 a14 14 0 0 1 -14 14 h-60 l-22 22 v-22 h-28 a14 14 0 0 1 -14 -14 v-40 a14 14 0 0 1 14 -14z' fill='#ffffff' stroke='#111111' stroke-width='3'/><text x='52' y='76' font-size='26' font-weight='900' font-family='Arial Black, sans-serif' fill='#111111'>HAHA</text>`, '#ffb703')),
  W('comic-08', '번개 액션', 'comic', rays('#3a0ca3', '#7209b7', 8, '50% 110%')),
  W('comic-09', '팝아트 핑크', 'comic', halftone('#ff5d8f', '#ffd6e0')),
  W('comic-10', '헉!', 'comic', word('헉!', '#111111', '#ffffff', '#80ed99')),
  W('comic-11', '도깨비 친구들', 'comic', icons('#ffe5ec', ['#7048e8', '#e03131', '#495057', '#d6336c'], 'ghost', 'drama', 'skull', 'bug')),
  W('comic-12', '빨강 집중선', 'comic', rays('#fff1f1', '#ef233c', 5, '50% 60%')),

  // ----- 자연 (12) -----
  W('nature-01', '맑은 하늘', 'nature', glow(lin(180, '#74b9ff', '#dff1ff'), [22, 30, '#ffffff', 16], [30, 34, '#ffffff', 12], [72, 22, '#ffffff', 14])),
  W('nature-02', '노을', 'nature', lin(180, '#2d1b4e', '#c9485b', '#ff9a56', '#ffd56b')),
  W('nature-03', '초록 언덕', 'nature', hills(lin(180, '#bfe8ff', '#eaf8ff'), '#8fd694', '#5fb878', '#3d9a5f')),
  W('nature-04', '푸른 바다', 'nature', waves(lin(180, '#c9f0ff', '#8fd3f4'), '#4aa8d8', '#2b84c2', '#17609c')),
  W('nature-05', '오로라', 'nature', glow('#051937', [20, 40, '#00c9a7', 40], [60, 25, '#845ec2', 38], [85, 55, '#00d2fc', 32])),
  W('nature-06', '별이 빛나는 밤', 'nature', stars(lin(180, '#0b1026', '#1b2a52'), '#ffffff')),
  W('nature-07', '사막 모래', 'nature', hills(lin(180, '#ffe8c2', '#ffd29a'), '#eab676', '#d99a55', '#c07f3c')),
  W('nature-08', '안개 낀 숲', 'nature', hills(lin(180, '#dfe9e4', '#c5d6cc'), '#8fae9b', '#5d8572', '#2f5d4a')),
  W('nature-09', '대나무', 'nature', `${stripes(90, '#7cb518', '#5c8d0e', 26)}, #5c8d0e`),
  W('nature-10', '보랏빛 산맥', 'nature', hills(lin(180, '#ffd6c0', '#f7b2bd'), '#b185db', '#7a5ba8', '#4a3572')),
  W('nature-11', '빗방울', 'nature', tile(60, 90, `<path d='M30 12 q10 16 0 22 q-10 -6 0 -22z' fill='#5fa8d3'/><path d='M8 56 q8 13 0 18 q-8 -5 0 -18z' fill='#8ecae6'/>`, '#e3f2fd')),
  W('nature-12', '봄 들판', 'nature', icons('#ecfbe4', ['#2f9e44', '#37b24d', '#f08c00', '#5c940d'], 'leaf', 'clover', 'bird', 'sprout')),

  // ----- 심플 (12) -----
  W('simple-01', '따뜻한 종이', 'simple', '#f6f1e7'),
  W('simple-02', '차분한 회색', 'simple', lin(180, '#eceff3', '#dfe4ea')),
  W('simple-03', '모눈종이', 'simple', grid('#fbfcfe', '#c9d6e6', 24)),
  W('simple-04', '점 노트', 'simple', dots('#fafafa', '#b8c0cc', 1.5, 22)),
  W('simple-05', '옅은 하늘', 'simple', lin(180, '#eef6ff', '#dcecff')),
  W('simple-06', '세이지 그린', 'simple', lin(180, '#e9f0e7', '#d5e2d2')),
  W('simple-07', '모래색', 'simple', lin(180, '#f3ead9', '#e6d8bf')),
  W('simple-08', '가는 줄무늬', 'simple', stripes(90, '#f4f6f9', '#e9edf2', 14)),
  W('simple-09', '먹색', 'simple', lin(180, '#1c1f24', '#111317')),
  W('simple-10', '짙은 남색', 'simple', lin(180, '#101a33', '#0a1124')),
  W('simple-11', '어두운 모눈', 'simple', grid('#12161d', '#2a3340', 24)),
  W('simple-12', '잔물결', 'simple', tile(80, 24, `<path d='M0 12 q10 -8 20 0 t20 0 t20 0 t20 0' fill='none' stroke='#cfd8e3' stroke-width='1.5'/>`, '#f7f9fc')),

  // ----- 계절·기념일 (10) -----
  W('season-01', '봄 벚꽃', 'season', icons('#fff0f6', ['#e64980', '#f06595', '#d6336c', '#f08c00'], 'flower-2', 'cherry', 'flower', 'bug')),
  W('season-02', '여름 바다', 'season', icons('#d6f5ff', ['#1c7ed6', '#1098ad', '#f08c00', '#e03131'], 'tree-palm', 'waves', 'sun', 'umbrella')),
  W('season-03', '가을 단풍', 'season', icons('#fff1df', ['#d9480f', '#e67700', '#8d6e63', '#c92a2a'], 'leaf', 'tree-deciduous', 'nut', 'wheat')),
  W('season-04', '겨울 눈', 'season', stars(lin(180, '#cfe6f7', '#eef7ff'), '#ffffff')),
  W('season-05', '크리스마스', 'season', icons('#0f3d2e', ['#69db7c', '#ff8787', '#ffd43b', '#e7f5ff'], 'tree-pine', 'gift', 'star', 'snowflake')),
  W('season-06', '새해 불꽃', 'season', glow('#070b1f', [25, 30, '#ff4d6d', 18], [70, 25, '#ffd60a', 16], [50, 60, '#4cc9f0', 20], [85, 70, '#c77dff', 14])),
  W('season-07', '설날 색동', 'season', lin(90, '#e63946 0 20%', '#ffd166 20% 40%', '#2a9d8f 40% 60%', '#457b9d 60% 80%', '#f4f1de 80%')),
  W('season-08', '한가위 보름달', 'season', glow('#101a3a', [70, 28, '#fff3c4', 14], [70, 28, '#ffe08a', 26])),
  W('season-09', '생일 축하', 'season', icons('#fff3f8', ['#e64980', '#7048e8', '#f08c00', '#1c7ed6'], 'cake', 'party-popper', 'gift', 'sparkles')),
  W('season-10', '할로윈', 'season', icons('#24123a', ['#ff922b', '#e9ecef', '#b197fc', '#ffd43b'], 'ghost', 'skull', 'candy', 'moon'))
]

// ---------- readability guard ----------

export type Rgb = [number, number, number]

export function parseHex(hex: string): Rgb {
  const h = hex.replace('#', '')
  const f = h.length <= 4 ? h.split('').map((c) => c + c) : (h.match(/../g) ?? [])
  return [parseInt(f[0] ?? '00', 16), parseInt(f[1] ?? '00', 16), parseInt(f[2] ?? '00', 16)]
}

const channel = (v: number): number => {
  const s = v / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
/** WCAG relative luminance */
export const luminance = ([r, g, b]: Rgb): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
/** WCAG contrast ratio (1–21) */
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

/** Every colour a wallpaper can show lies between these two (per channel). */
export interface Extremes {
  darkest: Rgb
  lightest: Rgb
}

export function extremesOf(colors: Rgb[]): Extremes {
  const darkest: Rgb = [255, 255, 255]
  const lightest: Rgb = [0, 0, 0]
  for (const c of colors)
    for (let i = 0; i < 3; i++) {
      darkest[i] = Math.min(darkest[i]!, c[i]!)
      lightest[i] = Math.max(lightest[i]!, c[i]!)
    }
  return colors.length ? { darkest, lightest } : { darkest: [0, 0, 0], lightest: [255, 255, 255] }
}

/** The CSS with its embedded SVG pictures decoded, so their colours can be read. */
export const readableCss = (css: string): string => css.replace(/url\("data:image\/svg\+xml,([^"]*)"\)/g, (_m, body: string) => decodeURIComponent(body))

/** Colours used by a built-in wallpaper, read from its CSS (blends of them stay inside their per-channel range). */
export function wallpaperExtremes(w: Wallpaper): Extremes {
  const found = readableCss(w.css).match(/#[0-9a-fA-F]{3,8}\b/g) ?? []
  const colors = found.filter((h) => !/^#0{8}$/.test(h)).map(parseHex)
  if (w.wild) colors.push([0, 0, 0], [255, 255, 255])
  return extremesOf(colors)
}

/** Text colours while a wallpaper is on (muted text is strengthened, see styles.css) and their contrast targets. */
export const WALLPAPER_TEXT: Record<'light' | 'dark', { background: Rgb; checks: { name: string; color: Rgb; min: number }[] }> = {
  light: {
    background: parseHex('#ffffff'),
    checks: [
      { name: '본문', color: parseHex('#0f172a'), min: 7 },
      { name: '보조 글자', color: parseHex('#475569'), min: 4.5 },
      { name: '강조색', color: parseHex('#2563eb'), min: 3 }
    ]
  },
  dark: {
    background: parseHex('#0f172a'),
    checks: [
      { name: '본문', color: parseHex('#e2e8f0'), min: 7 },
      { name: '보조 글자', color: parseHex('#cbd5e1'), min: 4.5 },
      { name: '강조색', color: parseHex('#3b82f6'), min: 3 }
    ]
  }
}

const mix = (veil: Rgb, under: Rgb, a: number): Rgb => [0, 1, 2].map((i) => veil[i]! * a + under[i]! * (1 - a)) as Rgb

/** Lowest contrast of the text colours on the veiled wallpaper, over its worst-case colours. */
export function worstContrast(theme: 'light' | 'dark', ex: Extremes, veil: number): { ratio: number; name: string; ok: boolean } {
  const t = WALLPAPER_TEXT[theme]
  let worst = { ratio: Infinity, name: '', ok: true }
  for (const under of [ex.darkest, ex.lightest]) {
    const bg = mix(t.background, under, veil)
    for (const c of t.checks) {
      const ratio = contrast(c.color, bg)
      const ok = ratio >= c.min
      // the check closest to (or furthest below) its own target decides
      if (ratio / c.min < worst.ratio / (t.checks.find((x) => x.name === worst.name)?.min ?? 1)) worst = { ratio, name: c.name, ok }
      if (!ok) worst.ok = false
    }
  }
  return worst
}

/** Smallest veil opacity (0–1, steps of 1%) at which every text colour meets its target. */
export function minVeil(theme: 'light' | 'dark', ex: Extremes): number {
  const t = WALLPAPER_TEXT[theme]
  const passes = (a: number): boolean => [ex.darkest, ex.lightest].every((under) => t.checks.every((c) => contrast(c.color, mix(t.background, under, a)) >= c.min))
  for (let p = 0; p <= 100; p++) if (passes(p / 100)) return p / 100
  return 1
}

export const WALLPAPER_STRENGTH_DEFAULT = 60
/** How much of the wallpaper may show at most (0–100), however strong the user sets it. */
export const maxStrength = (theme: 'light' | 'dark', ex: Extremes): number => Math.round((1 - minVeil(theme, ex)) * 100)
/** Veil opacity actually used for a requested strength (0–100): never below the guard. */
export const veilFor = (theme: 'light' | 'dark', ex: Extremes, strength: number): number => Math.max(minVeil(theme, ex), 1 - Math.min(100, Math.max(0, strength)) / 100)
