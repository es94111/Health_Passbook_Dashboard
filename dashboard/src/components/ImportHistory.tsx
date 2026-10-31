import { useState } from 'react';
import type { NHIData } from '../parsers/types';

export default function ImportHistory({ data, onImport }: { data: NHIData; onImport: () => void }) {
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState(false);
  async function download(id: string) {
    if (!data.downloadSource) return;
    setDownloading(id);
    setError(false);
    try { await data.downloadSource(id); } catch { setError(true); }
    finally { setDownloading(null); }
  }
  return (
    <section className="space-y-4" aria-label="資料同步與匯入歷程">
      <div className="card p-4 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">資料同步與來源追蹤</h2>
          <button type="button" className="btn-primary" onClick={onImport}>匯入新資料</button>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-300">先在健保署登入並授權 NHI-FHIR Bridge 匯出，再手動匯入 JSON。系統不接收登入憑證，不提供外掛直接同步、外部附件下載或原始 DICOM 取得。</p>
        <p className="text-xs text-gray-500 dark:text-gray-400">歷程與來源檔均隨病歷加密。下載的還原來源檔是未加密 JSON，請妥善保管。系統備份／還原由管理員設定提供，包含加密附件；仍需原資料加密密碼解鎖。</p>
        {data.duplicateCandidateCount > 0 && <p className="text-sm text-amber-700 dark:text-amber-400">偵測到 {data.duplicateCandidateCount} 筆 NHI／FHIR 跨格式疑似重複紀錄。缺少共同紀錄識別碼，已保留兩個來源，請對照原始檔，勿將筆數直接視為不同就診或檢驗次數。</p>}
      </div>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400">來源檔無法還原下載，請檢查附件完整性或重試。既有病歷未變更。</p>}
      {data.importHistory.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">這批既有病歷尚無匯入歷程。後續匯入會記錄格式、時間及處理結果。</p> :
        <ol className="space-y-3">{[...data.importHistory].reverse().map(entry => <li key={entry.id} className="card p-4 space-y-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="font-medium text-gray-900 dark:text-gray-100">{entry.format === 'FHIR' ? 'NHI-FHIR Bridge／FHIR R4' : '健保署原生 NHI JSON'}</h3>
              <p className="text-xs text-gray-500 dark:text-gray-400"><time dateTime={entry.importedAt}>{new Date(entry.importedAt).toLocaleString('zh-TW')}</time> · 來源 {entry.sourceId.slice(0, 12)}</p>
            </div>
            {data.downloadSource && <button type="button" className="btn-secondary text-xs" disabled={downloading !== null} onClick={() => void download(entry.sourceId)}>{downloading === entry.sourceId ? '還原中…' : '下載原始來源 JSON（未加密）'}</button>}
          </div>
          <p className="text-sm text-gray-700 dark:text-gray-200">新增 {entry.added} · 更新 {entry.updated} · 略過 {entry.skipped}</p>
          {entry.identityConfirmed && <p className="text-xs text-amber-700 dark:text-amber-400">病人身分由使用者確認，非自動驗證</p>}
          {entry.warnings.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-700 dark:text-amber-400 space-y-1">{entry.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
        </li>)}</ol>}
    </section>
  );
}
