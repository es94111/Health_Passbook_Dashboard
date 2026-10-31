import { useState, useCallback, useEffect, useRef } from 'react';
import type { ClientEncryptedRecords, UploadResult } from '../api';
import type { NHIData } from '../parsers/types';
import { PatientConfirmationRequired, validateVaultPassphrase, VAULT_PASSPHRASE_MIN_LENGTH } from '../cryptoVault';
import { commitLargeImport, importHealthData, migrateHealthData, prepareLargeImport, unlockHealthData, type LargeImportPreview } from '../importHealthData';
import { MAX_IMPORT_BYTES } from '../medicalAttachments';

interface Props {
  onLoad: (data: NHIData) => void;
  storedEnvelope: ClientEncryptedRecords | null;
  needsClientEncryptionMigration: boolean;
  onEnvelopeSaved: (envelope: ClientEncryptedRecords) => void;
}

function HeartbeatIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12 text-teal-600 dark:text-teal-400" aria-hidden="true">
      <path
        d="M24 38s-14-8.5-14-18a8 8 0 0 1 14-5.3A8 8 0 0 1 38 20c0 9.5-14 18-14 18z"
        fill="currentColor"
        fillOpacity="0.15"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M6 24h6l4-8 4 16 4-10 3 6h9"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Status = 'idle' | 'uploading' | 'migrating' | 'loading' | 'confirming' | 'error';

function importError(error: unknown): string {
  if (error instanceof SyntaxError) return 'JSON 格式無法解析，請重新匯出原始檔案';
  if (error instanceof Error && error.name === 'OperationError') return '無法解密資料，請確認資料加密密碼或由備份還原';
  return error instanceof Error ? error.message : '匯入失敗，既有資料未變更';
}

