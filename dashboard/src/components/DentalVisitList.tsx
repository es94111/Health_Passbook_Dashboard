import { useState } from 'react';
import type { DentalVisit } from '../parsers/types';

interface Props {
  dentalVisits: DentalVisit[];
}

export default function DentalVisitList({ dentalVisits }: Props) {
  const [expanded, setExpanded] = useState<number | null>(null);

  const sorted = [...dentalVisits].sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-800">牙科就診</h2>
        <span className="text-xs text-gray-400">{sorted.length} 筆</span>
      </div>

      {sorted.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-6">無牙科就診紀錄</p>
      ) : (
        <ul className="space-y-2">
          {sorted.map((v, i) => {
            const isOpen = expanded === i;
            const dateStr = v.date.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
            const mainDiag = v.diagnoses[0];

            return (
              <li key={i} className="border border-gray-100 rounded-lg overflow-hidden">
                <button
                  className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-gray-50 transition-colors"
                  onClick={() => setExpanded(isOpen ? null : i)}
                >
                  {/* Tooth icon */}
                  <span className="text-lg select-none">🦷</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline gap-2 flex-wrap">
                      <span className="text-sm font-medium text-gray-700">{v.hospital}</span>
                      <span className="text-xs text-gray-400">{dateStr}</span>
                    </div>
                    {mainDiag && (
                      <div className="text-xs text-gray-500 truncate">
                        {mainDiag.code} {mainDiag.name}
                        {v.diagnoses.length > 1 && ` 等 ${v.diagnoses.length} 項診斷`}
                      </div>
                    )}
                  </div>
                  <span className="text-gray-300 text-xs">{isOpen ? '▲' : '▼'}</span>
                </button>

                {isOpen && (
                  <div className="px-3 pb-3 pt-1 bg-gray-50 space-y-3">
                    {/* Diagnoses */}
                    {v.diagnoses.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">診斷</div>
                        <ul className="space-y-0.5">
                          {v.diagnoses.map((d, di) => (
                            <li key={di} className="text-xs text-gray-700 flex gap-2">
                              <span className="text-gray-400 shrink-0">{d.code}</span>
                              <span>{d.name}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Procedures */}
                    {v.procedures.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-gray-500 mb-1">處置項目</div>
                        <table className="w-full text-xs text-gray-700">
                          <thead>
                            <tr className="text-gray-400">
                              <th className="text-left font-normal pb-0.5">項目</th>
                              <th className="text-left font-normal pb-0.5">牙位</th>
                              <th className="text-right font-normal pb-0.5">數量</th>
                            </tr>
                          </thead>
                          <tbody>
                            {v.procedures.map((p, pi) => (
                              <tr key={pi} className="border-t border-gray-100">
                                <td className="py-0.5 pr-2">
                                  <span className="text-gray-400">{p.code}</span>{' '}
                                  {p.name}
                                </td>
                                <td className="py-0.5 pr-2 text-gray-500">
                                  {p.toothName || p.toothCode || '—'}
                                </td>
                                <td className="py-0.5 text-right">{p.qty}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}