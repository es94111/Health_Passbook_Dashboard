# 健康存摺儀表板

台灣健保健康存摺（NHI）個人健康資料視覺化儀表板。

**開發版本：2.2.0 — Docker image 發版自動化；2.1.0 起的 FHIR Bridge 整合與 20 GB 串流備份仍待真實去識別化匯出檔及瀏覽器端到端驗收，尚非正式發布。**

## 快速開始（本機開發）

### 1. 安裝相依套件

```bash
npm run install:all
```

### 2. 設定環境變數（選填）

```bash
cp server/.env.example server/.env
# 編輯 server/.env，視需要填入 JWT_SECRET、GOOGLE_CLIENT_ID 等
```

### 3. 啟動開發伺服器

```bash
npm run dev
```

開啟瀏覽器：`http://localhost:5173`

---

## 首次使用

1. 前往應用程式網址，點選「註冊」建立帳號
   - 第一個註冊的帳號自動成為管理員
2. 登入後設定至少 12 字元的「資料加密密碼」（不同於登入密碼），選擇健保快易通原生 JSON 或 NHI-FHIR Bridge 匯出的 FHIR R4 Bundle JSON
3. 若沒有可自動比對的病人識別碼，核對檔案與本帳號屬於同一人，勾選確認後才合併；已知識別碼衝突時無法強制合併
4. 匯入後可瀏覽門診、住院、檢驗、醫療報告、用藥與「同步紀錄」；重新登入需再次輸入資料加密密碼解鎖

### NHI-FHIR Bridge 匯入方式與限制

