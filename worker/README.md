# 결과 자동 커밋 + 통계 + 상태 동기화 Worker

"결과 텍스트로 저장" 버튼을 누르면 결과를 `results/<날짜>.txt`로 GitHub 저장소에 자동 커밋하고, `/stats` 경로에서는 지금까지 저장된 모든 결과 파일을 집계해 순위와 포(front)/백(back) 자리 승률을 보여주는 Cloudflare Worker입니다. GitHub 토큰은 이 Worker의 비밀(secret)로만 저장되고, 공개 페이지(GitHub Pages) 쪽 코드에는 절대 노출되지 않습니다.

또한 `/state`는 선수 명단·대진표·경기 결과 입력 상태를 Workers KV에 저장/조회하는 엔드포인트로, 카카오톡 인앱 브라우저·사파리 등 서로 다른 브라우저(각자 별도의 localStorage를 가짐)에서 접속해도 항상 같은 화면을 보여주기 위한 공유 저장소 역할을 합니다.

## 배포 순서 (본인 Cloudflare 계정 필요)

1. **Cloudflare 계정 로그인 & Wrangler 설치**
   ```
   npx wrangler login
   ```
   브라우저가 열리면 Cloudflare 계정으로 로그인하고 권한을 승인하세요.

2. **GitHub 토큰 발급** (repo 쓰기 권한만 가진 전용 토큰 권장)
   - GitHub → Settings → Developer settings → Fine-grained personal access tokens → Generate new token
   - Repository access: `unipro8787/tennis-bracket` 저장소만 선택
   - Permissions: **Contents: Read and write** 만 부여
   - 토큰 발급 후 복사 (한 번만 보여줍니다)

3. **Worker에 토큰 등록**
   ```
   cd worker
   npx wrangler secret put GITHUB_TOKEN
   ```
   프롬프트가 뜨면 위에서 발급한 토큰을 붙여넣으세요.

4. **배포**
   ```
   npx wrangler deploy
   ```
   배포가 끝나면 `https://tennis-bracket-results.<your-subdomain>.workers.dev` 형태의 URL이 출력됩니다.

5. **이 URL을 `index.html`의 `RESULTS_WORKER_URL` 상수에 붙여넣고 커밋/푸시**하면 연동이 끝납니다.

## 동작 방식

**저장 (`POST /`)**
- 클라이언트는 결과 텍스트만 이 Worker에 POST로 전송합니다.
- Worker는 `unipro8787.github.io` 출처(Origin)에서 온 요청만 허용합니다.
- Worker가 GitHub Contents API로 `results/YYYY-MM-DD.txt` 파일을 생성하거나(이미 있으면) 갱신합니다.
- 하루에 여러 번 저장을 눌러도 같은 날짜 파일이 최신 내용으로 덮어써집니다.

**통계 (`GET /stats`)**
- 브라우저에서 Worker 배포 URL 뒤에 `/stats`를 붙여 직접 접속하면 됩니다 (예: `https://tennis-bracket-results.<subdomain>.workers.dev/stats`).
- Worker가 `results/` 폴더의 모든 `.txt` 파일을 읽어와 파싱한 뒤, 선수별 순위(경기/승/패/무/승률/휴식)와 포/백 자리별 승률 표를 HTML로 렌더링합니다.
- 점수를 입력하지 않은 "미정" 경기는 통계에서 제외됩니다.
- 포/백 자리 표본이 3경기 미만인 선수는 "표본 부족"으로 표시됩니다 (전체 집계에서는 포/백 승률이 항상 거의 동일하게 나오는 게 수학적으로 당연하므로, 의미 있는 건 선수 개인의 포·백 성향 차이입니다).

**상태 동기화 (`GET/POST /state`)**
- 클라이언트는 선수 명단/편성 옵션/대진표/결과 입력 상태 전체를 JSON으로 KV 네임스페이스(`STATE` 바인딩)에 저장·조회합니다.
- 편집할 때마다(디바운스 0.6초) `POST /state`로 최신 상태를 덮어쓰고, 페이지를 열 때마다 `GET /state`로 가장 최근 상태를 가져와 화면에 반영합니다(마지막에 저장한 내용이 항상 우선 — last write wins).
- KV 네임스페이스는 `wrangler kv namespace create STATE`로 생성하고 `wrangler.toml`의 `[[kv_namespaces]]`에 바인딩되어 있어야 합니다.
