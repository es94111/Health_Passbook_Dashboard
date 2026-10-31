import type { ImportPreview as Preview } from '../importPreview';
import { formatBytes } from '../lib/bytes';

interface Props {
  preview: Preview;
  identityConfirmed: boolean;
  onIdentityConfirmed: (confirmed: boolean) => void;
  onConfirm: () => void;
  onCancel: () => void;
  /** 密碼長度不足時不可送出。 */
  blocked: boolean;
}

function dateRange(from: string | null, to: string | null): string {
  if (!from && !to) return '檔案沒有可辨識的日期';
  if (!from || from === to) return from ?? to ?? '';
  return `${from} ～ ${to}`;
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 px-3 py-2">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-gray-900 dark:text-gray-100 break-words">{value}</dd>
      {hint && <dd className="mt-0.5 text-xs text-gray-400 dark:text-gray-500">{hint}</dd>}
    </div>
  );
}

export default function ImportPreview({
  preview,
  identityConfirmed,
  onIdentityConfirmed,
  onConfirm,
  onCancel,
  blocked,
}: Props) {
  const { counts, attachments } = preview;
  const exact = !preview.estimated;
  const canConfirm = !blocked && (!preview.needsConfirmation || identityConfirmed);

  return (
    <section
      aria-label="匯入前資料摘要"
      className="mb-4 rounded-xl border border-teal-200 dark:border-teal-800 bg-white dark:bg-gray-800 p-4 text-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium text-gray-900 dark:text-gray-100">匯入前確認資料內容</h2>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {preview.format === 'FHIR' ? 'FHIR R4 Bundle' : '健保署原生 NHI JSON'}
          {preview.estimated ? '・大型檔案串流估算' : '・精確統計'}
        </span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 break-all">
        {preview.fileName}（{formatBytes(preview.fileSize)}）
      </p>

      <dl className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Stat label="資料日期" value={dateRange(preview.from, preview.to)} />
        <Stat
          label="檔案內紀錄"
          value={`${counts.incoming.toLocaleString()} 筆`}
          hint={exact ? undefined : '以串流掃描估算，實際以匯入結果為準'}
        />
        <Stat label="目前既有紀錄" value={`${preview.existingTotal.toLocaleString()} 筆`} />
        <Stat
          label="匯入後總筆數"
          value={preview.totalAfter === null ? '匯入後計算' : `${preview.totalAfter.toLocaleString()} 筆`}
          hint={exact ? undefined : '需完成匯入才能確定新增與略過筆數'}
        />
      </dl>

      {exact && (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <span className="rounded-md bg-teal-50 dark:bg-teal-950/40 px-2 py-1 text-teal-800 dark:text-teal-300">
            新增 {counts.added ?? 0}
          </span>
          <span className="rounded-md bg-blue-50 dark:bg-blue-950/40 px-2 py-1 text-blue-800 dark:text-blue-300">
            更新 {counts.updated ?? 0}
          </span>
          <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-2 py-1 text-gray-600 dark:text-gray-300">
            略過（已存在） {counts.skipped ?? 0}
          </span>
        </div>
      )}

      {preview.rows.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-gray-500 dark:text-gray-400">
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th scope="col" className="py-1 text-left font-medium">類別</th>
                <th scope="col" className="py-1 text-right font-medium">檔案筆數</th>
                {exact && <th scope="col" className="py-1 text-right font-medium">新增</th>}
                {exact && <th scope="col" className="py-1 text-right font-medium">更新</th>}
                {exact && <th scope="col" className="py-1 text-right font-medium">略過</th>}
              </tr>
            </thead>
            <tbody className="text-gray-800 dark:text-gray-200">
              {preview.rows.map(row => (
                <tr key={row.key} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                  <th scope="row" className="py-1 text-left font-normal">{row.label}</th>
                  <td className="py-1 text-right tabular-nums">{row.incoming}</td>
                  {exact && <td className="py-1 text-right tabular-nums">{row.added ?? 0}</td>}
                  {exact && <td className="py-1 text-right tabular-nums">{row.updated ?? 0}</td>}
                  {exact && <td className="py-1 text-right tabular-nums">{row.skipped ?? 0}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {preview.resourceTypes.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300">FHIR 資源組成</h3>
          <div className="mt-1 flex flex-wrap gap-1 text-xs">
            {preview.resourceTypes.slice(0, 12).map(item => (
              <span key={item.type} className="rounded-md border border-gray-200 dark:border-gray-700 px-2 py-0.5 text-gray-600 dark:text-gray-300">
                {item.label} {item.count}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="mt-3 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
        <h3 className="text-xs font-medium text-gray-700 dark:text-gray-300">影像與附件</h3>
        {attachments.total === 0 && attachments.references === 0 && attachments.external === 0 ? (
          <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
            這份檔案沒有內嵌影像或附件。
          </p>
        ) : (
          <ul className="mt-1 space-y-1 text-xs text-gray-600 dark:text-gray-300">
            <li>含影像／附件的報告：{attachments.reports} 份</li>
            <li>影像類報告：{attachments.imagingReports} 份</li>
            <li>
              內嵌附件：{attachments.total} 個
              {attachments.total > 0 && `（可預覽 ${attachments.previewable} 個）`}
            </li>
            {attachments.external > 0 && <li>外部連結附件（不下載內容）：{attachments.external} 個</li>}
            {attachments.references > 0 && <li>以參考連結的附件（匯入後解析）：{attachments.references} 個</li>}
            {attachments.unsupported.length > 0 && (
              <li className="text-amber-700 dark:text-amber-400">
                瀏覽器無法預覽的格式：{attachments.unsupported.join('、')}
              </li>
            )}
          </ul>
        )}
      </div>

      {preview.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-amber-700 dark:text-amber-400">
          {preview.warnings.map(warning => <li key={warning}>・{warning}</li>)}
        </ul>
      )}

      {preview.needsConfirmation && (
        <label className="mt-3 flex items-start gap-2 text-xs text-gray-800 dark:text-gray-200">
          <input
            type="checkbox"
            checked={identityConfirmed}
            onChange={event => onIdentityConfirmed(event.target.checked)}
            className="mt-0.5 accent-teal-600"
          />
          我已核對，確定此檔案與本帳號既有資料屬於同一人，並同意合併
        </label>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!canConfirm} onClick={onConfirm} className="btn-primary">
          確認匯入
        </button>
        <button type="button" onClick={onCancel} className="btn-secondary">
          取消匯入
        </button>
      </div>
      {blocked && (
        <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">請先輸入符合長度要求的資料加密密碼。</p>
      )}
    </section>
  );
}
