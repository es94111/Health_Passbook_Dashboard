import { useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, ReferenceArea,
} from 'recharts';
import type { LabResult } from '../parsers/types';

interface Props {
  labResults: LabResult[];
}

interface DataPoint {
  date: string;
  value: number;
  refLow: number | null;
  refHigh: number | null;
  outOfRange: boolean;
}

interface SubItemGroup {
  subItem: string;
  testGroup: string;
  points: DataPoint[];
  refLow: number | null;
  refHigh: number | null;
}

const MIN_READINGS = 3;

export default function LabTrendCharts({ labResults }: Props) {
  const groups = useMemo(() => {
    const map = new Map<string, LabResult[]>();
    for (const r of labResults) {
      const key = r.subItem;
      const arr = map.get(key) ?? [];
      arr.push(r);
      map.set(key, arr);
    }

    const all: SubItemGroup[] = [];
    for (const [subItem, records] of map.entries()) {
      if (records.length < MIN_READINGS) continue;
      const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime());
      const refLow = sorted.find((r) => r.refLow !== null)?.refLow ?? null;
      const refHigh = sorted.find((r) => r.refHigh !== null)?.refHigh ?? null;
      const points: DataPoint[] = sorted.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        value: r.value,
        refLow: r.refLow,
        refHigh: r.refHigh,
        outOfRange:
          (r.refLow !== null && r.value < r.refLow) ||
          (r.refHigh !== null && r.value > r.refHigh),
      }));
      all.push({ subItem, testGroup: records[0].testGroup, points, refLow, refHigh });
    }
    return all.sort((a, b) => a.subItem.localeCompare(b.subItem));
  }, [labResults]);

  const totalSubItems = useMemo(() => {
    const set = new Set(labResults.map((r) => r.subItem));
    return set.size;
  }, [labResults]);

  const filteredCount = totalSubItems - groups.length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="text-lg font-semibold text-gray-800">檢驗趨勢</h2>
        <span className="text-xs text-gray-400">
          顯示 {groups.length} / {totalSubItems} 項
          {filteredCount > 0 && `（${filteredCount} 項已過濾 — 少於 ${MIN_READINGS} 筆資料）`}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 mt-4">
        {groups.map(({ subItem, testGroup, points, refLow, refHigh }) => (
          <div key={subItem} className="border border-gray-100 rounded-lg p-3">
            <div className="text-sm font-medium text-gray-700 mb-0.5">{subItem}</div>
            <div className="text-xs text-gray-400 mb-2">{testGroup}</div>
            <ResponsiveContainer width="100%" height={120}>
              <LineChart data={points}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="date" hide />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fontSize: 10 }}
                  width={40}
                />
                <Tooltip
                  formatter={(val) => [val, subItem]}
                  labelFormatter={(label) => `日期: ${label}`}
                />
                {refLow !== null && refHigh !== null && (
                  <ReferenceArea
                    y1={refLow}
                    y2={refHigh}
                    fill="#bbf7d0"
                    fillOpacity={0.4}
                  />
                )}
                {refLow !== null && (
                  <ReferenceLine y={refLow} stroke="#86efac" strokeDasharray="3 3" />
                )}
                {refHigh !== null && (
                  <ReferenceLine y={refHigh} stroke="#86efac" strokeDasharray="3 3" />
                )}
                <Line
                  type="monotone"
                  dataKey="value"
                  stroke="#0d9488"
                  dot={(props) => {
                    const { cx, cy, payload } = props;
                    return (
                      <circle
                        key={`dot-${cx}-${cy}`}
                        cx={cx}
                        cy={cy}
                        r={3}
                        fill={payload.outOfRange ? '#ef4444' : '#0d9488'}
                        stroke="none"
                      />
                    );
                  }}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ))}
      </div>
    </div>
  );
}
