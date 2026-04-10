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
- [ ] Phase 1：加密核心
- [ ] Phase 2：整合 store.ts
- [ ] Phase 3：其他強化
- [ ] Phase 4：測試
