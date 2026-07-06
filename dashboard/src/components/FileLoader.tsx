import { useState, useCallback } from 'react';
import { uploadEncryptedHealthData, type ClientEncryptedRecords, type UploadResult } from '../api';
import type { NHIData } from '../parsers/types';
import { parseNHIJson } from '../parsers/nhi-parser';
import {
  decryptRecords,
  encryptRecords,
  emptyRecords,
  flattenRecords,
  mergeNHIJson,
  validateVaultPassphrase,
  VAULT_PASSPHRASE_MIN_LENGTH,
} from '../cryptoVault';

interface Props {
  onLoad: (data: NHIData) => void;
  storedEnvelope: ClientEncryptedRecords | null;
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

type Status = 'idle' | 'uploading' | 'loading' | 'error';

export default function FileLoader({ onLoad, storedEnvelope, onEnvelopeSaved }: Props) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');

  const unlockStoredData = useCallback(async () => {
    if (!storedEnvelope) return;
    setStatus('loading');
    setError(null);
    try {
      validateVaultPassphrase(passphrase);
      const records = await decryptRecords(storedEnvelope, passphrase);
      onLoad(parseNHIJson(flattenRecords(records) as Record<string, unknown[]>));
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法解密資料，請確認資料加密密碼');
      setStatus('error');
    }
  }, [onLoad, passphrase, storedEnvelope]);

  const processFile = useCallback(async (file: File) => {
    setStatus('uploading');
    setError(null);
    setUploadResult(null);

    try {
      validateVaultPassphrase(passphrase);
      const text = await file.text();
      const stripped = text.replace(/^\uFEFF/, '');
      const json: unknown = JSON.parse(stripped);

      if (typeof json !== 'object' || json === null) throw new Error('JSON 格式不正確');

      const existing = storedEnvelope ? await decryptRecords(storedEnvelope, passphrase) : emptyRecords();
      const { records, stats } = mergeNHIJson(existing, json);
      const envelope = await encryptRecords(records, passphrase, storedEnvelope);
      const result = await uploadEncryptedHealthData(envelope, stats);
      setUploadResult(result);
      onEnvelopeSaved(envelope);

      setStatus('loading');
      onLoad(parseNHIJson(flattenRecords(records) as Record<string, unknown[]>));
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取或加密檔案，請確認 NHI JSON 與資料加密密碼');
      setStatus('error');
    }
  }, [onEnvelopeSaved, onLoad, passphrase, storedEnvelope]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) { void processFile(file); }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) { void processFile(file); }
  }

  const busy = status === 'uploading' || status === 'loading';

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
            className="input w-full"
            placeholder={`至少 ${VAULT_PASSPHRASE_MIN_LENGTH} 個字元`}
          />
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            這組密碼只在瀏覽器中用來加密/解密健康資料，不會送到伺服器。遺失後既有資料無法復原。
          </p>
          {storedEnvelope && (
            <button
              type="button"
              onClick={() => void unlockStoredData()}
              disabled={busy || passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH}
              className="mt-3 btn-secondary w-full"
            >
              解鎖既有資料
            </button>
          )}
        </div>

        <div
          role="region"
          aria-label="上傳 NHI JSON"
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
                {status === 'uploading' ? '加密並儲存資料中...' : '載入儀表板...'}
              </p>
            </div>
          ) : (
            <>
              <p className="text-gray-700 dark:text-gray-300 font-medium mb-1">
                選擇或拖曳健保署匯出的 JSON 檔
              </p>
              <p className="text-gray-400 dark:text-gray-500 text-sm mb-4">
                檔案會先在此瀏覽器加密，再上傳保存
              </p>
              <label className="cursor-pointer inline-block btn-primary">
                選擇檔案
                <input
                  type="file"
                  accept=".json,.JSON"
                  className="hidden"
                  onChange={handleChange}
                  aria-label="選擇 NHI JSON 檔案"
                />
              </label>
            </>
          )}
        </div>

        {uploadResult && (
          <div
            className="mt-4 p-4 bg-teal-50 dark:bg-teal-950/30 border border-teal-100 dark:border-teal-800 rounded-xl text-sm text-teal-800 dark:text-teal-300 msg-fade"
            role="status"
            aria-live="polite"
          >
            <p className="font-medium mb-2">{uploadResult.message}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(uploadResult.stats).map(([type, s]) =>
                (s.added > 0 || s.skipped > 0) ? (
                  <span
                    key={type}
                    className="bg-white dark:bg-teal-900/40 border border-teal-100 dark:border-teal-700 px-2 py-1 rounded-md"
                  >
                    {type.toUpperCase()} +{s.added}
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
