import { useState } from 'react';
import type { CheckupReport } from '../parsers/types';

interface Props {
  reports: CheckupReport[];
}

export default function CheckupReportList({ reports }: Props) {
  // UI state is component-local — does not go into the global reducer
  const [query, setQuery] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const sorted = [...reports].sort((a, b) => b.date.getTime() - a.date.getTime());
  const filtered = query
    ? sorted.filter(
        (r) =>
          r.examName.includes(query) ||
          r.hospital.includes(query) ||
          r.report.includes(query)
      )
    : sorted;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-lg font-semibold text-gray-800 mb-3">健康檢查報告</h2>

      <input
        type="text"
        placeholder="搜尋報告…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="w-full mb-4 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-300"
      />

      {filtered.length === 0 ? (
        <p className="text-gray-400 text-sm">無符合的報告</p>
      ) : (
        <ul className="space-y-2">
          {filtered.map((r, i) => (
            <li key={i} className="border border-gray-100 rounded-lg overflow-hidden">
              <button
                className="w-full text-left px-4 py-3 hover:bg-gray-50 flex items-center justify-between"
                onClick={() => setExpandedId(expandedId === i ? null : i)}
              >
                <div>
                  <span className="font-medium text-gray-800 text-sm">{r.examName}</span>
                  <span className="ml-2 text-gray-400 text-xs">{r.hospital}</span>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-gray-400">{r.date.toLocaleDateString('zh-TW')}</span>
                  <span className="text-gray-400 text-sm">{expandedId === i ? '▲' : '▼'}</span>
                </div>
              </button>
              {expandedId === i && (
                <div className="px-4 pb-4 border-t border-gray-100">
                  <pre className="mt-3 text-xs text-gray-600 whitespace-pre-wrap font-sans leading-relaxed">
                    {r.report}
                  </pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
