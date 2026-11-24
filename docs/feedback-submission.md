# 기능요청·오류신고: 제출 형식, 접수 규칙, 보안, 설정

프로그램 관리자(이 저장소의 소유자)를 위한 문서입니다. 사용자는 `docs/manual/90-settings.md`, 팀의 관리자는 `docs/manual/91-admin.md`를 봅니다.

## 1. 흐름

```
구성원 PC ──(1) 글 한 건(JSON)──▶ 팀의 서버 PC ──(2) 주 1회 묶음(JSON)──▶ GitHub 저장소(이슈, 라벨 접수)
                                                                          │
                                              (3) 접수 워크플로가 검사 ──▶ 통과한 글만 게시 이슈로 ──▶ 공개 게시판
```

1. **구성원 PC → 서버 PC** (`POST /api/feedback`). GitHub 키도 인터넷도 필요 없습니다. 서버 PC가 형식을 검사하고 보관합니다(구성원 한 명당 1분에 1건, 하루 10건).
2. **서버 PC → GitHub**, 주 1회. 받은 글을 **묶음** 한 문서로 만들어, 프로그램에 들어 있는 GitHub App 키로 이슈를 하나 만듭니다. 제목은 `[접수] <bundleId>`, 본문은 JSON만 든 코드 블록 하나, 라벨은 `접수` 하나입니다. **PC는 "접수됨" 여부를 정하지 않습니다.**
3. **GitHub 쪽 접수 워크플로**(`.github/workflows/feedback-intake.yml` → `scripts/feedback-intake.mjs`)가 묶음을 검사해 거부하거나, 통과한 글마다 게시 이슈를 만듭니다. 게시판(`site/feedback.html`)은 `scripts/build-feedback-board.mjs`가 **검사를 통과한 글만 다시 검증해서** 만든 `feedback.json`을 보여 줍니다.

주간 규칙: 대기 중인 글이 있고 **마지막 묶음을 만든 지 7일이 지났으면**(처음에는 가장 오래된 글을 받은 지 7일) 묶습니다. 서버 PC는 1시간마다, 그리고 시작 90초 뒤에 확인하므로 꺼져 있던 서버 PC는 다시 켜진 직후에 밀린 것을 처리합니다. 보내지 못한 묶음은 하루에 한 번 다시 보내며, GitHub가 만든 이슈 번호를 답으로 받기 전에는 "전달됨"으로 표시하지 않습니다.

## 2. 형식 (`schema: 1`)

형식은 세 곳에 같은 내용으로 있고, `tests/shared/feedback-schema.test.ts`가 세 곳의 판정이 같은지 확인합니다. **고칠 때는 셋을 함께 고치고**, 모양이 바뀌면 `schema` 번호를 올립니다.

| 파일 | 쓰는 곳 |
|---|---|
| `src/shared/schemas/feedback.ts` (Zod) | 프로그램, 서버 PC |
| `scripts/lib/feedback-schema.mjs` (순수 JS) | GitHub 워크플로, 게시판 빌더 |
| `docs/feedback-submission.schema.json` (JSON Schema 2020-12) | 사람과 도구 |

### 글 한 건 (item) — 구성원 PC가 서버 PC에 내는 것

| 필드 | 규칙 |
|---|---|
| `kind` | `"feature"`(기능요청) 또는 `"bug"`(오류신고) |
| `title` | 2~100자, 한 줄 |
| `body` | 5~5000자. 제어 문자는 줄바꿈(LF)과 탭만 |
| `author` | 0~30자, 한 줄. 빈 문자열이면 익명 |
| `installId` | 글을 쓴 PC의 고유값 `XXXX-XXXX-XXXX`. 게시판에는 싣지 않음 |
| `submissionId` | UUID v4(소문자). 글마다 새로 만들며, 같은 값은 두 번 게시되지 않음 |
| `createdAt` | ISO 8601 UTC, 밀리초까지 (`2026-11-24T00:00:01.000Z`) |
| `app` (선택) | `{ "version": "1.7.2", "os": "Windows 10.0.26100" }`. "버전 정보 함께 보내기"를 켰을 때만 |

### 묶음 (bundle) — 서버 PC가 GitHub에 내는 것

