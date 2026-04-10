# 健康存摺儀表板

台灣健保健康存摺（NHI）個人健康資料視覺化儀表板。

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
2. 登入後點選「上傳」，選擇從健保快易通 App 匯出的 JSON 檔案
3. 資料匯入後即可瀏覽儀表板

---

## ⚠️ 重要：備份加密金鑰

`server/data/` 目錄包含：
- `users.json` — 加密的帳號資料
- `records-{userId}.json` — 加密的健康記錄
- `.key` — **主加密金鑰**

**若 `.key` 檔案遺失，且未設定 `ENCRYPTION_KEY` 環境變數，所有健康資料將永久無法解密。**

Docker 部署時務必掛載 Volume，並定期備份。

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

# dashboard/.env.local
VITE_GOOGLE_CLIENT_ID=你的用戶端ID
```

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

推送到 `main` 分支或建立 `v*` 標籤時，自動建置並推送至 Docker Hub 與 GitHub Container Registry。

### 設定 GitHub Actions Secrets

前往 GitHub repo → Settings → Secrets and variables → Actions：

| Secret 名稱 | 說明 |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub 帳號 |
| `DOCKERHUB_TOKEN` | Docker Hub Access Token（非密碼） |

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
│   └── docker-publish.yml    自動建置推送 Docker image
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
