# 결과 자동 커밋 Worker

"결과 텍스트로 저장" 버튼을 누르면 결과를 `results/<날짜>.txt`로 GitHub 저장소에 자동 커밋해주는 Cloudflare Worker입니다. GitHub 토큰은 이 Worker의 비밀(secret)로만 저장되고, 공개 페이지(GitHub Pages) 쪽 코드에는 절대 노출되지 않습니다.

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

- 클라이언트는 결과 텍스트만 이 Worker에 POST로 전송합니다.
- Worker는 `unipro8787.github.io` 출처(Origin)에서 온 요청만 허용합니다.
- Worker가 GitHub Contents API로 `results/YYYY-MM-DD.txt` 파일을 생성하거나(이미 있으면) 갱신합니다.
- 하루에 여러 번 저장을 눌러도 같은 날짜 파일이 최신 내용으로 덮어써집니다.