| 필드 | 규칙 |
|---|---|
| `schema` | `1` |
| `type` | `"bundle"` |
| `bundleId` | UUID v4. 같은 묶음은 두 번 받지 않음 |
| `serverId` | 서버 PC의 고유값 `XXXX-XXXX-XXXX`. GitHub가 확인하는 고유키값(차단 목록, 하루 묶음 수) |
| `period` | `{ "from": 시각, "to": 시각 }`, `from <= to` |
| `createdAt` | 묶음을 만든 시각 |
| `app` | `{ "version": "1.7.2" }` (서버 PC의 프로그램 버전) |
| `items` | 글 1~200건 |

**이 밖의 것은 들어가지 않습니다**: 기관·팀 이름, 구성원 이름·ID, PC 이름, Windows 계정, IP·MAC 주소. 모르는 키가 하나라도 있으면 거부됩니다(`additionalProperties: false`, Zod `strictObject`).

### JSON Schema로 적을 수 없어 코드로 검사하는 규칙

- 글자: NFC로 정규화되어 있어야 하고, 앞뒤 공백이 없어야 합니다. 제어 문자, 방향 전환 문자(U+202A~202E, U+2066~2069 등), 보이지 않는 서식 문자(U+200B 등), 줄 구분 문자(U+2028/2029), 태그 문자, 짝 없는 서로게이트는 거부합니다. 길이는 유니코드 코드 포인트로 셉니다.
- 시각: 실제로 있는 시각이어야 합니다(`2026-02-30…` 거부).
- 표기: 공백 없는 JSON이어야 하고, 읽었다가 다시 쓴 결과가 원문과 같아야 합니다. 그래서 **같은 키를 두 번 쓴 문서, 들여쓰기한 문서, `1.0` 같은 다른 숫자 표기는 거부**됩니다. 프로그램은 키 순서를 항상 위 표의 순서로 씁니다.
- 크기: 묶음 전체가 UTF-8로 60,000바이트 이하(GitHub 이슈 본문 한도 65,536자 안쪽). 넘으면 서버 PC가 여러 묶음으로 나눕니다. 크기는 **JSON을 읽기 전에** 확인합니다.
- 시각 범위(GitHub 러너의 시계 기준): 묶음과 글의 `createdAt`이 180일 전부터 24시간 뒤 사이.

## 3. GitHub 쪽 접수 규칙

워크플로는 **라벨 `접수`가 붙어 있고 열려 있으며 아직 처리되지 않은 이슈만** 다룹니다. 다른 이슈는 건드리지 않습니다. 공개 저장소에서 이슈는 누구나 열 수 있지만 라벨은 저장소 권한이 있어야 붙일 수 있으므로, 지나가는 사람이 연 이슈는 접수 대상이 되지 않습니다.

### 묶음 전체를 거부하는 경우 (사유 코드)

| 코드 | 뜻 |
|---|---|
| `bad_envelope` | 제목이 `[접수] <bundleId>`가 아니거나, 본문이 json 코드 블록 하나가 아님(두 번째 블록, 덧붙인 글 포함) |
| `too_large` | 60,000바이트 초과 |
| `bad_json` | JSON으로 읽을 수 없음 |
| `not_compact` | 공백·중복 키 등 정해진 표기가 아님 |
| `bad_format` | 묶음의 모양이 다름(모르는 키, 빠진 키, 틀린 형, 글 0건 또는 200건 초과 등) |
| `time_window` | 묶음의 `createdAt`이 허용 범위 밖 |
| `blocked` | `serverId`가 차단 목록(`site/feedback-blocked.json`)에 있음 |
| `duplicate` | 같은 `bundleId`가 이미 접수됨(같은 묶음이 동시에 두 번 오면 번호가 큰 쪽) |
| `rate_limit` | 같은 `serverId`에서 24시간 안에 3묶음 초과 |

거부하면: 제목을 `[거부] 접수되지 않은 제출`로, **본문을 안내문으로 바꾸고**(내용이 공개 이슈에 남지 않게), 라벨을 `거부`만 남기고, "계획 없음"으로 닫고, 잠급니다. 댓글에는 사유 코드와 한 줄 설명만 적고 **제출 내용은 다시 싣지 않습니다.**

