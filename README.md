# 醫析 MediPrisma · SMART on FHIR（本地複製版）

**目前版本：4.1.0** — 本 repo 自訂版號（上游識別 0.51.1 之程式基線）。
4.1.0 改為自架 Google OIDC＋PostgreSQL session／文件儲存，登入不再依賴 Firebase Auth；4.0.2 Docker 執行期組態注入；4.0.1 README 增補修改清單；4.0.0 專案轉換為 MediPrisma 本地複製版（自架 AI、OpenBao 金鑰管理與自動輪換、移除測試與模擬資料、維持原本 GitHub CI）。

> ## 專案來源與修改聲明
>
> 本專案複製自 [MediPrisma/mediprisma-app](https://github.com/MediPrisma/mediprisma-app)
> （上游 master @ `313fe14`，2026-11-15 匯入，授權 Apache-2.0），**此為修改版**：
> 所有修改只維護於 [es94111/Health_Passbook_Dashboard](https://github.com/es94111/Health_Passbook_Dashboard)，
> **不會回傳上游 GitHub**（不設定 upstream remote；上游 sync／hmc 發佈 workflow 一律不納入）。
>
> ### 修改清單（相對上游 [MediPrisma/mediprisma-app](https://github.com/MediPrisma/mediprisma-app) master @ `313fe14`）
>
> | 類別 | 修改內容 |
> |---|---|
> | AI 服務 | 改為自架：`MODEL_CATALOG` 收斂為單一「自有 AI 服務」（OpenAI 相容）；新增 `/api/ai/[[...path]]` 同源伺服器代理（base URL＋金鑰以 env／OpenBao 設定，金鑰不進瀏覽器）與 `src/server/ai-self-secrets.ts` |
> | 金鑰管理 | 新增 OpenBao 介接與自動輪換：`scripts/openbao/`（fetch／rotate／entrypoint）、`openbao/` 原則檔與設定文件、`openbao-rotate.yml` 輪換排程、CI 選填以 GitHub OIDC 取映像發佈憑證（見 [`openbao/README.md`](openbao/README.md)） |
> | 移除測試資料 | HPA 驗證資料集、e2e fixtures、`docs/evidence`／`docs/verification` 驗證資料集、`scripts/hpa`／`scripts/experiments` 實驗資料，及其消費者測試套件 |
> | 移除模擬資料 | 示例病人 Bundle（`public/demo`）、demo AI 快照、示範名稱對照表、合成情境頁（`app/dev*`）、demo 產生器與載入入口、SMART 公開沙箱自動啟動 |
> | 登入與帳號資料 | Google OIDC Authorization Code＋PKCE 由本專案 `/api/auth/google` 處理；使用 PostgreSQL 使用者／session 與 HttpOnly cookie，不使用 Firebase Auth 登入 |
> | CI／部署 | 維持本 repo 原本 CI（`docker-publish.yml` 映像發版＋GitHub Release、`security.yml` Gitleaks＋audit）；新增 Dockerfile（Next.js standalone 映像）；上游 sync／hmc／gh-pages 等 11 個 workflow 一律不納入 |
> | 部署組態 | `/app-config.js` 執行期注入 Firebase 選用整合與自架 AI 公開設定；自架登入以 `APP_BASE_URL`／`GOOGLE_CLIENT_ID` 設定，OAuth client secret 與 PostgreSQL URL 可由 OpenBao 提供（見 `.env.example`、[`openbao/README.md`](openbao/README.md)） |
> | 文件 | 依本 repo 慣例以 `changelog.json`／`SRS.md` 維護版號（4.1.x 起）；上游版本識別 0.51.1 記錄於此 |
>
> 以上修改僅維護於本 repo，**不會回傳上游 GitHub**。
>
> 部署：Docker 多架構映像（GHCR／Docker Hub）→ Zeabur／自架主機，Watchtower 熱更新；
> 容器啟動自 OpenBao 注入 runtime 密語、並以環境變數寫入 `/app-config.js` runtime 組態
> （Google 登入與自架 AI 免重建映像即時設定）。環境變數見 `.env.example`。

**把跨院病歷整理成看得懂、查得到來源、能接續照護的臨床工作區。**

MediPrisma 整合就診、用藥、檢驗與臨床文件，提供來源可回查的 AI 摘要、臨床對話與報告解讀。支援醫療人員與民眾兩種閱讀方式，可從 SMART on FHIR 啟動，也能直接匯入本機資料。

[上游線上版](https://mediprisma.tw/app) · [上游 GitHub Pages](https://voho0000.github.io/medical-note-smart-on-fhir/) · [文件索引](docs/README.md) · [協作指南](CONTRIBUTING.md) · [English](#english)

> 上列線上版是上游既有部署，不是本 repo 的自架 Docker 服務；本 repo 的登入需自行部署 Node server＋PostgreSQL，靜態頁面不提供登入 API。

> 功能核對：2026-09-08，依 v0.51.0 與目前 `master` 已提交的實作整理。登入及機構設定會影響可用功能。
>
> 本專案供研究與教學使用，非醫療器材。AI 與規則產出的內容供參考，臨床決策仍須由醫療人員確認。

## 先試用，再接自己的資料

1. 開啟部署的應用（Docker 映像，預設 `http://localhost:3001`），選擇醫療人員或民眾身份。
2. 匯入自己的 FHIR Bundle／健康存摺 SDK JSON（本版已移除內建示範病人與模擬資料）。
3. 從「醫療摘要」掌握重點，再查看原始報告、提出問題或套用摘要範本。

## 主要功能

### 病歷與報告：把資料放回時間與來源中

- **五個資料分頁**：病人資訊、就診紀錄、報告、用藥與文件，集中閱讀跨院資料。
- **累積檢驗報告**：依類別呈現跨日期數值，支援日期範圍、全部日期與類別快速跳轉；標準化檢驗名稱，並保留原始結果文字。
- **臨床報告閱讀**：整理影像、病理、出院病摘等內容；同份報告的相關項目可合併呈現，保留原文供核對。
- **AI 翻譯與解讀**：按需產生中文翻譯與白話說明，與原文對照閱讀。

### 醫療摘要：先看到病程、風險與待確認事項

醫療摘要是載入病人後的預設分頁，整理跨院病程、主動安全提醒、待決定事項、時間軸與資料涵蓋情形。摘要中的來源引用可回查 FHIR 資源；無法對應的引用會標示為未驗證。

- 醫療人員版著重臨床重點；民眾版調整用語，並提供「我的用藥與照護」。
- **自訂摘要模組**可新增、排序、隱藏、手動執行或設定自動生成，也可從提示範本庫加入。
- 透過 **AI 資料範圍**選擇並預覽摘要使用的病歷內容。
- 摘要結果提供展開閱讀與使用引導；生成結果可快取，減少重複請求。

### 臨床對話：依問題查資料、接續追問

- 支援 Agent 工具呼叫，按需查詢病人、診斷、用藥、過敏、檢驗、生命徵象、處置與就診資料。
- 支援透過 Perplexity 搜尋醫學文獻；是否可用取決於所選模型與服務設定。
- 輸入 `/` 套用提示範本，回答後可點選建議問題繼續追問。
- 支援 Whisper 語音口述、一般對話歷史與無痕對話。
- 可選內建模型、自備 API 金鑰，或連接院內／地端 OpenAI-compatible 端點。

### 提示範本庫：讓常用工作可以重複使用

範本可用於臨床對話、自訂摘要，或同時支援兩者。

- 依用途、專科、受眾、分類與關鍵字尋找範本；桌面以表格瀏覽，手機以卡片呈現。
- 支援系統範本、我的範本、收藏與最近使用。
- 預覽提示內容及已提供的輸出範例，套用需要填寫欄位的範本。
- 登入後可分享、管理自己的範本及收藏。
- **科常用範本**依機構／科別成員資格顯示，發布與管理依權限開放。

### 計算、匯出與個人設定

- **醫療計算機**：10 類、58 個臨床評分與公式，包括 eGFR、KFRE、CHA₂DS₂-VASc、Child-Pugh、CURB-65；可依病人檢驗自動帶入支援的數值，附使用說明並可複製結果。
- **IPS 匯出**：建立 International Patient Summary FHIR 文件與 Markdown 預覽；AI 推論的問題清單須逐項確認後才納入。
- **閱讀設定**：中英文、深色模式、字級、響應式版面與功能分頁釘選；醫療人員／民眾身份可切換。

## 資料如何進來

| 來源 | 使用方式 |
|---|---|
| SMART on FHIR | 由 EHR 啟動或 standalone launch，使用 OAuth 2.0 與 PKCE 讀取授權範圍內的 FHIR 資料 |
| 本機 FHIR Bundle | 匯入 `.json`，在瀏覽器中讀取與整理 |
| 健康存摺 SDK JSON | 在瀏覽器轉換為 FHIR，保留轉換來源資訊；SDK JSON 轉換上限為 32 MB |
| 示範病人 | 本版不提供內建病人或模擬資料；請匯入自己的 FHIR Bundle 或 SDK JSON |
| Medcloud 整合 | 配合擴充套件交接資料並執行自動摘要；需要對應的整合環境 |

## AI 服務與資料隱私

自架部署以自有 **OpenAI-compatible** 服務為 AI 上游，經同源 `/api/ai` 代理轉送；上游 URL 與 API 金鑰只由伺服器端讀取，可透過 OpenBao 管理。內建代理、文獻搜尋、語音轉錄等其他連線仍是獨立選用整合，是否可用取決於其服務設定。

對話、醫療摘要與自訂摘要模組會使用目前設定的模型。模型與各功能預設值以 [模型清單](src/shared/constants/ai-models.constants.ts) 為準；自架部署的服務端點、額度及提供者狀態由部署者管理。

| 資料 | 儲存與傳送方式 |
|---|---|
| 本機匯入的完整病歷 | 以 AES-GCM 加密存於瀏覽器 IndexedDB，最長 12 小時；過期於載入時清除，也可手動清除或登出清除 |
| AI 請求 | 所需病歷內容會送至所選服務；自架 AI 經同源 `/api/ai` 代理，需有效的本專案登入 session，且上游金鑰只在伺服器端／OpenBao |
| API 金鑰 | 自架 AI 上游金鑰不送入瀏覽器；其他 BYO 服務依各自連線模式處理，瀏覽器公開的 proxy 配對值不能視為秘密 |
| 登入與應用資料 | Google OIDC 登入由本專案處理；使用者、session 及應用文件透過同源 API 存於 PostgreSQL，不使用 Firebase Auth／Firestore 作為登入或應用文件儲存 |
| 範本與設定 | 登入使用者資料同步至 PostgreSQL；分享範本依公開或科別權限供他人閱讀 |
| 使用統計 | 官方部署啟用 GA4，記錄功能使用事件；不記錄病歷內容、提示詞、AI 回覆或完整啟動網址，使用隨機瀏覽器識別值估算使用情形 |

自訂模型的 Agent 模式通常須先通過使用合成資料的工具呼叫測試，且只取得瀏覽器綁定的 FHIR 工具。北榮受控啟動的院內模型採專用設定；機構憑證不會套用到一般外院路徑。

清除本地資料不會一併刪除 PostgreSQL 中的帳號資料或第三方已收到的請求。登入與應用文件不依賴 Firebase Auth／Firestore；部分選用代理、App Check、分析或外部整合仍可能使用 `.env.example` 所列 Firebase 設定，本專案並非完全移除所有 Firebase SDK／服務。詳見 [隱私政策](PRIVACY_POLICY.md) 與 [安全說明](docs/SECURITY.md)。

## 開發與部署

### 本機啟動

建議使用 **Node.js 24**（與 CI 一致）、npm 與 GitHub CLI。部分 `@voho0000/*` 套件來自 GitHub Packages，需要具有套件讀取權限的 GitHub 帳號。

```bash
git clone https://github.com/es94111/Health_Passbook_Dashboard.git
cd Health_Passbook_Dashboard

npm ci
cp .env.example .env.local
npm run dev
```

不需要 clone 私有 repo 或登入 GitHub 就能安裝、開發與建置。私有 CDSS 套件未安裝時，照護指引入口不顯示；FHIR 匯入、示範資料、報告、AI 摘要與計算機仍可使用。SDK JSON 轉換器已附於 `vendor/`，不需要 SDK repo 權限；若部署未包含這份 artifact，僅接受 FHIR Bundle。個人化衛教內容也由私有套件提供，缺少時保留入口並顯示尚未安裝，不會產生替代建議。

需要完整私有功能的開發者可先 `gh auth login -h github.com`，再執行 `npm run packages:ci`。參見 [套件與權限說明](docs/personalization-private-packages.md)。

開啟 [localhost:3001](http://localhost:3001)。本機 Google 登入與應用文件同步需有可連線的 PostgreSQL（`DATABASE_URL`）及 Google OAuth Web client；也可用 OpenBao 讀取 OAuth client secret 與資料庫連線字串。

### 自架登入與 PostgreSQL 設定

1. 設定 `APP_BASE_URL`（正式環境必須為 HTTPS origin）與 `GOOGLE_CLIENT_ID`。Google OAuth 用戶端的授權重新導向 URI 設為 `${APP_BASE_URL}/api/auth/google/callback`；不需 Firebase Auth。
2. 建立 PostgreSQL 資料庫。應用啟動後會建立所需的使用者、session 與文件表格；使用者資料和雲端範本／對話等應用文件會由同源 `/api/data` API 存取。
3. 建議將下列值存入 OpenBao KV v2（本 repo 的預設路徑）：

   ```bash
   openbao kv put kv/apps/mediprisma/auth google-client-secret="<Google OAuth client secret>"
   openbao kv put kv/apps/mediprisma/database url="postgresql://<user>:<password>@<host>:5432/<database>"
   ```

   容器以 `OPENBAO_ADDR`、`OPENBAO_ROLE_ID`、`OPENBAO_SECRET_ID` 連線；不要把 OAuth client secret 或資料庫密碼提交到 Git。`GOOGLE_CLIENT_SECRET`／`DATABASE_URL` 僅適合本機開發或未啟用 OpenBao 的環境變數備援。

應用登入使用 Google OIDC Authorization Code＋PKCE，並以 HttpOnly、SameSite cookie 維持 PostgreSQL session。登入 API 需要 Node.js standalone server 與 PostgreSQL；GitHub Pages 等靜態匯出無法提供本專案的登入／資料 API。`NEXT_PUBLIC_` 變數會進入瀏覽器程式，不能用來保存私密金鑰。Firebase 組態仍可供選用的 Functions／App Check／外部整合使用，但不提供本專案登入或 PostgreSQL 文件儲存。

### 常用指令

| 指令 | 用途 |
|---|---|
| `npm run dev` | 本機開發，port 3001 |
| `npm run build` | Next.js 正式建置 |
| `npm run build:gh` | GitHub Pages 靜態匯出，base path `/medical-note-smart-on-fhir` |
| `npm run build:mediprisma` | 官網靜態匯出，base path `/app` |
| `npm run lint` | 程式檢查 |
| `npm run typecheck` | 依已安裝套件檢查型別；完整環境仍涵蓋測試 |
| `npm test` | Jest 單元與元件測試 |
| `npm run test:e2e` | Playwright 瀏覽器測試，準備方式見 [E2E 文件](e2e/README.md) |
| `npm run check:lockfile` | 檢查跨平台 lockfile 完整性 |

**依賴維護**：現有套件版本更新使用 `npm run bump:dep -- <package> <version>`；新增／移除或更動依賴樹時使用 `npm run packages:install` 及對應包裝腳本，避免直接 `npm install` 遺失 Linux 所需的 lockfile 項目。詳見 [AGENTS.md](AGENTS.md)。

`master` 的程式變更通過 CI 後，工作流程會部署 GitHub Pages，並在同步憑證已設定時更新 `mediprisma.tw/app`。純 Markdown／文件變更會略過主 CI。靜態網站的安全 response headers 須由託管平台設定，不能依賴 Next.js `headers()`。

### SMART on FHIR 註冊

以 **public client + S256 PKCE** 註冊；本專案不使用 client secret。以下 `<app-url>` 必須包含部署的 base path，例如 `https://mediprisma.tw/app`。

| 項目 | 值 |
|---|---|
| Launch URL | `<app-url>/smart/launch` |
| Redirect URL | `<app-url>/smart/callback` |
| EHR launch scopes | `launch openid fhirUser patient/*.rs online_access` |
| Standalone scopes | `launch/patient openid fhirUser patient/*.rs online_access` |
| Client ID | `NEXT_PUBLIC_SMART_CLIENT_ID`，預設 `my_web_app` |

可用 [SMART Health IT Launcher](https://launch.smarthealthit.org/) 搭配 GitHub Pages Launch URL 測試：

```text
https://voho0000.github.io/medical-note-smart-on-fhir/smart/launch
```

### 技術與擴充位置

採用 **Next.js 16、React 19、TypeScript、Tailwind CSS 4、shadcn/ui、Vercel AI SDK、fhirclient、Firebase 選用整合、PostgreSQL、TanStack Query 與 Zustand**；以 Jest／Testing Library 與 Playwright 驗證。

```text
app/ · features/ · components/   頁面與功能介面
src/application/                使用案例、資料流程與服務組裝
src/core/                       領域模型與介面
src/infrastructure/             FHIR、AI、儲存與外部服務
src/shared/                     共用設定、模型清單與多語系
```

- 資料分頁：[feature-registry.ts](src/shared/config/feature-registry.ts)
- 主功能與受眾設定：[right-panel-registry.ts](src/shared/config/right-panel-registry.ts)
- AI 模型與服務組裝：[模型清單](src/shared/constants/ai-models.constants.ts)、[composition.ai.ts](src/application/composition.ai.ts)

修改介面前請閱讀 [DESIGN.md](DESIGN.md) 與 [AGENTS.md](AGENTS.md)。完整文件由 [docs/README.md](docs/README.md) 進入，包含架構、AI Agent、對話、範本庫、安全與測試說明。

## English

**MediPrisma brings cross-facility records into a clinical workspace with source-linked AI summaries, conversations, and report explanations.** It supports healthcare-professional and patient views, SMART on FHIR launch, local FHIR Bundles, and Taiwan Health Bank SDK JSON imports.

[Upstream app](https://mediprisma.tw/app) · [Upstream GitHub Pages](https://voho0000.github.io/medical-note-smart-on-fhir/) · [Documentation](docs/README.md)

The linked deployments are upstream, not this fork's Docker service. This fork's sign-in requires its own Node server and PostgreSQL; static pages do not provide the login API.

Feature review: **September 8, 2026**, based on v0.51.0 and committed changes on `master`. For research and education; not a medical device. Outputs require clinical review.

### What you can do

- **Read the record:** patient details, encounters, reports, medications, and documents; cumulative laboratory results with date filtering, standardized names, and original result text.
- **Start with a medical summary:** cross-facility history, safety reminders, pending decisions, timeline, and source references. Add reusable custom summary modules and select the data supplied to summaries.
- **Ask clinical questions:** an AI agent can query FHIR resources on demand, with medical-literature search where supported. Prompt shortcuts, follow-up suggestions, voice dictation, and temporary conversations support repeated work.
- **Reuse prompts:** browse, filter, favorite, preview supplied example outputs, fill template fields, and revisit recently used templates. Department templates require membership and publishing permissions.
- **Calculate and export:** 58 clinical calculators across 10 categories, supported laboratory auto-fill, and IPS FHIR export with a Markdown preview. AI-inferred problems require confirmation before inclusion.
- **Adjust the workspace:** clinician/patient audience, Chinese/English interface, dark mode, font size, and pinned feature tabs.

### Data and AI

Local imports are converted and stored in the browser; the full stored Bundle is AES-GCM encrypted with a maximum 12-hour lifetime. **AI features send the required record content to the selected service.** Self-hosted AI uses the same-origin `/api/ai` proxy, authenticated by the app's session; its upstream URL and key stay server-side or in OpenBao. Other Firebase Functions, App Check, and external integrations remain optional and separately configured.

Google sign-in uses this app's Google OIDC flow and PostgreSQL-backed HttpOnly sessions; app-owned documents and signed-in conversations are stored in PostgreSQL through `/api/data`, not Firebase Auth or Firestore. Firebase SDK configuration may still support optional integrations, so the app is not entirely Firebase-free. Official deployments collect allow-listed GA4 usage events without record content, prompts, AI answers, or full launch URLs. Clearing browser data does not delete PostgreSQL data or data already sent to providers. See the [privacy policy](PRIVACY_POLICY.md) and [security notes](docs/SECURITY.md).

Self-hosted deployments use the configured OpenAI-compatible model; optional external integrations have separate service configuration. The [model catalog](src/shared/constants/ai-models.constants.ts) defines defaults; backend configuration and quotas determine actual availability.

### Development

Use Node.js 24 and a GitHub CLI account with access to the project's GitHub Packages. Clone the repository, run `gh auth login -h github.com`, then `npm run packages:ci`. Copy [`.env.example`](.env.example) to `.env.local`, configure the required services, and run `npm run dev` at port 3001.

Use `npm run build:gh` or `npm run build:mediprisma` for static exports; these static builds do not provide the self-hosted Google login or PostgreSQL APIs, which require the Node server deployment. Register SMART as a public client with S256 PKCE; launch and callback URLs must include the deployment base path. Dependency changes should follow [AGENTS.md](AGENTS.md) to preserve cross-platform lockfile entries. Backend Functions and Rules live in [firebase-smart-on-fhir](https://github.com/voho0000/firebase-smart-on-fhir).

## 作者與授權 · Author & License

**郭宜欣醫師｜臺北榮總醫療人工智慧發展中心**

Yi-Hsin Kuo, MD · Taipei Veterans General Hospital

聯絡：[voho0000@gmail.com](mailto:voho0000@gmail.com)。問題與建議可透過 [GitHub Issues](https://github.com/voho0000/medical-note-smart-on-fhir/issues) 或 App 內回報功能提出。

本專案採 [Apache License 2.0](LICENSE)。作者與貢獻署名見 [NOTICE](NOTICE)。

再散布本專案或衍生作品時，請依 Apache 2.0 第 4 條提供授權副本、標示檔案修改，並保留適用的版權與署名資訊。NOTICE 中適用的署名可依第 4(d) 條保留於 NOTICE、原始碼、文件或適當的介面中。

Authorship and contributor credits are recorded in [NOTICE](NOTICE). When redistributing this project or derivative works, follow Section 4 of the [Apache License 2.0](LICENSE), including its requirements for license copies, modification notices, and applicable attribution notices.