1. 在健保署網站自行登入並明確授權 NHI-FHIR Bridge 擴充功能匯出資料，將完整 Bundle JSON 下載到自己的裝置。整合背景見 [參考 PR #59](https://github.com/es94111/Health_Passbook_Dashboard/pull/59)，該連結不是外掛安裝頁。
2. 於本網站點選「匯入新資料」選檔。網站不索取健保署密碼、Cookie 或登入工作階段；不監聽外掛訊息、不連線至 localhost 接收資料，也不下載外部附件 URL。
3. 一個帳號僅用於同一人，眷屬應分開建立帳號。每份 Bundle 必須且只能包含一位 Patient；無法解析／跨病人的 subject、patient 等參照會拒絕整份匯入。Patient.id 只是檔內識別，不能證明是同一人。原生 NHI JSON 與沒有共同可靠識別碼的來源，每次都須人工確認。
4. 支援 Encounter、Observation（含 component）、MedicationRequest／Dispense／Statement、DiagnosticReport、DocumentReference、ImagingStudy、Media、Binary、Immunization 等 R4 資源的專用展示或關聯。未提供專用畫面的資源仍保存在原始來源檔；本程式做結構及關聯驗證，不是完整的 FHIR 規範／醫療正確性驗證器。
5. 檢驗的數值、單位、來源與參考文字分別保存；文字、陰陽性、比較符號及缺少日期的結果不冒充精確數字。不同單位／來源分開畫趨勢；參考條件不相容時不套用單一正常範圍。缺少日期不補成今天。
6. 支援內嵌 JPEG／PNG／WebP 預覽及 PDF 下載（不內嵌執行）；以 Base64、檔頭、大小與 SHA-256 驗證附件。同內容附件只儲存一份，使用隨機 ID，與病歷索引分開以 AES-GCM 加密。非支援類型僅保留原始內容，不提供預覽。
7. 單次 JSON 上限 **32 MiB**、單一附件解碼後上限 **12 MiB**、每帳號附件索引上限 **512 個**；加密前的累計病歷索引（含目前紀錄、歷次原始來源與歷程，但不含已分離的附件位元組）也有 **32 MiB** 上限。超限時不覆寫原資料，請縮小匯出日期範圍或關閉影像後分批匯入；已達累計上限不能靠分批繞過。
8. 相同來源／資源重匯會略過，已知較舊的 FHIR 版本不覆寫新版本；原始來源、更新內容與匯入時間仍加密保留。NHI／FHIR 跨格式缺少共同紀錄識別碼時只標示可比對的疑似重複，不破壞性合併，統計可能包含兩個來源。
9. 「同步紀錄」可查看新增／更新／略過數與警告，也能在本機還原並下載原始來源 JSON。**下載檔是明文健康資料**，勿上傳 GitHub、Log、CI 或第三方服務。
10. 匯入先完整驗證並解析候選資料，再上傳加密附件，最後以版本條件提交病歷索引。附件失敗、解密失敗、身分衝突或版本競爭均不覆寫既有索引；失敗過程可能留下暫存密文附件，由後端清理。

原始 DICOM 取得、遠端附件抓取、Chrome 擴充功能直接交付及遠端網站自動同步**不包含在本版本**；直接通訊需另行檢查來源、權限、身分與授權流程。實際 Bridge 匯出格式的相容性仍需使用去識別化樣本驗收。

### 開發驗證

```bash
cd dashboard
npm exec --no -- vitest run
npm run build
npm run lint
cd ../server
npm test
npm run build
```

依賴套件掃描可分別執行 `npm audit --prefix dashboard`、`npm audit --prefix server`、`npm audit --prefix dashboard/.lint-toolchain`；秘密掃描沿用既有 Gitleaks／GitHub-hosted CI。僅使用合成或去識別化測試資料，不將個人健康資料寫入測試產物。

---

## ⚠️ 重要：備份加密金鑰

`server/data/` 目錄包含：
- `users.json` — 加密的帳號資料
- `records-{userId}.json` — 加密的健康記錄
- `.key` — **主加密金鑰**

**若 `.key` 檔案遺失，且未設定 `ENCRYPTION_KEY` 環境變數，所有健康資料將永久無法解密。**

Docker 部署時務必掛載 Volume，並定期備份。

### 含附件的備份與還原

- 管理員匯出的完整備份包含使用者設定、主病歷密文及其引用的獨立附件密文，不需要將新匯入的病歷解成明文。**帳號、設定及登入紀錄等管理資訊仍可能是明文**，整份備份都應視為敏感檔案妥善保管。
- 恢復後仍需每位使用者原有的**資料加密密碼**才能讀取病歷，不能以重設登入密碼取代。JSON 備份不含伺服器主金鑰，匯入時以目標環境金鑰重新加密；若直接備份整個 `data/` 目錄，則須另行安全保存對應的 `.key` 或 `ENCRYPTION_KEY`。
- 維持 v1 備份相容性，舊備份可不含附件；附件或索引缺漏、格式錯誤時不得以不完整備份覆寫既有資料。覆寫前沿用安全快照機制。
- **單份完整備份上限為 20 GB（20,000,000,000 bytes），按未壓縮 UTF-8 JSON 計算，含所有帳號、設定與附件的 Base64 膨脹。** 匯出與還原使用相同上限；超限會以 HTTP 413／`BACKUP_TOO_LARGE` 拒絕，不會產生無法匯回的下載檔，還原也不會先寫入部分內容。
- 匯出不再於記憶體組出整份 JSON：伺服器先寫入 `data/.backup-transfers` 暫存檔，再以短時效、僅限本人使用的票證串流下載（支援瀏覽器續傳與取消，30 分鐘無活動即清除）。還原由瀏覽器直接串流上傳原檔，伺服器落盤後逐段解析驗證，通過才進入既有快照與覆寫流程；整個過程不將 20 GB 備份放入記憶體。
- 以 Docker／反向代理部署時，請確認 `proxy-body-size`、`client_max_body_size`、`proxy_read_timeout` 等設定可容納大檔，並為 `data/` 預留至少「備份大小 × 3」的磁碟空間（暫存、快照與原資料並存）。
- 多帳號或大量影像可能先達到整體備份上限，即使單次匯入／附件未超限。此版不提供自動分卷，管理員應事先規劃容量及離線保全方式；勿為通過上限刪除唯一資料副本。正式上線前，請在隔離環境實際演練含附件的備份、還原與解鎖。

---

## 環境變數

詳見 [server/.env.example](server/.env.example)。

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `JWT_SECRET` | JWT 簽名金鑰，正式環境務必設定 | 內建預設值（不安全） |
| `ENCRYPTION_KEY` | 64 char hex 主加密金鑰 | 自動生成並存入 `server/data/.key` |
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID（選填） | — |
| `PORT` | 後端監聽埠號 | `3001` |

金鑰生成指令：

```bash
openssl rand -hex 32
```

### Security hardening notes

- `JWT_SECRET` must be at least 32 bytes in production.
- `JWT_EXPIRES_IN` controls token lifetime. Default is `12h`.
- `ENCRYPTION_KEY` must be exactly 64 hex characters.
- Legacy plaintext data files are not auto-migrated by default. For a one-time migration from old plaintext JSON, start the server once with `ALLOW_PLAINTEXT_MIGRATION=true`, verify the files were rewritten as encrypted envelopes, then remove the setting.

### Session and health data security

- JWTs are stored in an HttpOnly cookie named `nhi_session`; frontend code no longer stores or reads JWTs from `localStorage`.
- The session cookie is `Secure` in production. For local HTTP development, set `SESSION_COOKIE_SECURE=false`.
- Password login is rate-limited by IP and username; all auth mutation endpoints also have an IP-level limiter.
- Passwords must be at least 12 characters and include at least three of lowercase, uppercase, number, and symbol.
- Health records are encrypted in the browser before upload with WebCrypto AES-GCM. The server stores only an opaque client encrypted envelope, then wraps that envelope with server-side encryption at rest.
- The data encryption passphrase is never sent to the server. If it is lost, existing health records cannot be recovered.
- Existing legacy server-readable health records must be re-uploaded from the original NHI JSON to migrate into client-side encryption.

---

## Google SSO 設定（選填）

### 申請 Google OAuth Client ID

1. 前往 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. 建立「OAuth 2.0 用戶端 ID」，類型選「網頁應用程式」
3. 依部署環境加入「授權 JavaScript 來源」：
   - 本機開發：`http://localhost:5173`
   - 正式環境：`https://your-domain.com`

### 本機開發

```bash
# server/.env
GOOGLE_CLIENT_ID=你的用戶端ID
```

前端在 runtime 向 `GET /api/auth/config` 取得 Client ID，因此不需要在 `dashboard/` 設定建置期變數，也不必為此重新建置 image。

### Docker / 正式環境

只需設定一個環境變數：

```
GOOGLE_CLIENT_ID=你的用戶端ID
```

前端會在 runtime 向 `GET /api/auth/config` 取得 Client ID，不需要重新建置 image。

---

## Docker 部署

### 架構說明

Docker image 採三階段建置：
1. **dashboard-build** — Vite 建置前端 SPA
2. **server-build** — TypeScript 編譯後端
3. **runtime** — 僅包含 production 相依套件、compiled JS、靜態前端檔案

前端與後端均由 Express 在同一個 port 服務，`/api/*` 走後端，其餘走前端 SPA。

### 手動建置與執行

```bash
# 建置 image
docker build -t nhi-dashboard .

# 執行（首次啟動會自動生成加密金鑰）
docker run -d \
  --name nhi-dashboard \
  -p 3001:3001 \
  -v nhi-data:/app/data \
  -e NODE_ENV=production \
  -e JWT_SECRET=$(openssl rand -hex 32) \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  nhi-dashboard
```

開啟 `http://localhost:3001`

> **注意**：`JWT_SECRET` 與 `ENCRYPTION_KEY` 每次 `$(openssl rand -hex 32)` 都會產生新值。
> 正式部署請將金鑰固定儲存（例如存入 `.env` 檔案），避免重啟後無法解密現有資料。

### 含 Google SSO

```bash
docker run -d \
  --name nhi-dashboard \
  -p 3001:3001 \
  -v nhi-data:/app/data \
  -e NODE_ENV=production \
  -e JWT_SECRET=你的JWT金鑰 \
  -e ENCRYPTION_KEY=你的64字元hex金鑰 \
  -e GOOGLE_CLIENT_ID=你的用戶端ID \
  nhi-dashboard
```

### Volume 資料持久化

```bash
# 查看 volume 位置
docker volume inspect nhi-data

# 備份
docker run --rm -v nhi-data:/data -v $(pwd):/backup alpine \
  tar czf /backup/nhi-data-backup.tar.gz /data
```

---

## CI/CD（GitHub Actions）

Docker image 由 `.github/workflows/docker-publish.yml` 自動建置、推送並發佈 GitHub Release。

### Docker image 發版流程

| 觸發條件 | 行為 |
|---|---|
| Pull request → `main` | 建置 `linux/amd64` image（不推送），實際啟動容器檢查 `/api/ping` 與 SPA 首頁後才回報成功 |
| Push → `main` | 建置 `linux/amd64` + `linux/arm64` 並推送，標籤 `latest`、`main`、`sha-<完整 commit>` |
| Push tag `v*` | 先比對標籤、`changelog.json` 與 `SRS.md` 版號，再推送 `X.Y.Z`、`X.Y`、`X`、`latest`（預先版不含 `latest`）與 `sha-<完整 commit>`，最後建立或更新 GitHub Release |
| 手動 `workflow_dispatch` | 同 push `main` |

映像同時發佈到：

- Docker Hub：`<DOCKERHUB_USERNAME>/nhi-dashboard`（未設定帳號時自動跳過，只發佈 GHCR）
- GHCR：`ghcr.io/es94111/nhi-dashboard`

推送時附帶 OCI labels、SBOM 與 `mode=max` provenance attestation。GitHub Release 內文由 `changelog.json` 自動產生，包含分類變更、pull 指令、平台、可用標籤與 image digest。

### 發版步驟

1. 依 `.claude/commands/update-docs.md` 更新 `changelog.json`（`currentVersion` + 新版本紀錄）、`SRS.md` 版本歷程與 `README.md` 版本標示
2. 合併到 `main`
3. 建立並推送標籤：

```bash
npm run release:tag            # 預覽：檢查工作目錄、版號與遠端標籤，並輸出 release 內文
npm run release:tag -- --yes   # 建立 vX.Y.Z 並推送，觸發 image 發佈與 GitHub Release
```

`scripts/release/check-version.mjs` 會在 CI 再次檢查標籤與文件是否同步，不一致時直接失敗，不會發佈半套版本。
`scripts/release/release-notes.mjs` 由 `changelog.json` 產生 GitHub Release 內文；版本紀錄若有 `"prerelease": true` 或版號帶 `-rc` 後綴，Release 會標記為預先版。

### GitHub-hosted runner

本專案為公開 repo，所有 workflow 都使用 GitHub 提供的 runner（`ubuntu-latest`），不需要自架 runner，也不必在 Settings → Actions → Runners 註冊機器：

- **Build & Publish Docker Image**：`ubuntu-latest` 搭配 `docker/setup-qemu-action` 與 Buildx，建置並推送 `linux/amd64` 與 `linux/arm64` 多架構映像。
- **Security Checks**：`npm audit` 與 Gitleaks 都在 `ubuntu-latest` 上執行；Node.js 22 由 `actions/setup-node` 安裝。
- **Dependabot Updates**：公開 repo 由 GitHub 直接提供 runner，不需要額外設定。

公開 repo 的 fork PR 不會取得 secrets。`npm audit` 不需 secret，因此 fork PR 也會執行；Gitleaks 需要 `pull-requests: write` 權限（fork PR 只有唯讀 token），因此只在同 repo 分支的 PR、`main` 推送、每週排程與手動執行時掃描。

`npm audit` 只產生報告並上傳 artifact，不會阻擋 PR；弱點修復由 Dependabot alerts 與其 PR 追蹤。

修改分支上的 workflow 不會改寫過去的執行紀錄或已發佈的 tag。重新執行舊 commit 的工作仍會使用該 commit 的 workflow；請從已更新的分支觸發新的執行。

### Dependabot 專用 runner（僅私有 repo 適用）

`Dependabot Updates` 不是一般的 workflow YAML，不能只修改 `runs-on`。GitHub 僅支援**私有 repo** 的 Dependabot 使用 self-hosted runner；本專案改為公開後已回到 GitHub-hosted runner，只有在 repo 轉回私有時才需要啟用 `scripts/dependabot-runner/` 的 Docker Compose 設定（需求為 `[self-hosted, Linux, X64, dependabot]`，且須在 repo → Settings → Code security → Dependabot 選擇該 runner）。

```bash
# 需要已啟動的 Docker Desktop／Compose、gh（repo 管理權限）及 jq
./scripts/dependabot-runner/manage.sh setup
./scripts/dependabot-runner/manage.sh status
./scripts/dependabot-runner/manage.sh verify
```

`manage.sh` 的 setup 會以 `gh` 取得短效註冊 token 並透過標準輸入傳給 runner，不會把憑證或 token 寫進 Compose、映像或 `.env`；註冊資訊與快取保存在專用 named volume，**不要執行 `docker compose down --volumes`**。


### 設定 GitHub Actions Secrets

前往 GitHub repo → Settings → Secrets and variables → Actions：

| Secret 名稱 | 說明 |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 帳號（選填；未設定時只發佈 GHCR） |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（非密碼） |

GHCR 使用 workflow 內建的 `GITHUB_TOKEN`，不需要額外 secret。映像的 Google Client ID 於執行期由 `GOOGLE_CLIENT_ID` 環境變數提供，發版時不需要任何建置期 secret。

### 取得 Docker Hub Token

Docker Hub → Account Settings → Personal access tokens → Generate new token

---

## Zeabur 部署

1. Zeabur 建立新服務 → 選擇「Docker Image」
2. Image 填入：`你的dockerhub帳號/nhi-dashboard`
3. 設定 Variables：

| 變數 | 值 |
|---|---|
| `NODE_ENV` | `production` |
| `JWT_SECRET` | `openssl rand -hex 32` 的輸出 |
| `ENCRYPTION_KEY` | `openssl rand -hex 32` 的輸出（**精確 64 字元**） |
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID（選填） |

4. 掛載 Volume：Container path 填 `/app/data`
5. 部署

> **`ENCRYPTION_KEY` 注意事項**：必須精確為 64 個 hex 字元（0-9、a-f）。
> 長度不對會造成 server 啟動 crash。設定前可先在本機確認：
> ```bash
> openssl rand -hex 32 | wc -c  # 應輸出 65（含換行）
> ```

---

## 目錄結構

```
/
├── server/                   後端 Express + TypeScript
│   ├── src/
│   │   ├── index.ts          伺服器入口，靜態檔案服務
│   │   ├── crypto.ts         AES-256-GCM 加密核心
│   │   ├── store.ts          使用者與健康資料讀寫
│   │   ├── auth.ts           JWT 中介層
│   │   └── routes/
│   │       ├── auth.ts       登入、註冊、Google SSO、/config
│   │       ├── data.ts       健康資料上傳與查詢
│   │       └── admin.ts      管理員功能
│   └── data/                 使用者資料（勿上傳至 git）
├── dashboard/                前端 React + Vite + Tailwind
├── Dockerfile                多階段建置
├── .dockerignore
├── .github/workflows/
│   ├── docker-publish.yml    PR 驗證、image 發佈與 GitHub Release
│   └── security.yml          npm audit 與 Gitleaks
├── scripts/release/
│   ├── tag-release.sh        建立並推送 vX.Y.Z 標籤
│   ├── check-version.mjs     檢查標籤與 changelog／SRS 版號一致
│   └── release-notes.mjs     由 changelog.json 產生 Release 內文
└── package.json              根目錄：npm run dev 同時啟動前後端
```

---

## 常用指令

```bash
# 開發
npm run dev          # 同時啟動前後端（建議）
npm run server       # 只啟動後端（port 3001）
npm run frontend     # 只啟動前端（port 5173）
npm run install:all  # 安裝所有相依套件

# 建置
npm run build        # 建置前端 SPA

# Docker
docker build -t nhi-dashboard .
docker run -d -p 3001:3001 -v nhi-data:/app/data nhi-dashboard
```