### 묶음은 받되 글 하나를 빼는 경우 (요약 댓글에 건수로 표시)

| 코드 | 뜻 |
|---|---|
| `bad_item` | 글의 모양이 다름 |
| `item_time` | 글의 `createdAt`이 허용 범위 밖 |
| `item_blocked` | 글의 `installId`가 차단 목록에 있음 |
| `item_duplicate` | 같은 `submissionId`의 글이 이미 게시됨(이전 묶음, 또는 같은 묶음 안의 두 번째) |

### 받아들이면

- 글마다 게시 이슈 하나: 제목 `[기능요청] …` / `[오류신고] …`, 라벨 `기능요청`|`오류신고` + `검증됨`. 본문의 글자는 모두 무해하게 바꿉니다(HTML은 엔티티로, Markdown 기호는 역슬래시로, `@`·`#숫자`·`GH-숫자`·`://`·`www.` 뒤에는 폭 없는 공백을 넣어 알림·참조·링크가 생기지 않게).
- 게시 이슈 끝의 주석 `<!-- teamhub-feedback:v1 <검증한 글의 JSON, base64url> <bundleId> <봉인> -->`에 **검증한 원문**을 남깁니다. 게시판은 이것만 읽습니다.
- 묶음 이슈는 제목 `[묶음] <bundleId>`, 라벨 `처리됨`, "완료"로 닫고 요약 댓글을 답니다. 묶음 JSON은 본문에서 지웁니다.
- **두 번 돌려도 결과가 같습니다.** 처리된 이슈는 건너뛰고, 중간에 끊긴 묶음은 이미 만든 글(`submissionId` + `bundleId`로 식별)을 빼고 나머지만 만듭니다. 끊긴 묶음은 하루 한 번 도는 예약 실행이나 수동 실행(`gh workflow run feedback-intake.yml`, 필요하면 `-f issue=<번호>`)이 이어서 처리합니다.

### 게시판 빌더가 믿는 것

`검증됨` 라벨이 있고(`비공개` 라벨은 제외), 끝의 주석에 든 글이 **지금도 형식 검사를 통과하고 봉인이 맞는** 이슈만 싣습니다. 분류·제목·내용·작성자는 그 JSON에서 가져오며, **이슈의 제목·라벨·보이는 본문은 쓰지 않습니다**(나중에 누가 고쳐도 게시판은 바뀌지 않음). `installId`와 `serverId`는 싣지 않습니다. 답변은 저장소 관리자의 댓글만 싣습니다.

## 4. 보안 점검

