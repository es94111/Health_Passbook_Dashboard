# 進度日誌

## 2026-04-10

### 完成
- 分析現有 `store.ts`、`auth.ts`、`index.ts`、`routes/data.ts`
- 確認所有健康資料以明文 JSON 儲存於 `server/data/`
- 決定加密策略：AES-256-GCM + HKDF + 伺服器 env var 主金鑰
- 建立 `task_plan.md`、`findings.md`、`progress.md`

### 完成（實作）
- ✅ 建立 `server/src/crypto.ts`：HKDF 金鑰派生、AES-256-GCM 加解密、金鑰自動生成
- ✅ 修改 `server/src/store.ts`：users.json 加密、records 加密、明文自動遷移
- ✅ 修改 `server/src/index.ts`：async IIFE 包裝啟動流程，呼叫 loadMasterKey()
- ✅ TypeScript 編譯零錯誤（`tsc --noEmit` 通過）

### 注意事項
- `server/data/.key`：自動生成的金鑰檔案，需備份
- 金鑰檔案已在 `.gitignore` 保護的 `server/data/` 目錄下
