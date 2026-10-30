# NHI-FHIR Bridge 本機匯入整合

這個功能在 **Health Passbook Dashboard 的瀏覽器中**處理已下載的 FHIR R4 Bundle JSON，
不直接登入健保署、不取得或儲存健保憑證，也不呼叫 MediPrisma 的雲端服務。

## 操作

1. 在桌面 Chrome 安裝第三方 **NHI-FHIR Bridge（健康懷爾抓抓）**。
   操作與權限見 [官方教學](https://mediprisma.tw/nhi-fhir-bridge/quick-start/)。
2. 自行前往健保署健康存摺網站，完成本人身分驗證。
3. 在 Bridge 選擇資料期間；如需 JPG 預覽圖，依 Bridge 指示啟用影像下載。
4. 下載 FHIR Bundle JSON 至電腦。
5. 登入 Health Passbook Dashboard，點「匯入新資料」，輸入你的**儀表板資料加密密碼**，選取剛下載的 JSON。
6. 在「檢驗」「醫療報告」「用藥」等分頁查看資料。

## 範圍與限制

- 支援 JSON 與 TXT 副檔名，並保留既有健康存摺原生 JSON 匯入。
- FHIR `Encounter`、`Observation`、`DiagnosticReport`、`DocumentReference`、
  `ImagingStudy`、`Immunization`、`MedicationRequest`、
  `MedicationStatement`、`MedicationDispense` 會映射到現有介面；
  其他資源留在加密儲存中，不保證全部有視覺化。
- 只有 FHIR `Attachment.data` 中內嵌的 JPEG、PNG、WebP、PDF 能作為附件顯示或下載；
  不會從第三方網址自動擷取檔案，也不支援外部 DICOM、`Binary/` 指標。
- JPG 是健康存摺的影像**預覽**，不是原始 DICOM 影像。
- 32 MiB 單檔大小限制（傳送時須經 AES-GCM 加密及 Base64 編碼）。
  大影像檔請縮小日期範圍分次匯入；單一附件 Base64 上限 12 MiB。
- 去識別化依 Bridge 設定，**不表示完全匿名**。資料不應提交 GitHub。
- 相同 FHIR resourceType、meta.source 和 id 會去重並在內容變更時更新。
  FHIR 與舊版 NHI JSON 若同時含同一就醫事件，目前不提供跨格式精確去重，
  彙總次數有重複計算風險。
- 已知不同 Patient 識別的 FHIR Bundle 不允許互相合併。若原有資料只有 NHI JSON、
  無 FHIR Patient 識別碼，**仍必須由使用者確認是同一個人**。
- 此版本是手動選檔匯入，不是直接從 Chrome 擴充功能向遠端 Docker 站點傳輸資料。
  Bridge 的自架後端功能針對使用者授權的 localhost／127.0.0.1，不能假設自動支援其他網域。

## 加密

FHIR 原始資源保留在 `cryptoVault.ts` 的 `fhir` 集合中；
瀏覽器使用與既有 NHI JSON 相同的 WebCrypto AES-GCM 加密流程。
伺服器僅儲存加密信封，解密密碼不傳給後端。

## 溯源與授權

- NHI-FHIR Bridge 的擴充功能：<https://mediprisma.tw/nhi-fhir-bridge/intro/>
- MediPrisma Web App（獨立專案）：<https://github.com/MediPrisma/mediprisma-app>
- 本整合的 FHIR parser 與 UI 為獨立實作，沒有複製 MediPrisma 程式碼。
  使用 FHIR R4 標準資料結構，所有醫療紀錄應以原始報告為準。