export default function FileLoader({
  onLoad,
  storedEnvelope,
  needsClientEncryptionMigration,
  onEnvelopeSaved,
}: Props) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [pendingJson, setPendingJson] = useState<object | null>(null);
  const [pendingLarge, setPendingLarge] = useState<LargeImportPreview | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), []);

  const loadStored = useCallback(async (migrate: boolean) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setStatus(migrate ? 'migrating' : 'loading');
    setError(null);
    setPendingJson(null);
    try {
      const loaded = migrate ? await migrateHealthData(passphrase, controller.signal) : await unlockHealthData(passphrase, controller.signal);
      if (controller.signal.aborted) return;
      onEnvelopeSaved(loaded.envelope);
      onLoad(loaded.data);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(importError(err));
      setStatus('error');
    }
  }, [onEnvelopeSaved, onLoad, passphrase]);
  const unlockStoredData = () => loadStored(false);
  const migrateLegacyData = () => loadStored(true);

  const processJson = useCallback(async (json: object, confirmed = false) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setStatus('uploading');
    setError(null);
    setUploadResult(null);
    setPendingJson(null);
    try {
      const imported = await importHealthData(json, passphrase, confirmed, controller.signal);
      if (controller.signal.aborted) return;
      setUploadResult(imported.result);
      onEnvelopeSaved(imported.envelope);
      setStatus('loading');
      onLoad(imported.data);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof PatientConfirmationRequired) {
        setPendingJson(json);
        setIdentityConfirmed(false);
        setStatus('confirming');
      } else {
        setError(importError(err));
        setStatus('error');
      }
    }
  }, [onEnvelopeSaved, onLoad, passphrase]);

  const processLarge = useCallback(async (preview: LargeImportPreview, confirmed = false) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setStatus('uploading');
    setError(null);
    setUploadResult(null);
    setPendingLarge(null);
    setProgress(0);
    try {
      const imported = await commitLargeImport(preview, passphrase, confirmed, controller.signal, ratio => setProgress(ratio));
      if (controller.signal.aborted) return;
      setUploadResult(imported.result);
      onEnvelopeSaved(imported.envelope);
      setStatus('loading');
      onLoad(imported.data);
    } catch (err) {
      if (controller.signal.aborted) return;
      if (err instanceof PatientConfirmationRequired) {
        setPendingLarge(preview);
        setIdentityConfirmed(false);
        setStatus('confirming');
      } else {
        setError(importError(err));
        setStatus('error');
      }
    } finally {
      if (!controller.signal.aborted) setProgress(null);
    }
  }, [onEnvelopeSaved, onLoad, passphrase]);

  const processFile = useCallback(async (file: File) => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    setPendingJson(null);
    setPendingLarge(null);
    setIdentityConfirmed(false);
    setStatus('uploading');
    setError(null);
    try {
      validateVaultPassphrase(passphrase);
      if (file.size > MAX_IMPORT_BYTES) {
        setProgress(0);
        const preview = await prepareLargeImport(file, passphrase, controller.signal, ratio => setProgress(ratio));
        if (controller.signal.aborted) return;
        setProgress(null);
        if (preview.needsConfirmation) {
          setPendingLarge(preview);
          setIdentityConfirmed(false);
          setStatus('confirming');
          return;
        }
        await processLarge(preview);
        return;
      }
      const text = await file.text();
      if (controller.signal.aborted) return;
      const json: unknown = JSON.parse(text.replace(/^\uFEFF/, ''));
      if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('JSON 根節點必須是物件');
      await processJson(json);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(importError(err));
      setStatus('error');
    }
  }, [passphrase, processJson, processLarge]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) { void processFile(file); }
    e.target.value = '';
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (busy) return;
    const file = e.dataTransfer.files?.[0];
    if (file) { void processFile(file); }
  }

  const confirmImport = () => {
    if (pendingJson) void processJson(pendingJson, true);
    else if (pendingLarge) void processLarge(pendingLarge, true);
  };
  const cancelImport = () => {
    setPendingJson(null);
    setPendingLarge(null);
    setIdentityConfirmed(false);
    setStatus('idle');
  };
  const busy = status === 'uploading' || status === 'migrating' || status === 'loading';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <HeartbeatIcon />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-50 mb-1">
            健康存摺儀表板
          </h1>
          <p className="text-gray-400 dark:text-gray-500 text-sm">
            Taiwan NHI Health Passbook Dashboard
          </p>
        </div>

        <div className="mb-4 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
          <label htmlFor="vault-passphrase" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            資料加密密碼
          </label>
          <input
            id="vault-passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            minLength={VAULT_PASSPHRASE_MIN_LENGTH}
            autoComplete="off"
            disabled={busy}
            className="input w-full"
            placeholder={`至少 ${VAULT_PASSPHRASE_MIN_LENGTH} 個字元`}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              if (storedEnvelope) {
                void unlockStoredData();
              } else if (needsClientEncryptionMigration) {
                void migrateLegacyData();
              }
            }}
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            這組密碼只在瀏覽器中用來加密/解密健康資料，不會送到伺服器。遺失後既有資料無法復原。
          </p>
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">每個帳號僅能匯入同一人的病歷，請勿混入眷屬資料。單檔上限 4 GiB（超過 32 MiB 會以串流分塊加密保存）；單一附件上限 12 MiB。</p>
          {needsClientEncryptionMigration && !storedEnvelope && (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              偵測到既有資料。送出後會以這組密碼重新加密並保存。
            </p>
          )}
          {storedEnvelope ? (
            <button
              type="button"
              onClick={() => void unlockStoredData()}
              disabled={busy || passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH}
              className="mt-3 btn-secondary w-full"
            >
              解鎖既有資料
            </button>
          ) : needsClientEncryptionMigration ? (
            <button
              type="button"
              onClick={() => void migrateLegacyData()}
              disabled={busy || passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH}
              className="mt-3 btn-primary w-full"
            >
              加密並載入既有資料
            </button>
          ) : null}
        </div>

        {(pendingJson || pendingLarge) && status === 'confirming' && (
          <section aria-label="確認病人身分" className="mb-4 rounded-xl border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 text-sm">
            <h2 className="font-medium text-gray-900 dark:text-gray-100">無法自動確認為同一位病人</h2>
            <p className="mt-2 text-gray-700 dark:text-gray-300">原生 NHI JSON、去識別化資料或缺少共同識別碼的匯出檔，必須由你確認。請核對檔案與目前帳號的病人，這不代表網站已驗證身分。</p>
            <label className="mt-3 flex items-start gap-2 text-gray-800 dark:text-gray-200">
              <input type="checkbox" checked={identityConfirmed} onChange={e => setIdentityConfirmed(e.target.checked)} className="mt-1 accent-teal-600" />
              我已核對，確定此檔案與本帳號既有資料屬於同一人，並同意合併
            </label>
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={!identityConfirmed || passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH} onClick={confirmImport} className="btn-primary">確認並匯入</button>
              <button type="button" onClick={cancelImport} className="btn-secondary">取消匯入</button>
            </div>
          </section>
        )}

        <div
          role="region"
          aria-label="上傳健保署 JSON 或 FHIR Bundle"
          className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors duration-200 ${
            dragging
              ? 'border-teal-400 bg-teal-50 dark:bg-teal-950/30'
              : 'border-gray-300 dark:border-gray-600 hover:border-teal-400 hover:bg-teal-50 dark:hover:bg-teal-950/20'
          }`}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
        >
          {busy ? (
            <div className="flex flex-col items-center gap-3" role="status" aria-live="polite">
              <div
                className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin"
                aria-hidden="true"
              />
              <p className="text-gray-500 dark:text-gray-400 text-sm">
                {status === 'uploading'
                  ? progress === null || progress <= 0 ? '加密並儲存資料中...' : `加密並儲存資料中... ${Math.round(progress * 100)}%`
                  : status === 'migrating'
                    ? '加密既有資料中...'
                    : '載入儀表板...'}
              </p>
            </div>
          ) : (
            <>
              <p className="text-gray-700 dark:text-gray-300 font-medium mb-1">
                選擇或拖曳健保署 JSON／NHI-FHIR Bridge FHIR Bundle
              </p>
              <p className="text-gray-400 dark:text-gray-500 text-sm mb-4">
                檔案會先在此瀏覽器加密，再上傳保存
              </p>
              <label className="cursor-pointer inline-block btn-primary">
                選擇檔案
                <input
                  type="file"
                  accept=".json,.JSON,.txt,application/json"
                  className="hidden"
                  onChange={handleChange}
                  aria-label="選擇 NHI JSON 或 FHIR Bundle 檔案"
                />
              </label>
            </>
          )}
        </div>

        <p className="mt-4 text-xs text-gray-500 dark:text-gray-400">
          支援健保署原生 JSON 與 NHI-FHIR Bridge 匯出的 FHIR R4 Bundle。
          請先自行登入健保署並使用 Bridge 下載 JSON，再於此匯入。
          <a href="https://mediprisma.tw/nhi-fhir-bridge/quick-start/" target="_blank" rel="noopener noreferrer"
            className="ml-1 text-teal-700 dark:text-teal-400 underline">Bridge 使用教學</a>。
          健保登入憑證不會由本網站收集。
        </p>

        {uploadResult && (
          <div
            className="mt-4 p-4 bg-teal-50 dark:bg-teal-950/30 border border-teal-100 dark:border-teal-800 rounded-xl text-sm text-teal-800 dark:text-teal-300 msg-fade"
            role="status"
            aria-live="polite"
          >
            <p className="font-medium mb-2">{uploadResult.message}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(uploadResult.stats).map(([type, s]) =>
                (s.added > 0 || s.skipped > 0 || (s.updated ?? 0) > 0) ? (
                  <span
                    key={type}
                    className="bg-white dark:bg-teal-900/40 border border-teal-100 dark:border-teal-700 px-2 py-1 rounded-md"
                  >
                    {type.toUpperCase()} +{s.added}
                    {s.updated ? <span className="ml-1 text-teal-700 dark:text-teal-300">更新 {s.updated}</span> : null}
                    {s.skipped > 0 && (
                      <span className="text-gray-400 dark:text-gray-500 ml-1">略過 {s.skipped}</span>
                    )}
                  </span>
                ) : null
              )}
            </div>
          </div>
        )}

        {status === 'error' && error && (
          <div
            className="mt-4 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg msg-fade"
            role="alert"
          >
            <p className="text-red-700 dark:text-red-400 text-sm">{error}</p>
            <button
              className="mt-2 text-sm text-red-600 dark:text-red-400 underline cursor-pointer hover:text-red-800 dark:hover:text-red-300"
              onClick={() => { setStatus('idle'); setError(null); }}
            >
              重試
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
