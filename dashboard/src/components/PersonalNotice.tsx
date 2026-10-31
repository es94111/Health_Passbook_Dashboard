import { usePersonal } from '../personalContext';

/** 個人資料區塊共用的狀態列：唯讀提示、儲存中與儲存失敗訊息。 */
export default function PersonalNotice() {
  const { canEdit, saving, error, clearError } = usePersonal();

  return (
    <>
      {!canEdit && (
        <p className="text-xs text-amber-700 dark:text-amber-400 print:hidden">
          目前為唯讀狀態，請先解鎖加密病歷後才能新增或修改。
        </p>
      )}
      {saving && (
        <p role="status" className="text-xs text-gray-500 dark:text-gray-400 print:hidden">
          儲存中…
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-lg border-l-4 border-red-500 bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300 print:hidden"
        >
          <span>{error}</span>
          <button type="button" onClick={clearError} className="shrink-0 text-xs underline" aria-label="關閉錯誤訊息">
            關閉
          </button>
        </div>
      )}
    </>
  );
}
