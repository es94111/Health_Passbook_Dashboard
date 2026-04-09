import { useState, useRef } from 'react';
import { parseNHIJson } from '../parsers/nhi-parser';
import type { NHIData } from '../parsers/types';

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

export default function FileLoader({ onLoad }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  function handleFile(file: File) {
    setError(null);
    setLoading(true);
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const raw = e.target?.result as string;
        const data = parseNHIJson(raw);
        onLoad(data);
      } catch {
        setError('無法讀取此檔案 — 請確認是您的健康存摺 JSON 匯出檔案。');
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('讀取檔案時發生錯誤，請重試。');
      setLoading(false);
    };
    reader.readAsText(file, 'utf-8');
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) handleFile(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) handleFile(file);
  }

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
          className="border-2 border-dashed border-gray-300 rounded-xl p-10 text-center cursor-pointer hover:border-teal-400 hover:bg-teal-50 transition-colors"
          onDrop={handleDrop}
          onDragOver={(e) => e.preventDefault()}
          onClick={() => inputRef.current?.click()}
        >
          {loading ? (
            <div className="flex flex-col items-center gap-3">
              <div className="w-10 h-10 border-4 border-teal-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-gray-500 text-sm">讀取中…</p>
            </div>
          ) : (
            <>
              <p className="text-gray-700 font-medium mb-1">點擊或拖放您的健康存摺 JSON 檔案</p>
              <p className="text-gray-400 text-sm">健康存摺醫療類_*.JSON</p>
            </>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".json,.JSON"
          className="hidden"
          onChange={handleChange}
        />

        <p className="mt-3 text-center text-xs text-gray-400">
          門診紀錄 · 檢驗趨勢 · 疫苗接種 · 健檢報告
        </p>

        {error && (
          <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-700 text-sm">{error}</p>
            <button
              className="mt-2 text-sm text-red-600 underline"
              onClick={() => { setError(null); inputRef.current?.click(); }}
            >
              重試
            </button>
          </div>
        )}

        <p className="mt-4 text-center text-xs text-gray-400">
          資料僅在瀏覽器中處理，不會上傳至任何伺服器。
        </p>
      </div>
    </div>
  );
}