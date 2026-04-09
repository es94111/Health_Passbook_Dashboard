import { useState, useCallback } from 'react';
import { uploadNHIJson, fetchHealthData, type UploadResult } from '../api';
import type { NHIData } from '../parsers/types';
import { parseNHIJson } from '../parsers/nhi-parser';

interface Props {
  onLoad: (data: NHIData) => void;
}

function HeartbeatIcon() {
  return (
    <svg viewBox="0 0 48 48" fill="none" className="w-12 h-12" aria-hidden="true">
      <path
        d="M24 38s-14-8.5-14-18a8 8 0 0 1 14-5.3A8 8 0 0 1 38 20c0 9.5-14 18-14 18z"
        fill="#0d9488"
        fillOpacity="0.15"
        stroke="#0d9488"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <path
        d="M6 24h6l4-8 4 16 4-10 3 6h9"
        stroke="#0d9488"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Status = 'idle' | 'uploading' | 'loading' | 'error';

export default function FileLoader({ onLoad }: Props) {
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState<Status>('idle');
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const processFile = useCallback(async (file: File) => {
    setStatus('uploading');
    setError(null);
    setUploadResult(null);

    try {
      const text = await file.text();
      const stripped = text.replace(/^\uFEFF/, '');
      const json: unknown = JSON.parse(stripped);

      if (typeof json !== 'object' || json === null) throw new Error('JSON 格式不正確');

      // 1. Upload to server — merges with existing stored data
      const result = await uploadNHIJson(json as object);
      setUploadResult(result);

      // 2. Fetch the full merged dataset back from the server
      setStatus('loading');
      const merged = await fetchHealthData();
      const parsed = parseNHIJson(merged as Record<string, unknown[]>);

      onLoad(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message : '無法讀取此檔案 — 請確認是健康存摺 JSON 匯出檔案。');
      setStatus('error');
    }
  }, [onLoad]);

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
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <div className="flex justify-center mb-4">
            <HeartbeatIcon />
          </div>
          <h1 className="text-3xl font-bold text-gray-900 mb-1">健康存摺儀表板</h1>
          <p className="text-gray-400 text-sm">Taiwan NHI Health Passbook Dashboard</p>
        </div>

        <div
          className={`border-2 border-dashed rounded-xl p-10 text-center transition-colors ${
            dragging
              ? 'border-teal-400 bg-teal-50'
              : 'border-gray-300 hover:border-teal-400 hover:bg-teal-50'
          }`}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
        >
          {busy ? (
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-500 text-sm">
                {status === 'uploading' ? '上傳並合併資料中…' : '載入儀表板…'}
              </p>
            </div>
          ) : (
            <>
              <p className="text-gray-700 font-medium mb-1">點擊或拖放您的健康存摺 JSON 檔案</p>
              <p className="text-gray-400 text-sm mb-4">新資料將自動與伺服器上的歷史資料合併</p>
              <label className="cursor-pointer inline-block bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium px-5 py-2 rounded-lg transition-colors">
                選擇檔案
                <input type="file" accept=".json,.JSON" className="hidden" onChange={handleChange} />
              </label>
            </>
          )}
        </div>

        <p className="mt-3 text-center text-xs text-gray-400">
          門診紀錄 · 檢驗趨勢 · 疫苗接種 · 健檢報告
        </p>

        {uploadResult && (
          <div className="mt-4 p-4 bg-teal-50 border border-teal-100 rounded-xl text-sm text-teal-800">
            <p className="font-medium mb-2">{uploadResult.message}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {Object.entries(uploadResult.stats).map(([type, s]) =>
                (s.added > 0 || s.skipped > 0) ? (
                  <span key={type} className="bg-white border border-teal-100 px-2 py-1 rounded-md">
                    {type.toUpperCase()} +{s.added}
                    {s.skipped > 0 && <span className="text-gray-400 ml-1">略過{s.skipped}</span>}
                  </span>
                ) : null
              )}
            </div>
          </div>
        )}

        {status === 'error' && error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-700 text-sm">{error}</p>
            <button
              className="mt-2 text-sm text-red-600 underline"
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