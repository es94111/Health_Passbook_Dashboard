import { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import type { Visit } from '../parsers/types';

interface Props {
  visits: Visit[];
}

function monthKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export default function VisitTimeline({ visits }: Props) {
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);

  const monthData = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const v of visits) {
      const key = monthKey(v.date);
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, count]) => ({ month, count }));
  }, [visits]);

  const selectedVisits = useMemo(() => {
    if (!selectedMonth) return [];
    return visits.filter((v) => monthKey(v.date) === selectedMonth);
  }, [visits, selectedMonth]);

  function handleBarClick(data: { month: string }) {
    setSelectedMonth((prev) => (prev === data.month ? null : data.month));
  }

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <h2 className="text-lg font-semibold text-gray-800 mb-4">門診時間軸</h2>
      <div className="overflow-x-auto -mx-2 px-2">
        <div style={{ minWidth: 480 }}>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar
                dataKey="count"
                fill="#0d9488"
                radius={[3, 3, 0, 0]}
                cursor="pointer"
                onClick={(data) => handleBarClick(data as unknown as { month: string })}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {selectedMonth && selectedVisits.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-gray-700">
              {selectedMonth} 就診紀錄（{selectedVisits.length} 筆）
            </h3>
            <button
              onClick={() => setSelectedMonth(null)}
              className="text-xs text-gray-400 hover:text-gray-600"
            >
              關閉 ✕
            </button>
          </div>
          <ul className="space-y-3">
            {[...selectedVisits]
              .sort((a, b) => a.date.getTime() - b.date.getTime())
              .map((v, i) => (
              <li key={i} className="bg-gray-50 rounded-lg p-3 text-sm">
                {/* Header: date + hospital */}
                <div className="flex items-baseline gap-2 mb-1.5">
                  <span className="text-xs text-gray-400 tabular-nums">
                    {v.date.toLocaleDateString('zh-TW', { month: '2-digit', day: '2-digit' })}
                  </span>
                  <span className="font-medium text-gray-800">{v.hospital}</span>
                </div>

                {/* Diagnoses */}
                {v.diagnoses.length > 0 && (
                  <div className="mb-1.5">
                    <div className="text-xs text-gray-400 mb-0.5">診斷</div>
                    <ul className="space-y-0.5">
                      {v.diagnoses.map((d, j) => (
                        <li key={j} className="flex gap-2 text-xs text-gray-600">
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
                    <div className="text-xs text-gray-400 mb-0.5">處置</div>
                    <ul className="space-y-0.5">
                      {v.procedures.map((p, j) => (
                        <li key={j} className="flex gap-2 text-xs text-gray-600">
                          <span className="text-gray-400 shrink-0">{p.code}</span>
                          <span>{p.name}</span>
                          {p.qty > 1 && <span className="text-gray-400">×{p.qty}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
