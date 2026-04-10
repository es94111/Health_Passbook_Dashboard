# 研究與發現

## 現有程式碼關鍵路徑

### 資料讀寫流程
```
POST /api/data/upload
  → routes/data.ts: mergeRecords(userId, incoming)
  → store.ts: getRecords() [readJson — 明文]
  → store.ts: writeJson(recordsFile, existing) [明文]

GET /api/data
  → routes/data.ts: getRecords(userId)
  → store.ts: readJson(recordsFile) [明文]
  → flattenRecords() → res.json()
```

### 使用者建立流程
```
POST /api/auth/register
  → createUser({ id, username, passwordHash, isAdmin, createdAt })
  → store.ts: writeJson(users.json, [...users]) [明文]
```

### 已有套件（server/node_modules）
- `jsonwebtoken` ✓
- `bcryptjs` ✓
- Node.js 內建 `crypto` 模組 ✓（AES-GCM、HKDF 均支援）

---

## 關鍵檔案清單

| 檔案 | 需修改 | 說明 |
|------|--------|------|
| `server/src/store.ts` | **是** | 讀寫邏輯需包加/解密層 |
| `server/src/crypto.ts` | **新建** | 加密核心 |
| `server/src/index.ts` | **是** | 啟動時驗證 ENCRYPTION_KEY |
| `server/data/records-*.json` | 自動遷移 | 首次讀取後重寫為加密格式 |
| `server/data/users.json` | **是** | 新增 encryptionSalt 欄位 |

---

## Node.js crypto API 備忘

```ts
// HKDF（金鑰派生）
const key = crypto.hkdfSync('sha256', masterKey, salt, info, 32);

// AES-256-GCM 加密
const iv = crypto.randomBytes(12);
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
const tag = cipher.getAuthTag();

// AES-256-GCM 解密
const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
decipher.setAuthTag(tag);
const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
```

---

## 加密信封格式（儲存在 .json 檔案）

```json
{
  "__enc": true,
  "iv": "<24 char hex>",
  "tag": "<32 char hex>",
  "data": "<hex ciphertext>"
}
```

`__enc: true` 作為格式識別標記，用於向後相容：
- 若讀到此標記 → 解密
- 若讀到舊格式（無此標記）→ 原樣返回並觸發遷移重寫

---

## 潛在問題

1. **salt 遺失**：若 `users.json` 損毀，對應使用者的 records 永遠無法解密。建議備份提示。
2. **ENCRYPTION_KEY 變更**：若環境變數改變，所有資料無法解密。需要 key rotation 流程（本次不做）。
3. **並發寫入**：目前無寫入鎖，多個請求同時上傳可能造成 race condition（既有問題，非本次範圍）。
