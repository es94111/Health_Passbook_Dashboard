# 健康存摺儀表板

台灣健保健康存摺（NHI）個人健康資料視覺化儀表板。

## 快速開始

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

1. 前往 `http://localhost:5173`，點選「註冊」建立帳號
   - 第一個註冊的帳號自動成為管理員
2. 登入後點選「上傳」，選擇從健保快易通 App 匯出的 JSON 檔案
3. 資料匯入後即可瀏覽儀表板

---

## ⚠️ 重要：備份 server/data/

`server/data/` 目錄包含：
- `users.json` — 加密的帳號資料
- `records-{userId}.json` — 加密的健康記錄
- `.key` — **主加密金鑰**

**若 `.key` 檔案遺失，且未設定 `ENCRYPTION_KEY` 環境變數，所有健康資料將永久無法解密。**

請定期備份整個 `server/data/` 目錄，並妥善保管。

---

## 環境變數（server）

詳見 [server/.env.example](server/.env.example)。

| 變數 | 說明 | 預設值 |
|------|------|--------|
| `JWT_SECRET` | JWT 簽名金鑰，正式環境務必設定 | 內建預設值（不安全） |
| `ENCRYPTION_KEY` | 64 char hex 主加密金鑰 | 自動生成並存入 `server/data/.key` |
| `GOOGLE_CLIENT_ID` | Google OAuth 用戶端 ID（選填） | — |
| `PORT` | 後端監聽埠號 | `3001` |

---

## Google SSO 設定（選填）

1. 前往 [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
2. 建立「OAuth 2.0 用戶端 ID」，類型選「網頁應用程式」
3. 授權 JavaScript 來源加入 `http://localhost:5173`
4. 複製用戶端 ID，填入：
   - `server/.env` → `GOOGLE_CLIENT_ID=...`
   - `dashboard/.env.local` → `VITE_GOOGLE_CLIENT_ID=...`
5. 重新啟動 `npm run dev`

---

## 目錄結構

```
/
├── server/          後端 Express + TypeScript
│   ├── src/
│   │   ├── index.ts     伺服器入口
│   │   ├── store.ts     資料讀寫（AES-256-GCM 加密）
│   │   ├── crypto.ts    加密核心
│   │   └── routes/      API 路由
│   └── data/        ← 使用者資料（勿上傳至 git）
├── dashboard/       前端 React + Vite + Tailwind
└── package.json     根目錄：npm run dev 同時啟動前後端
```

---

## 常用指令

```bash
npm run dev          # 同時啟動前後端（建議）
npm run server       # 只啟動後端
npm run frontend     # 只啟動前端
npm run install:all  # 安裝所有相依套件
npm run build        # 建置前端
```