| 위협 | 막는 방법 |
|---|---|
| **설치 파일에서 키를 꺼냄** | 키는 설치 파일에 봉인되어 들어가며(`resources/feedback.bin`), 뜯어 보면 꺼낼 수 있습니다. 이 키로 **할 수 있는 일**: 이 저장소의 이슈·댓글·라벨을 읽고 쓰기(이슈를 마구 만들기, 남의 이슈를 고치거나 닫기 포함). **할 수 없는 일**: 코드·릴리스·Actions·시크릿·설정에 접근, 다른 저장소 접근, 봉인 만들기. 앱 권한은 Issues 읽기/쓰기 하나뿐이고, 보낼 때마다 이 저장소·이슈 권한으로 좁힌 임시 토큰을 받아 쓰고 바로 폐기합니다. |
| 꺼낸 키로 **검사를 건너뛰고 게시판에 글을 올림** | 게시판은 접수 워크플로의 **봉인**(`FEEDBACK_SEAL_KEY`로 만든 HMAC-SHA256)이 맞는 글만 싣습니다. 이 값은 Actions 시크릿이라 프로그램의 키로는 만들 수 없습니다. `검증됨` 라벨을 직접 붙이거나, 검증된 글의 JSON을 바꾸거나, 다른 이슈에 복사해도 게시판에 나오지 않습니다(복사본은 번호가 가장 작은 원본만 남김). 봉인 키가 없는 실행(로컬 빌드 등)은 봉인된 글을 확인할 수 없으므로 게시판을 새로 만들지 않고 올라가 있는 것을 그대로 둡니다. |
| 꺼낸 키로 **이슈를 어지럽힘**(스팸, 기존 이슈 수정) | 남는 위험입니다. 게시판에는 영향이 없지만 GitHub 이슈 화면은 어지럽혀질 수 있습니다. 대응: 아래 "키 바꾸기". 묶음으로 들어오는 스팸은 하루 3묶음·묶음당 200건·차단 목록으로 막습니다. |
| **워크플로 주입** | `run:` 줄에 이슈의 글을 넣지 않습니다(`${{ github.event.issue.* }}` 없음. 파일에서 이벤트에서 꺼내 쓰는 것은 동시 실행 묶음용 이슈 번호뿐). 스크립트는 이벤트 파일에서 번호만 읽고 내용은 GitHub API로 다시 가져오며, 수동 실행의 입력값은 숫자인지 확인합니다. GitHub 자체 액션(`actions/checkout`, `actions/setup-node`)만 쓰고, 스크립트는 Node 내장 모듈만 씁니다. `permissions`는 `contents: read`, `issues: write`뿐. `pull_request_target` 없음, 기본 브랜치의 코드만 실행. 체크아웃은 `persist-credentials: false`. |
| **JSON 처리** | 크기를 먼저 재고 `JSON.parse`만 씁니다(`eval`·`new Function` 없음). 검사 결과는 **아는 키만 골라 새 객체로 복사**하며, `__proto__`·`constructor` 같은 키는 "모르는 키"로 거부됩니다. 깊은 중첩·중복 키·틀린 형은 모두 거부. |
| **게시판 화면의 출력** | `site/feedback.html`은 모든 글을 `textContent`로 넣습니다(`innerHTML` 없음). 링크는 `http:`·`https:` 주소만 만들고 `rel="noopener noreferrer nofollow"`를 붙입니다. GitHub 이슈 쪽은 위의 무해화 규칙. |
| **개인정보** | PC에서 나가는 것은 글 한 건의 필드가 전부입니다. `installId`/`serverId`는 MAC·IP에 난수를 섞어 해시한 값이라 주소가 들어 있지 않고 되돌릴 수 없습니다(`installIdFrom`). 구성원 ID는 서버 PC에만 남고 묶음에 들어가지 않습니다. 보내기 전에 PC에서 개인정보로 보이는 내용을 한 번 더 묻습니다. 서버 PC의 활동 기록에는 글 내용을 남기지 않습니다. |
| **남용** | 구성원당 1분 1건·하루 10건(서버 PC), 서버 PC당 하루 3묶음·묶음당 200건(GitHub), 차단 목록, 거부한 이슈 잠금. |
| **거부한 내용이 공개로 남음** | 본문을 안내문으로 덮어씁니다. 다만 **GitHub는 이슈의 수정 기록을 보관**하므로, 개인정보가 들어 있던 경우 이슈 화면의 "edited ▾ → 해당 수정본 → Delete revision from history"로 직접 지우거나 이슈를 삭제해야 합니다(워크플로 권한으로는 할 수 없음). |

### 운영

- **PC 차단**: `site/feedback-blocked.json`(문자열 배열)에 `serverId` 또는 `installId`를 넣고 main에 올립니다. 다음 접수부터 적용됩니다. 예: `["ABCD-EFGH-JKLM"]`
- **글 숨기기**: 게시 이슈에 `비공개` 라벨을 붙입니다.
- **키 바꾸기**(키가 새어 나갔을 때): GitHub App 설정 → Private keys에서 새 키를 만들고 옛 키를 Delete → `gh secret set FEEDBACK_APP_KEY …` → 새 버전 배포. 옛 키는 지우는 즉시 쓸 수 없고, 업데이트하지 않은 서버 PC의 묶음은 "실패: 인증에 실패"로 남아 있다가 업데이트 뒤에 나갑니다(잃지 않음). 그 사이에는 관리 화면의 [파일로 저장]으로 받을 수 있습니다.
- **봉인 키 바꾸기**: 바꾸면 이전 글의 봉인이 맞지 않아 게시판에서 빠집니다. 꼭 필요할 때만 하세요.

