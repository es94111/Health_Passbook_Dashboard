import { useId, useState } from 'react';
import { isAbnormalSummary, labSeriesDescription, type LabSeriesSummary } from '../lib/clinicalLabSeries';
import { formatDay, formatLabValue } from '../lib/keySummary';

const DEFAULT_LIMIT = 8;

const ABNORMAL_META = {
  high: {
    label: '偏高',
    badge: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
    value: 'text-red-600 dark:text-red-400',
  },
  low: {
    label: '偏低',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
    value: 'text-blue-600 dark:text-blue-400',
  },
} as const;

interface Props {
  summaries: readonly LabSeriesSummary[];
  limit?: number;
}

export default function AbnormalOverview({ summaries, limit = DEFAULT_LIMIT }: Props) {
  const titleId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);

  const abnormal = summaries.filter(isAbnormalSummary);
  if (abnormal.length === 0) return null;

  const visible = expanded ? abnormal : abnormal.slice(0, limit);

  return (
    <section
      aria-labelledby={titleId}
      className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          異常檢驗總覽
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">共 {abnormal.length} 項</span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        未釘選的檢驗項目中，最新數值超出參考範圍者。
      </p>
      <ul id={listId} className="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
        {visible.map(s => {
          const meta = s.status === 'high' ? ABNORMAL_META.high : ABNORMAL_META.low;
          return (
            <li
              key={s.key}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{s.subItem}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 break-all">{labSeriesDescription(s)}</p>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className={`font-mono tabular-nums text-sm font-semibold ${meta.value}`}>
                  {formatLabValue(s.latestValue)}
                </span>
                {s.unit && <span className="text-xs text-gray-500 dark:text-gray-400">{s.unit}</span>}
                <span className={`badge ${meta.badge}`}>{meta.label}</span>
                {s.worsening && <span className="text-xs text-red-600 dark:text-red-400">較上次惡化</span>}
                {s.targetApplied && <span className="text-xs text-amber-700 dark:text-amber-400">依個人目標</span>}
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{formatDay(s.latestDate)}</span>
              </div>
            </li>
          );
        })}
      </ul>
      {abnormal.length > limit && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(open => !open)}
          className="mt-2 text-xs text-teal-600 dark:text-teal-400 hover:underline cursor-pointer"
        >
          {expanded ? '收合' : `顯示全部 ${abnormal.length} 項`}
        </button>
      )}
    </section>
  );
}
