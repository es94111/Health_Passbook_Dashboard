import { useMemo, useState } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer, ReferenceArea,
} from 'recharts';
import type { LabResult } from '../parsers/types';
import { useUserStore } from '../UserStore';

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
  outOfRangeCount: number;
}

const MIN_READINGS = 3;

export default function LabTrendCharts({ labResults }: Props) {
  const store = useUserStore();
  const [search, setSearch] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [showFewReadings, setShowFewReadings] = useState(false);

  // All distinct test groups
  const allGroups = useMemo(() => {
    const set = new Set(labResults.map((r) => r.testGroup));
    return [...set].filter(Boolean).sort((a, b) => a.localeCompare(b));
  }, [labResults]);

  // Build all subItem groups (before filter)
  const allSubItemGroups = useMemo(() => {
    const map = new Map<string, LabResult[]>();
    for (const r of labResults) {
      const arr = map.get(r.subItem) ?? [];
      arr.push(r);
      map.set(r.subItem, arr);
    }

    const all: SubItemGroup[] = [];
    for (const [subItem, records] of map.entries()) {
      const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime());
      const refLow = sorted.find((r) => r.refLow !== null)?.refLow ?? null;
      const refHigh = sorted.find((r) => r.refHigh !== null)?.refHigh ?? null;
      const points: DataPoint[] = sorted.map((r) => {
        const outOfRange =
          (r.refLow !== null && r.value < r.refLow) ||
          (r.refHigh !== null && r.value > r.refHigh);
        return { date: r.date.toISOString().slice(0, 10), value: r.value, refLow: r.refLow, refHigh: r.refHigh, outOfRange };
      });
      const outOfRangeCount = points.filter((p) => p.outOfRange).length;
      all.push({ subItem, testGroup: records[0].testGroup, points, refLow, refHigh, outOfRangeCount });
    }
    return all.sort((a, b) => a.subItem.localeCompare(b.subItem));
  }, [labResults]);

  // Apply filters
  const groups = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allSubItemGroups.filter((g) => {
      if (!showFewReadings && g.points.length < MIN_READINGS) return false;
      if (selectedGroups.size > 0 && !selectedGroups.has(g.testGroup)) return false;
      if (q && !g.subItem.toLowerCase().includes(q) && !g.testGroup.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allSubItemGroups, search, selectedGroups, showFewReadings]);

  function toggleGroup(group: string) {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  }

  const hiddenCount = allSubItemGroups.length - allSubItemGroups.filter((g) => showFewReadings || g.points.length >= MIN_READINGS).length;

  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-4">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-lg font-semibold text-gray-800">檢驗趨勢</h2>
        <span className="text-xs text-gray-400">
          顯示 {groups.length} / {allSubItemGroups.length} 項
        </span>
      </div>

      {/* Filter bar */}
      <div className="space-y-2 mb-4">
        {/* Search input */}
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜尋檢驗項目或分類…"
          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-teal-400"
        />

        {/* Test group tags */}
        {allGroups.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {allGroups.map((g) => {
              const active = selectedGroups.has(g);
              return (
                <button
                  key={g}
                  onClick={() => toggleGroup(g)}
                  className={`px-2.5 py-0.5 text-xs rounded-full border transition-colors ${
                    active
                      ? 'bg-teal-600 text-white border-teal-600'
                      : 'bg-white text-gray-500 border-gray-200 hover:border-teal-400 hover:text-teal-600'
                  }`}
                >
                  {g}
                </button>
              );
            })}
            {selectedGroups.size > 0 && (
              <button
                onClick={() => setSelectedGroups(new Set())}
                className="px-2.5 py-0.5 text-xs rounded-full border border-gray-200 text-gray-400 hover:text-gray-600"
              >
                清除篩選
              </button>
            )}
          </div>
        )}

        {/* Sparse readings toggle */}
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <span className="relative flex items-center">
            <input
              type="checkbox"
              checked={showFewReadings}
              onChange={(e) => setShowFewReadings(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-8 h-4 bg-gray-200 rounded-full peer-checked:bg-teal-500 transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
          </span>
          <span className="text-xs text-gray-500">
            顯示少於 {MIN_READINGS} 筆的項目
            {hiddenCount > 0 && ` (${hiddenCount} 項)`}
          </span>
        </label>
      </div>

      {/* Charts grid */}
      {groups.length === 0 ? (
        <p className="text-sm text-gray-400 text-center py-8">沒有符合條件的檢驗項目</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {groups.map(({ subItem, testGroup, points, refLow, refHigh, outOfRangeCount }) => (
            <div key={subItem} className="border border-gray-100 dark:border-gray-700 rounded-lg p-3">
              <div className="flex items-start justify-between mb-0.5">
                <div className="flex items-center gap-1.5 min-w-0">
                  <button
                    onClick={() => store.toggleLabPin(subItem)}
                    title={store.isLabPinned(subItem) ? '取消釘選' : '釘選到重點摘要'}
                    aria-label={store.isLabPinned(subItem) ? `取消釘選 ${subItem}` : `釘選 ${subItem}`}
                    aria-pressed={store.isLabPinned(subItem)}
                    className={`shrink-0 text-sm leading-none cursor-pointer ${
                      store.isLabPinned(subItem)
                        ? 'text-amber-500 hover:text-amber-600'
                        : 'text-gray-300 dark:text-gray-600 hover:text-amber-400'
                    }`}
                  >
                    {store.isLabPinned(subItem) ? '★' : '☆'}
                  </button>
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">{subItem}</div>
                </div>
                {outOfRangeCount > 0 && (
                  <span className="text-xs text-red-500 shrink-0 ml-1">
                    {outOfRangeCount} 次異常
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-400 mb-2">{testGroup}</div>
              <ResponsiveContainer width="100%" height={120}>
                <LineChart data={points}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="date" hide />
                  <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10 }} width={40} />
                  <Tooltip
                    formatter={(val) => [val, subItem]}
                    labelFormatter={(label) => `日期: ${label}`}
                  />
                  {refLow !== null && refHigh !== null && (
                    <ReferenceArea y1={refLow} y2={refHigh} fill="#bbf7d0" fillOpacity={0.4} />
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
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>{points[0]?.date}</span>
                <span>{points[points.length - 1]?.date}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}