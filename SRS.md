# SRS — 健康存摺臨床工作區（MediPrisma 本地複製版）系統需求規格

> 版號：**4.0.0**｜程式基線：MediPrisma/mediprisma-app（master @ `313fe14`，Apache-2.0）本地複製修改版
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
| 建置發佈 | GitHub Actions `docker-publish.yml`：多架構映像（GHCR／Docker Hub）＋GitHub Release；`security.yml` Gitleaks |
| 金鑰管理 | OpenBao（既有實例）：KV v2＋AppRole／GitHub Actions OIDC；`scripts/openbao/*` 讀取／輪換／啟動注入 |
| AI 服務 | 自架 OpenAI 相容端點，經同源 `/api/ai` 代理；金鑰留伺服器端（env 或 OpenBao） |
| 部署 | Zeabur／自架主機 Docker；Watchtower 熱更新（映像含 `com.centurylinklabs.watchtower.enable` 標籤） |

## 3. 功能需求

### 3.1 帳號與登入

- Google 登入（Firebase Auth `GoogleAuthProvider`＋`signInWithPopup`；`GoogleSignInButton`）。
- Email／密碼註冊登入與 Email 驗證。
- Firebase 組態以 `NEXT_PUBLIC_FIREBASE_*` 提供（見 `.env.example`）。

### 3.2 資料匯入

- SMART on FHIR（EHR 啟動與 standalone launch；信任 issuer 預設 localhost，
  正式環境以 `NEXT_PUBLIC_SMART_ALLOWED_ISS` 加入）。
- 本機 FHIR Bundle／健康存摺 SDK JSON 匯入（瀏覽器端加密保存）。
- 本版**不含**任何示範病人／模擬資料。

### 3.3 AI 服務（自架）

- 單一「自有 AI 服務」供應商（OpenAI 相容 chat/completions 等）。
- `NEXT_PUBLIC_AI_SELF_MODEL` 設定上游模型名稱即啟用；`AI_SELF_BASE_URL`＋
  `AI_SELF_API_KEY`（env 或 OpenBao）設定上游；可選 `AI_PROXY_KEY`／
  `NEXT_PUBLIC_AI_PROXY_KEY` 成對閘道驗證。
- `/api/ai/*` 同源代理只放行資料路徑，不是開放中繼。

### 3.4 金鑰管理與輪換

- OpenBao 介接（`openbao/README.md`）：AppRole（容器）與 GitHub Actions OIDC（CI）。
- 自產金鑰**自動輪換**：KV 新版本＋應用端 60 秒 TTL，免重啟生效；
  外部發行金鑰半自動發佈（`rotate-secret.mjs --value`）。
- `NEXT_PUBLIC_*` 建置期烘焙，不列入自動輪換。

## 4. 非功能需求

- 安全：AI 上游金鑰不進入瀏覽器；CSP／安全標頭由 `next.config.ts` 提供；
  Gitleaks 掃描通過（`.gitleaks.toml` 僅精確白名單）。
- 授權：Apache-2.0（LICENSE／NOTICE 歸屬保留）。

## 5. 已排除範圍（4.0.0）

- 全部測試資料、模擬資料、示範病人與其產生器。
- 上游 CI／同步／發佈 workflow（不回傳上游 GitHub）。
- 舊 Health Passbook Dashboard（dashboard/、server/；歷史保留在 main）。

## 6. 外部介面

| 介面 | 說明 |
|---|---|
| `/api/ai/*` | 自架 AI 代理（chat/completions、responses、embeddings、audio/transcriptions、models） |
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
| 4.0.0 | 2026-11-16 | 專案轉換為 MediPrisma 本地複製版：自架 AI 服務＋OpenBao 金鑰管理與自動輪換＋Google 登入；移除測試資料與模擬資料；維持原本 GitHub CI |
