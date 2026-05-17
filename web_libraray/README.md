# 공공도서관 도서 검색 웹서비스

GitHub Pages에 올릴 수 있는 정적 프론트엔드와 Cloudflare Worker API 프록시입니다.

## 구성

- `index.html`, `styles.css`, `app.js`: GitHub Pages 정적 웹앱
- `worker.js`: Cloudflare Worker API 프록시
- `wrangler.toml`: Worker 배포 설정

## 설정

1. Cloudflare Worker secret을 등록합니다.

```bash
wrangler secret put PUBLIC_LIBRARY_API_KEY
wrangler secret put NL_API_KEY
```

2. Worker를 배포합니다.

```bash
wrangler deploy
```

3. `app.js`의 `CONFIG.workerBaseUrl`을 배포된 Worker URL로 변경합니다.

```js
const CONFIG = {
  workerBaseUrl: "https://YOUR_WORKER_SUBDOMAIN.workers.dev"
};
```

4. `web_libraray` 폴더를 GitHub Pages에서 접근 가능한 경로로 배포합니다.

## 데이터 저장

로그인 없이 브라우저에만 데이터를 저장합니다.

- 즐겨찾기 도서관 ID: `localStorage`
- 전국 도서관 목록/위치 캐시: `IndexedDB`

도서관 목록은 GitHub Pages에 함께 배포되는 `libraries.json`에서 받아오며, 브라우저에는 7일 동안 캐시합니다. 책을 선택하면 즐겨찾기 도서관만 먼저 거리 계산해서 표시하고, 이후 전체 도서관 목록을 거리순으로 정렬합니다.

`libraries.json`은 정적 DB 역할을 하므로 가까운 도서관 계산에는 Worker가 필요하지 않습니다. 도서 검색처럼 API 키가 필요한 요청만 Worker를 사용합니다.

## 도서관 DB 갱신

공공데이터포털 API 키가 있는 환경에서 아래 명령으로 정적 도서관 DB를 갱신합니다.

```bash
PUBLIC_LIBRARY_API_KEY=... node scripts/update-libraries.mjs
```

GitHub Pages 배포에서는 repository secret `PUBLIC_LIBRARY_API_KEY`가 있으면 배포 중 자동으로 `libraries.json`을 생성합니다.

## API 키

프론트엔드에는 API 키를 넣지 않습니다. 모든 외부 API 요청은 Cloudflare Worker에서 처리합니다.
