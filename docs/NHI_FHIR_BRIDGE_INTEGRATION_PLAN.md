# Health Passbook Dashboard × NHI-FHIR Bridge 整合開發計畫書

> 版本：1.0（2026-10-30）  
> 狀態：開發計畫／待驗收，不代表所有功能已正式發布  
> 目標儲存庫：[es94111/Health_Passbook_Dashboard](https://github.com/es94111/Health_Passbook_Dashboard)  
> 參考專案：[MediPrisma/mediprisma-app](https://github.com/MediPrisma/mediprisma-app)  
> 現有實作：[Draft PR #59](https://github.com/es94111/Health_Passbook_Dashboard/pull/59)

## 1. 專案目的

將使用者**自行登入**健保署「健康存摺」後，經由 **NHI-FHIR Bridge Chrome 擴充功能**取得的 FHIR R4 Bundle JSON，整合至 Health Passbook Dashboard；保留現有健保署原生 JSON 匯入、帳號及瀏覽器端加密儲存方式。新增檢驗、醫療報告、影像預覽、用藥及資料來源追蹤能力。

核心原則：**不要求官方健康存摺 SDK、不接收健保登入密碼、不繞過身分驗證、不由 Docker 後端登入健保署。**

### 1.1 已確認的來源與邊界

- NHI-FHIR Bridge（健康懷爾抓抓）是**Chrome 擴充功能**；MediPrisma Web App 是另一個獨立專案。不能將 Web App 原始碼等同擴充功能原始碼。
- Bridge 官方文件說明：使用者在 Chrome 登入健康存摺後，可將資料轉成 FHIR R4 Bundle JSON 並下載，或在授權後直接帶入 MediPrisma。
- Bridge 的影像選項提供健康存摺的 **JPG 預覽圖**，**不是 DICOM 原始醫學影像**。
- 官方隱私說明中，擴充功能的自架後端上傳路徑使用 `localhost` / `127.0.0.1` 的選用權限；直接交付到 MediPrisma 需要該網站特定授權。**不能據此推定**原版 Bridge 可直接推送到任意 Health Passbook Dashboard 遠端網域。
- 本專案目前 `dashboard/src/cryptoVault.ts` 以瀏覽器端 AES-GCM 加密健康資料，伺服器保留加密信封；任何新增匯入流程必須維持此安全邊界。

### 1.2 不屬於第一版範圍

- 自動輸入健保帳密、破解 CAPTCHA、長期持有健保登入 Cookie／bearer token、無人值守定時下載。
- 官方 SDK 申請、直接調用未確認開放的健保署 API。
- 保證下載健保署未提供的完整醫院病歷、原始 DICOM、所有影像檔或所有日期資料。
- AI 病歷解讀、診斷建議、直接與外部雲端醫療平台同步。
- 原版 Bridge 擴充功能直接無感上傳至外部部署的 Dashboard（須獨立研究與授權）。

## 2. 系統架構與資料流程

```text
使用者電腦 / Chrome
   ├─ 自行登入 myhealthbank.nhi.gov.tw
   └─ NHI-FHIR Bridge（使用者明確觸發取得／匯出）
         ↓  FHIR R4 Bundle .json
Health Passbook Dashboard（既有 React / Vite SPA）
   ├─ 檔案驗證：FHIR Bundle / NHI 原生 JSON
   ├─ Patient 歸屬確認、資源完整性與安全檢查
   ├─ 合併、去重、更新、資料來源追蹤
   ├─ 檢驗／就醫／用藥／報告／影像預覽
   └─ WebCrypto AES-GCM 加密
         ↓  僅傳輸加密信封
既有 Express API + 使用者加密紀錄儲存（Docker Volume）
```

不得將健康存摺帳號、密碼、驗證資訊、明文完整 FHIR Bundle 或未加密影像檔寫入伺服器 log、analytics、Git、CI artifact 或事故回報。使用者上傳前應有來源及個人身分確認。

## 3. 功能需求（FR）

| 編號 | 功能 | 驗收條件 |
| --- | --- | --- |
| FR-01 | 匯入原生 NHI JSON 與 FHIR R4 Bundle JSON | 能正確辨識格式；既有匯入路徑不退化 |
| FR-02 | FHIR 基本驗證 | 無效 JSON、非 Bundle、缺失 entry、不合預期內容應有明確錯誤，不能當成成功 |
| FR-03 | 病人身分隔離 | 同 Bundle 多名 Patient 應拒絕或導向逐人選擇；跨匯入病人不一致時必須拒絕並明確提示 |
| FR-04 | FHIR 資源儲存與溯源 | 保存來源標識及原始資源；避免無法還原的資料遺失 |
| FR-05 | 去重及更新 | 重複匯入不增加相同資源；同 id 改版有更新紀錄，必要時支援 rollback |
| FR-06 | 檢驗結果 | Observation 數值、單位、參考區間、文字結果、時間、院所與 abnormal flag（有提供時）可呈現；不能將不同單位直接繪製到同一尺度 |
| FR-07 | 就醫與用藥 | Encounter／Medication* 可瀏覽；對「處方／領藥／實際服用」保留不同語義 |
| FR-08 | 報告 | DiagnosticReport／DocumentReference 保留原文、檢查日期、來源及附件對應 |
| FR-09 | 影像附件 | 僅安全顯示可驗證的內嵌圖片／PDF；其他連結只顯示資訊，不自動發出外部請求 |
| FR-10 | 匯入結果 | 顯示新增、更新、重複、無法解析及跳過的資源數與原因 |
| FR-11 | 加密儲存 | 資料加密密碼不送至後端；伺服器儲存的仍是加密信封 |
| FR-12 | 選擇性匯入與復原 | 解析前預覽摘要、確認病人及資料範圍；失敗不覆蓋既有紀錄，匯入後可回復備份 |

## 4. 分階段工作與交付

### P0 — 格式確認與安全匯入（首要）

**工作**：驗證 Bridge 實際 FHIR Bundle 輸出（只使用去識別化或合成測資）；導入 parser、格式檢測與錯誤訊息；保留原生 JSON 匯入。辨識 Patient、Encounter、Observation、DiagnosticReport、DocumentReference、Immunization 及 Medication 資源；不識別的資源保留原文但不誤顯示。

**程式範圍**：`dashboard/src/components/FileLoader.tsx`、`dashboard/src/parsers/fhir-parser.ts`、`dashboard/src/parsers/nhi-parser.ts`、`dashboard/src/cryptoVault.ts`。

**完成標準**：合成測試通過、NHI 舊格式不回歸、有效 FHIR 匯入後重新登入仍可解密顯示；錯誤輸入不修改既有資料。

### P1 — 醫療資料展示與品質

**工作**：增補檢驗單位、文字型結果、參考範圍與異常標記；用藥與就醫資料區分資料來源；建立醫療報告列表、全文檢視與跨來源時間軸。避免將相同事件的 NHI 舊格式和 FHIR 自動累加為兩次計數；先提供跨來源疑似重複警示，通過實例對照後才實作自動合併。

**程式範圍**：`dashboard/src/parsers/types.ts`、`dashboard/src/components/LabTrendCharts.tsx`、`MedicalReportList.tsx`、`MedicationList.tsx`、`App.tsx`。

**完成標準**：針對數值與非數值檢驗、相同名稱不同單位、重複 Encounter、同筆報告更新有固定測試；每筆報告可回查原始 FHIR resource id 與來源。

### P2 — 醫療影像與大檔案

**工作**：處理 Bridge 內嵌的 JPEG 預覽圖及支援的 PDF，驗證 MIME／Base64／大小限制。優先將影像從大型 JSON 分離成**獨立且加密的附件儲存**，以內容雜湊及 report id 建立索引、加密備份與還原。不得隨意將 `DocumentReference.content.attachment.url` 或 `Binary/*` 視為公開檔案 URL。

**完成標準**：無影像匯入與大量影像匯入均正常；來源錯誤、非支援 MIME、大檔案、重複影像、資料遺失或還原失敗皆有明確處理；原始 DICOM 不宣稱已支援。

### P3 — 操作體驗／進階直接帶入（選配）

**第一步**：UI 提供 Bridge 安裝連結、登入與下載操作教學、同步日期與來源資訊、匯入紀錄。維持使用者自行匯出後手動匯入的穩定流程。

**研究階段**：如需減少手動選檔，另外評估本機受限代理或自行維護的 Chrome 擴充功能之通訊規格。必須在瀏覽器明確使用者操作及授權後交付 FHIR，核對 Chrome `host_permissions`、CORS、來源驗證、CSRF、防重播、API 驗證金鑰、使用者綁定與 end-to-end 加密；不得假設原版 Bridge 支援任意網域直接交付。

**完成標準**：只有通過權限模型、安全審查、跨裝置限制說明及使用者確認後，才將直接帶入功能列為正式交付。

## 5. 資料模型與合併規則

- 維持既有 `r1/r2/r3/r6/r7/r8` NHI 原生資料；新增 `fhir` 原始資源集合並保留 source、resourceType、id、版本及匯入時間。
- 對有穩定 resource id 的記錄，以（資料來源、resourceType、id）為去重主鍵；遇到重複 id 但內容變動時保留更新紀錄；id 缺失時不可僅靠容易碰撞的簡單 hash 進行臨床資料去重。
- 針對 Patient 缺失、去識別化變動、姓名／身分證遭遮罩、眷屬切換等場景設保守的歸屬檢查；無法確認同一病人時暫停匯入，不進行靜默合併。
- 單位不同的檢驗不可直接畫同一條數值曲線；保留 `valueString`、`valueCodeableConcept` 與來源資料，不得以 `parseFloat` 丟棄文字結果。
- 報告與附件索引以 `DiagnosticReport`／`DocumentReference` resource identity、日期和附件雜湊為主；影像預覽的存在不等於原始 DICOM 可得。

## 6. 安全與隱私規格（必備）

1. 使用者自行登入健保署，系統不可記錄登入密碼、身分驗證碼、Cookie、bearer token。
2. 僅於使用者明確操作時匯入個人合法可查看的健康資料；不繞過官方權限控制。
3. FHIR 原始檔在瀏覽器驗證／合併／加密；後端不得因為新增同步功能而改成接收明文。
4. 醫療資料、病人識別資訊、影像、例外堆疊與檔名不得寫入前後端日誌、第三方分析或公開 repo。
5. 大型影像要有上限、取消、錯誤回復、加密備份；不要以 Base64 永久內嵌至單一無界 JSON。
6. 每次匯入必須對使用者顯示資料來源與病人歸屬，避免跨帳戶或眷屬混檔。
7. 所有 `Attachment.url`、`text.div` 等外部／半結構化內容，應避免 XSS、SSRF 或無意傳輸 PHI；只顯示經淨化文本與受控 MIME。
8. 保留既有 Key、加密信封與備份復原能力，新增欄位需可向後相容舊檔案。

## 7. 測試與驗收清單

| 類別 | 必測情境 | 通過定義 |
| --- | --- | --- |
| 格式 | 合法 FHIR、合法 NHI、破損 JSON、缺 entry、空 Bundle、未知 resource | 合法可匯入；非法明確拒絕且不污染舊資料 |
| 資料 | 數值／文字檢驗、component、多單位、報告改版、處方與領藥 | 語義正確，不丟失原文及來源 |
| 病人隔離 | 同一人多次匯入、不同人、眷屬、缺 Patient、重新去識別化 | 不會未經確認合併不同人的資料 |
| 去重 | 同一 JSON 重匯、交疊時間範圍、跨來源同一事件 | 相同資源不重複；跨格式差異清楚揭露 |
| 影像 | JPG／PNG／PDF、超過大小、損壞 Base64、非受信 URL | 安全顯示／下載，失敗可恢復 |
| 安全 | 登出／重新登入、錯密碼、跨使用者、存檔與備份還原 | 無明文外洩、無跨帳戶存取 |
| CI | TypeScript build、Vitest、lint、依賴與安全掃描 | 必要檢查皆綠燈、可追溯日志 |
| E2E | Chrome Bridge 匯出 **去識別化** 真實樣本，匯入測試站 | 能顯示數值、報告、影像預覽與增量匯入結果 |

**禁止**將真實身分證號、醫療影像或未去識別健康資料作為公開測試 fixture、Issues 附件或 PR 截圖。

## 8. 目前實作現況（截至 2026-10-30）

現有 Draft PR #59 已在獨立分支增加 FHIR parser、資料模型、加密合併支援、基本報告／用藥 UI、匯入說明、合成測試與 CI workflow。

**未完成／未通過驗收**：
- 尚未取得真實 Bridge 去識別化測資的端到端驗證。
- 首次 GitHub Actions「Dashboard Build and FHIR Import Tests」與「Security Checks」標示為 failure；job 沒有提供可辨認的執行步驟，當前無法確定是環境／權限／額度或程式問題，**不可宣稱 CI 已通過**。
- 完整病人身分歸屬、跨格式事件去重、附件拆分加密儲存、FHIR 全欄位精準映射尚未達成。
- 影像支援限於合格內嵌資料；**未**支援原始 DICOM 或 Bridge 到遠端 Docker Dashboard 直接同步。

### 發版 Gate（全部達成才可將 Draft 轉 Ready / Merge）

- [ ] CI build、測試及安全掃描可執行且通過。
- [ ] 原生 NHI JSON 向後相容測試及既有帳號／備份還原測試通過。
- [ ] 測資完整性、病人歸屬、來源／單位、去重功能經驗證。
- [ ] 實際去識別 Bridge 匯出檔成功走完匯入、加密、重登入、檢視。
- [ ] 確認醫療影像的檔案大小、附件格式與儲存方式。
- [ ] 無明文敏感資料／憑證出現在儲存、log、CI artifact 和程式碼。
- [ ] 審查完畢後才手動合併至 `main`，不啟用無條件 auto-merge。

## 9. 參考資料

- [Bridge 快速開始](https://mediprisma.tw/nhi-fhir-bridge/quick-start/)
- [Bridge 隱私政策與權限](https://mediprisma.tw/nhi-fhir-bridge/privacy/)
- [Bridge 使用者安全說明](https://mediprisma.tw/nhi-fhir-bridge/security-for-users/)
- [MediPrisma Web App](https://github.com/MediPrisma/mediprisma-app)
- [目前 Draft PR #59](https://github.com/es94111/Health_Passbook_Dashboard/pull/59)
