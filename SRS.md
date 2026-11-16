# SRS — 健康存摺臨床工作區（MediPrisma 本地複製版）系統需求規格

> 版號：**4.1.0**｜程式基線：MediPrisma/mediprisma-app（master @ `313fe14`，Apache-2.0）本地複製修改版
> 本文件依本 repo 慣例維護版本歷程（8.2）；發版時 `scripts/release/check-version.mjs`
> 會驗證 `changelog.json`、本表與標籤一致。

## 1. 簡介

把跨院病歷整理成看得懂、查得到來源、能接續照護的臨床工作區：整合就診、用藥、檢驗與
臨床文件，提供來源可回查的 AI 摘要、臨床對話與報告解讀。本 repo 為修改版，所有修改
只維護於 es94111/Health_Passbook_Dashboard，不回傳上游。

## 2. 系統架構

| 層 | 說明 |
|---|---|
| 前端＋伺服器 | Next.js 16（`next build --turbopack`，`output: standalone`），容器以 `node server.js` 啟動（PORT=3001） |
| 登入與文件儲存 | Google OIDC（Authorization Code＋PKCE）；本專案 API 驗證並維護 HttpOnly session，使用者、session 與應用文件存於 PostgreSQL |
| 建置發佈 | GitHub Actions `docker-publish.yml`：多架構映像（GHCR／Docker Hub）＋GitHub Release；`security.yml` Gitleaks |
| 金鑰管理 | OpenBao（既有實例）：KV v2＋AppRole／GitHub Actions OIDC；`scripts/openbao/*` 讀取／輪換／啟動注入 |
| AI 服務 | 自架 OpenAI 相容端點，經同源 `/api/ai` 代理；上游金鑰留伺服器端（env 或 OpenBao），請求須有本專案 session |
| 部署 | Node/Docker 自架主機（登入需 PostgreSQL）；Watchtower 熱更新（映像含 `com.centurylinklabs.watchtower.enable` 標籤） |

## 3. 功能需求

### 3.1 帳號與登入

- Google 登入由本專案伺服器實作 OIDC Authorization Code＋PKCE（`/api/auth/google` 與 callback）；不使用 Firebase Auth。
- Google OAuth client secret 由 OpenBao 讀取，Google client ID 與 `APP_BASE_URL` 由伺服器環境設定；正式環境使用 HTTPS。
- 使用者資料與 7 日 session 存於 PostgreSQL；瀏覽器僅持有 HttpOnly、SameSite cookie，登出會撤銷伺服器 session。
- 不提供 Firebase 帳號、Email／密碼或訪客登入的自動遷移；Firebase SDK／設定仍可供選用的外部服務使用，但不構成本專案登入依賴。

### 3.2 資料匯入

- SMART on FHIR（EHR 啟動與 standalone launch；信任 issuer 預設 localhost，
  正式環境以 `NEXT_PUBLIC_SMART_ALLOWED_ISS` 加入）。
- 本機 FHIR Bundle／健康存摺 SDK JSON 匯入（瀏覽器端加密保存）。
- 應用帳號文件與同步資料經同源 `/api/data` 存於 PostgreSQL；不使用 Firebase Auth／Firestore 作為本專案登入或文件儲存後端。
- 本版**不含**任何示範病人／模擬資料。

### 3.3 AI 服務（自架）

- 自架部署使用 OpenAI-compatible 上游（chat/completions 等）；`NEXT_PUBLIC_AI_SELF_MODEL` 設定模型名稱，伺服器端 `AI_SELF_BASE_URL`／`AI_SELF_API_KEY` 或 OpenBao 設定上游。
- `/api/ai/*` 僅允許列出的資料路徑；每個請求必須有本專案 PostgreSQL session，瀏覽器端點限同源，寫入請求須通過 Origin 檢查。
- `AI_PROXY_KEY` 可作額外閘門；配對的 `AI_SELF_PROXY_KEY`／`NEXT_PUBLIC_AI_PROXY_KEY` 會公開在瀏覽器，不能取代 session 或視為秘密。

### 3.4 金鑰管理與輪換

- OpenBao 介接（`openbao/README.md`）：AppRole（容器）與 GitHub Actions OIDC（CI）；應用登入與資料庫預設讀取 `kv/apps/mediprisma/auth` 欄位 `google-client-secret`、`kv/apps/mediprisma/database` 欄位 `url`。
- AI 上游金鑰與 OAuth／資料庫密語由伺服器端讀取；KV 更新後 60 秒快取到期時更新，資料庫連線池會在連線字串變更時重建。
- `NEXT_PUBLIC_*` 建置期烘焙，不可存放秘密；公開的 proxy 配對值不視為安全憑證。外部發行金鑰由部署者在上游更新後寫入 OpenBao。

## 4. 非功能需求

- 安全：AI 上游金鑰不進入瀏覽器；CSP／安全標頭由 `next.config.ts` 提供；
  Gitleaks 掃描通過（`.gitleaks.toml` 僅精確白名單）。
- 授權：Apache-2.0（LICENSE／NOTICE 歸屬保留）。

## 5. 已排除範圍（4.1.0）

- 全部測試資料、模擬資料、示範病人與其產生器。
- 上游 CI／同步／發佈 workflow（不回傳上游 GitHub）。
- 舊 Health Passbook Dashboard（dashboard/、server/；歷史保留在 main）。

## 6. 外部介面

| 介面 | 說明 |
|---|---|
| `/api/auth/google`、`/api/auth/google/callback` | Google OIDC 登入與 callback；以伺服器 session cookie 完成登入 |
| `/api/auth/session`、`/api/auth/logout` | 查詢目前使用者與撤銷登入 session |
| `/api/data` | 經 session 驗證的 PostgreSQL 應用文件 API |
| `/api/ai/*` | 自架 AI 代理（chat/completions、responses、embeddings、audio/transcriptions、models）；要求登入 session |
| `/api/feedback` | 意見回饋（選填 RESEND_API_KEY） |
| `/version.json` | 建置版本資訊（smoke test 檢查點） |

## 7. 驗收基準

- `npm run typecheck`／`npm run lint`（0 錯誤）／`npm run build` 全綠。
- Docker smoke：容器啟動、首頁 doctype、`/version.json` 200。
- Gitleaks 通過；發版 `scripts/release/check-version.mjs` 一致。

## 8. 版本歷程

### 8.2 版本歷程表

| 版號 | 日期 | 說明 |
|---|---|---|
| 4.1.0 | 2026-11-16 | Google 登入改為自架 OIDC＋PostgreSQL session；應用文件與自架 AI 代理使用本專案 session，不依賴 Firebase Auth／Firestore |
| 4.0.2 | 2026-11-16 | Docker 執行期組態注入（Google 登入／自架 AI 以環境變數設定，免重建映像） |
| 4.0.1 | 2026-11-16 | README 增補「專案來源與修改聲明」：補上相對上游 313fe14 的修改清單 |
| 4.0.0 | 2026-11-16 | 專案轉換為 MediPrisma 本地複製版：自架 AI 服務＋OpenBao 金鑰管理與自動輪換＋Google 登入；移除測試資料與模擬資料；維持原本 GitHub CI |
