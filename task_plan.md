# 任務計劃：使用者資料加密儲存

## 目標
將伺服器端所有使用者健康資料（`records-{userId}.json`）改為加密儲存，防止具備檔案系統存取權的攻擊者直接讀取敏感健康記錄。

---

## 現狀分析

| 檔案 | 位置 | 現狀 | 風險 |
|------|------|------|------|
| `records-{userId}.json` | `server/data/` | 明文 JSON | **高** — 含完整健康記錄 |
| `users.json` | `server/data/` | 明文 JSON（密碼已 bcrypt） | 中 — 洩漏使用者名稱清單 |

**核心問題：** `store.ts` 的 `readJson`/`writeJson` 直接讀寫明文，任何人拿到 `data/` 資料夾即可讀取所有健康記錄。

---

## 加密策略（已決策：Option C）

**伺服器主金鑰 + 每使用者鹽值 → AES-256-GCM**

```
ENCRYPTION_KEY (env var, 32 bytes hex)
    ↓ HKDF
per-user key (HKDF with user-specific salt)
    ↓ AES-256-GCM (random IV per write)
encrypted records file
```

- `ENCRYPTION_KEY`：環境變數，必填，無預設值（啟動時強制檢查）
- 每位使用者在 `users.json` 中新增 `encryptionSalt` 欄位（16 bytes hex）
- 每次寫入使用隨機 IV（12 bytes），附 GCM auth tag 防竄改
- 儲存格式：`{ iv, tag, data }` (all hex) — 單一 JSON 包裝層

**選擇理由：**
- 防禦純檔案系統攻擊（攻擊者還需要 env var）
- 每人獨立金鑰（一個使用者洩漏不影響其他人）
- 前端零改動，對 API 層透明
- 不依賴使用者密碼（密碼改變後資料仍可讀）

---

## 實作階段

### Phase 1：加密核心（`server/src/crypto.ts`）
- [ ] 實作 `deriveKey(masterKey, salt)` — HKDF-SHA256
- [ ] 實作 `encryptJson(key, data)` → `{ iv, tag, ciphertext }` hex
- [ ] 實作 `decryptJson(key, envelope)` → parsed object
- [ ] 環境變數驗證（啟動時若無 `ENCRYPTION_KEY` 則報錯退出）

### Phase 2：整合 store.ts
- [ ] `User` 新增 `encryptionSalt?: string` 欄位
- [ ] `createUser()` 時自動產生 salt
- [ ] `getRecords()` 讀取時嘗試解密（自動偵測明文/加密格式，向後相容）
- [ ] `writeJson()` for records 改為加密寫入
- [ ] 現有明文檔案在首次讀取後自動重新加密（遷移）

### Phase 3：強化其他安全性（順手修）
- [ ] `JWT_SECRET` 啟動時若使用預設值則警告（不退出，避免破壞現有部署）
- [ ] `users.json` 加密（可選，優先級較低）

### Phase 4：測試與文件
- [ ] 手動測試：上傳 → 重啟伺服器 → 驗證資料仍可讀
- [ ] 驗證 data/ 目錄下的 JSON 已無法人工閱讀
- [ ] 更新 README/部署說明，說明 ENCRYPTION_KEY 設定方式

---

## 決策記錄

| 決策 | 選項 | 理由 |
|------|------|------|
| 金鑰來源 | 伺服器 env var + per-user salt | 平衡安全性與可操作性 |
| 加密演算法 | AES-256-GCM | Node.js 內建，認證加密防竄改 |
| 金鑰派生 | HKDF-SHA256 | 標準、快速，無需慢速雜湊 |
| 遷移策略 | 首次讀取時自動遷移 | 零停機，不需手動腳本 |
| `users.json` 加密 | 本次不做 | 已有 bcrypt，風險相對低 |

---

## 狀態
- [x] Phase 0：現狀分析完成
- [x] Phase 1：加密核心（crypto.ts）
- [x] Phase 2：整合 store.ts（加解密、遷移）
- [x] Phase 3：其他強化（index.ts 啟動流程）
- [ ] Phase 4：測試與文件

---

## DX Review 發現（/plan-devex-review 2026-04-10）

### 關鍵風險
`server/data/` 包含加密金鑰（`.key`）與加密記錄，若遺失且未設定 `ENCRYPTION_KEY` 環境變數，健康資料**永久無法解密**。目前無任何文件說明此風險。

### 待完成（DX 修復）

#### DX-1：撰寫 README.md（根目錄）
- clone → install:all → npm run dev → 首次登入 → 上傳 NHI JSON
- **⚠️ 備份警告：`server/data/` 含金鑰與加密記錄，務必一起備份**
- env 變數說明（指向 .env.example）
- Google SSO 設定步驟

#### DX-2：撰寫 server/.env.example
```
JWT_SECRET=          # openssl rand -hex 32
ENCRYPTION_KEY=      # openssl rand -hex 32（未設定則自動生成至 server/data/.key）
GOOGLE_CLIENT_ID=    # 選填，啟用 Google SSO
PORT=3001            # 選填
```

#### DX-3：撰寫 dashboard/.env.example
```
VITE_GOOGLE_CLIENT_ID=   # 與 server GOOGLE_CLIENT_ID 相同
```

#### DX-4：JWT_SECRET 預設值啟動警告
在 `server/src/auth.ts` 的 JWT_SECRET 宣告後加入：
```typescript
if (!process.env.JWT_SECRET) {
  console.warn('[auth] ⚠  JWT_SECRET 未設定，使用預設值。請在正式環境設定此變數。');
}
```

#### DX-5：修正 ENCRYPTION_KEY 錯誤訊息
在 `server/src/crypto.ts` 的錯誤訊息加入修復指令：
```
ENCRYPTION_KEY 必須為 64 個 hex 字元（32 bytes）。生成指令：openssl rand -hex 32
```

#### DX-6：根目錄 postinstall（可選）
在根 `package.json` 新增：
```json
"postinstall": "npm install --prefix server && npm install --prefix dashboard"
```
讓 `npm install` 自動安裝所有子目錄相依套件。

### DX Scorecard（修復前 → 修復後）
| 面向 | 修復前 | 修復後 |
|------|--------|--------|
| 新手引導 | 2/10 | 8/10 |
| API/CLI 設計 | 6/10 | 7/10 |
| 錯誤訊息 | 5/10 | 7/10 |
| 文件 | 1/10 | 8/10 |
| 升級路徑 | 5/10 | 6/10 |
| 開發環境 | 7/10 | 8/10 |
| **總體** | **4/10** | **8/10** |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | — |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 1 | issues_found | score: 4/10→8/10, TTHW: 20+min→5min |

**VERDICT:** ENG CLEARED — DX issues found, 6 fixes recommended (DX-1 through DX-6).
