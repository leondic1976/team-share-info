# TeamHub 확장 기능 만들기

확장 기능은 `plugins/<id>/` 폴더 하나입니다. `main`에 올리면 GitHub Actions(`site.yml`)가
`.thplugin` 파일과 `plugins/catalog.json`을 만들어 다운로드 사이트의 확장 기능 페이지에 카드로 올립니다.
설치는 TeamHub 프로그램 안에서만 합니다.

```
plugins/<id>/
  manifest.json   이름·버전·권한
  index.html      시작 화면 (manifest.entry)
  *.js *.css …    html, js, css, json, 이미지, 글꼴, 소리만 허용
```

## manifest.json
```json
{
  "id": "ladder",
  "name": "사다리타기",
  "version": "1.0.0",             // 바꾸면 설치한 PC에 '업데이트'가 표시됨
  "description": "…",
  "author": "TeamHub",
  "icon": "🪜",                   // 이모지
  "entry": "index.html",
  "permissions": ["members", "storage", "rooms", "notify", "clipboard", "files", "ocr", "copilot"],
  "minAppVersion": "0.1.0",
  "updated": "2026-11-24",        // 내용을 바꾼 날. 확장 기능 모음의 '최신순'에 씀(버전을 올릴 때 함께 고침)
  "features": ["사이트 카드에 보일 기능 소개"]
}
```
`updated`와 `features`는 목록(`catalog.json`)에만 들어가고 설치되는 묶음에는 들어가지 않습니다.
다운로드 수는 외부 집계(`abacus.jasoncameron.dev`, 키 `teamhub-lan-app/plugin-<id>`)에 사이트의 **파일 받기**와
앱의 확장 기능 모음 설치가 더해집니다. 따로 등록할 것은 없습니다.

## 실행 환경
- 격리된 iframe(`sandbox="allow-scripts allow-forms allow-modals"`), 주소 `teamhub-plugin://<id>/`.
- CSP: 외부 연결 금지(`connect-src 'none'`), 자기 파일만 불러옴. 외부 CDN·글꼴을 쓰지 말고 파일을 함께 넣으세요.
- `<script src="__sdk.js"></script>`를 넣으면 `window.TeamHub`를 씁니다.
- `TeamHub.theme`(`light`/`dark`), `TeamHub.room`(초대 알림으로 열렸을 때의 방 ID).

## API (`await TeamHub.call(이름, 값)`)
| 이름 | 권한 | 설명 |
|---|---|---|
| `me` | — | `{ id, name, deptName, isAdmin }` |
| `time` | — | `{ now }` 서버 PC의 시계(ms). 마감 시각처럼 모든 PC에서 같아야 하는 판단에 씀 |
| `holidays` | — | `{ from, to }`(YYYY-MM-DD) 사이의 공휴일 `[{ date, name }]` (관리 → 공휴일의 목록) |
| `members` | members | 활동 중인 팀원 `[{ id, name, deptName, title, presence }]` |
| `storage.get` / `storage.set` / `storage.keys` | storage | 이 PC에만 저장(`{ key }`, `{ key, value }`), 값 512KB까지 |
| `rooms.list` / `rooms.get` | rooms | 내가 볼 수 있는 이 확장 기능의 방 |
| `rooms.create` | rooms | `{ title, scope, shared }` — scope는 `{ type: 'team'|'group'|'members', groupIds, memberIds }`. 지정한 사람에게 초대 알림 |
| `rooms.setShared` | rooms | 방을 만든 사람만: `{ roomId, shared, version?, close? }` (version이 다르면 실패 → 새로 읽고 다시) |
| `rooms.setEntry` | rooms | 각자 자기 값만: `{ roomId, value }` (null이면 지움) |
| `rooms.delete` | rooms | 만든 사람·관리자 |
| `notify` | notify | `{ title, body }` Windows 알림 |
| `clipboard.write` | clipboard | `{ text }` |
| `file.save` | files | `{ name, text }` 저장 창에서 사용자가 고른 곳에 글자 파일로 저장(csv·tsv·txt·json·md·html, 5MB까지) → `{ ok, path }` |
| `file.open` | files | `{ exts: ['csv'] }` 열기 창에서 사용자가 고른 글자 파일을 읽음(UTF-8, 아니면 CP949) → `{ ok, name, text }` |
| `ocr.recognize` | ocr | `{ image, lang? }` PNG·JPEG data URL(12MB까지)의 글자를 이 PC의 Windows 글자 인식으로 읽음 → `{ ok, text, lines, language, languages, error }`. `image: ''`이면 쓸 수 있는 언어만 알려 줌 |
| `copilot.open` | copilot | Windows의 Copilot 앱(없으면 웹 페이지)을 엶 → `{ ok, where: 'app' \| 'web' }`. 질문을 넘기는 방법은 없으므로 `clipboard.write`로 복사해 두고 사용자가 붙여넣게 함 |
| `pii.scan` | — | `{ text }` 개인정보로 보이는 것 → `[{ kind, label, count, samples }]` (가린 값). 밖으로 보내는 글을 만들 때 확인용 |
| `openRoute` | — | `{ room }` 이 확장 기능의 다른 방 열기 |

이벤트: `TeamHub.on('room.changed', ({ roomId, deleted }) => …)` — 다른 팀원이 방을 바꾸면 옵니다.

방 데이터는 서버에 저장되고(공유 데이터·참여 데이터 각 64KB까지) 공개 범위 밖의 팀원은 볼 수 없습니다.
규칙(누가 이기는지 등)은 확장 기능 화면에서 계산합니다. 서버는 내용을 해석하지 않습니다.

## 시험
- 묶기: `pnpm plugins:pack` → `release/plugins/<id>-<버전>.thplugin`
- TeamHub **확장 기능 → 파일에서 설치**로 넣어 봅니다.
- 순수 로직은 `tests/plugins/`에 단위 테스트를 둡니다(예: `ladder.test.ts`).
- 예시: `plugins/ladder`(함께하기 방), `plugins/matjip`(방 하나를 팀 게시판으로: 각자의 글·좋아요·댓글을 자기 참여 데이터에), `plugins/survey`(방 하나 = 설문 하나), `plugins/meal`(관리자가 만든 방 하나에 마감 시각, 각자의 날짜별 신청은 자기 참여 데이터에), `plugins/bipum`(64KB 한도를 넘는 목록을 만든 사람의 방 여러 개에 나누어 담기, 각자의 기록은 참여 데이터에, CSV 가져오기·인쇄), `plugins/dutchpay`(이 PC 저장만), `plugins/ocr`·`plugins/copilot`(본체 기능 호출). 표 편집·수식 엔진·파일 저장/열기는 같은 방식으로 만든 본 기능 `resources/ledger`(관리대장)를 참고하세요.
- `sandbox`에서는 `prompt()`가 동작하지 않습니다(Electron). 입력은 `<dialog>`로 받으세요. 붙여넣기는 `paste` 이벤트의 `clipboardData`로 읽습니다(클립보드 읽기 권한 없음).