## 5. 한 번 해야 하는 설정 (저장소 소유자)

**이 설정을 하기 전에는 어떤 서버 PC도 GitHub로 보내지 못합니다.** 그동안 글은 각 팀의 서버 PC에 "대기"로 쌓이고, 관리 화면의 [파일로 저장]으로 꺼내 직접 전달할 수 있습니다(6번).

1. **GitHub App 만들기**: GitHub 오른쪽 위 프로필 사진 → Settings → 왼쪽 맨 아래 Developer settings → GitHub Apps → **New GitHub App**.
   - GitHub App name: 아무 이름(예: `teamhub-feedback`), Homepage URL: 저장소 주소
   - Webhook: **Active 체크 해제**
   - Permissions → Repository permissions → **Issues: Read and write** (다른 것은 모두 No access. Metadata: Read-only는 자동)
   - Where can this GitHub App be installed?: **Only on this account** → Create GitHub App
2. **키 만들기**: 만들어진 앱 화면에서 **App ID**를 적어 두고, 아래쪽 Private keys → **Generate a private key** → `.pem` 파일이 내려받아집니다.
3. **이 저장소에만 설치**: 왼쪽 Install App → Install → **Only select repositories** → `team-share-info` 선택 → Install. (설치 뒤 주소 끝의 숫자가 installation ID입니다. 선택 사항.)
4. **시크릿 등록** (저장소 폴더에서, PowerShell):
   ```powershell
   gh secret set FEEDBACK_APP_ID --repo leondic1976/team-share-info --body "여기에 App ID"
   Get-Content .\내려받은-키.pem -Raw | gh secret set FEEDBACK_APP_KEY --repo leondic1976/team-share-info
   gh secret set FEEDBACK_INSTALLATION_ID --repo leondic1976/team-share-info --body "여기에 installation ID"   # 선택
   gh secret set FEEDBACK_SEAL_KEY --repo leondic1976/team-share-info --body (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
   ```
   등록한 뒤 `.pem` 파일은 지웁니다. `FEEDBACK_SEAL_KEY`는 게시판의 봉인 키로, **처음부터 등록해 두세요**(나중에 등록하면 그 전에 받은 글은 게시판에서 빠집니다).
5. **라벨 만들기와 배포**: `gh workflow run feedback-intake.yml`을 한 번 실행해 라벨(`접수`, `검증됨`, `거부`, `처리됨`, `기능요청`, `오류신고`)을 만든 뒤, 새 버전을 배포합니다(`pnpm release patch "..."`). 키는 배포할 때 설치 파일에 들어가므로, **서버 PC가 그 버전으로 업데이트된 뒤부터** 자동으로 보냅니다.

알아 둘 것: 릴리스 워크플로(`release.yml`)의 사이트 빌드 단계에는 아직 `FEEDBACK_SEAL_KEY`가 전달되지 않습니다. 그 실행에서는 게시판을 새로 만들지 않고 올라가 있는 것을 유지하므로 안전하지만, 그 단계의 `env`에 `FEEDBACK_SEAL_KEY: ${{ secrets.FEEDBACK_SEAL_KEY }}` 한 줄을 넣으면 배포 때도 게시판이 갱신됩니다.

## 6. 파일로 받은 묶음 넣기 (서버 PC에 인터넷이나 키가 없을 때)

팀의 관리자가 [관리 → 기능요청·오류신고 → 파일로 저장]으로 저장한 `teamhub-feedback-<bundleId>.json`을 받았다면:

```powershell
$env:GH_TOKEN = gh auth token
node scripts/feedback-intake.mjs --file .\teamhub-feedback-….json --dry-run   # 검사만
node scripts/feedback-intake.mjs --file .\teamhub-feedback-….json             # 접수 이슈로 올림
```

같은 규칙으로 검사한 뒤 `접수` 이슈를 만들고, 그다음은 워크플로가 다른 묶음과 똑같이 처리합니다(같은 묶음을 두 번 올려도 한 번만 접수). 형식이 틀리면 사유 코드를 출력하고 아무것도 올리지 않습니다. 팀의 관리자는 관리 화면에서 그 묶음을 [직접 전달함]으로 표시합니다.
