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
      <ResponsiveContainer width="100%" height={220}>
        <BarChart data={monthData} onClick={(e) => { const p = (e as unknown as { activePayload?: { payload: { month: string } }[] } | null); p?.activePayload && handleBarClick(p.activePayload[0].payload); }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
          <Tooltip />
          <Bar
            dataKey="count"
            fill="#3b82f6"
            radius={[3, 3, 0, 0]}
            cursor="pointer"
          />
        </BarChart>
      </ResponsiveContainer>

      {selectedMonth && selectedVisits.length > 0 && (
        <div className="mt-4 border-t pt-3">
          <h3 className="text-sm font-medium text-gray-700 mb-2">{selectedMonth} 的就診紀錄</h3>
          <ul className="space-y-2">
            {selectedVisits.map((v, i) => (
              <li key={i} className="text-sm">
                <span className="font-medium text-gray-800">{v.hospital}</span>
                {v.diagnoses.length > 0 && (
                  <ul className="mt-0.5 ml-4 text-gray-500 space-y-0.5">
                    {v.diagnoses.map((d, j) => (
                      <li key={j}>{d.code} {d.name}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
