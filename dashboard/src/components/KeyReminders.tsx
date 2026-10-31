import { useId, useState } from 'react';
import { labSeriesDescription } from '../lib/clinicalLabSeries';
import { ABNORMAL_RECHECK_DAYS, ROUTINE_RECHECK_DAYS, type RecheckCandidate } from '../lib/freshness';
import { formatDay } from '../lib/keySummary';
import { describeRefillTiming, REFILL_DISCLAIMER, type RefillEntry } from '../lib/refills';

const DEFAULT_RECHECK_LIMIT = 5;

const SECTION_CLASS = 'rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4';
const ROW_CLASS = 'flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2';

const REFILL_BADGE = {
  open: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  overdue: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
} as const;

const RECHECK_BADGE = {
  high: { label: '上次偏高', className: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300' },
  low: { label: '上次偏低', className: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300' },
  routine: { label: '例行追蹤', className: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300' },
} as const;

function recheckBadge({ reason, summary }: RecheckCandidate) {
  if (reason === 'routine') return RECHECK_BADGE.routine;
  return summary.status === 'high' ? RECHECK_BADGE.high : RECHECK_BADGE.low;
}

function RefillReminders({ entries }: { entries: readonly RefillEntry[] }) {
  const titleId = useId();
  if (entries.length === 0) return null;

  return (
    <section aria-labelledby={titleId} className={SECTION_CLASS}>
      <h3 id={titleId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
        領藥提醒
      </h3>
      <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
        {entries.map(({ plan, status }) => {
          const timing = describeRefillTiming(status);
          const badge = status.state === 'overdue' ? REFILL_BADGE.overdue : REFILL_BADGE.open;
          return (
            <li key={plan.id} className={ROW_CLASS}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{plan.drugName}</p>
                {plan.hospital && (
                  <p className="text-xs text-gray-500 dark:text-gray-400 break-words">{plan.hospital}</p>
                )}
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className={`badge ${badge}`}>{status.label}</span>
                {timing && <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{timing}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
        依您填寫的處方資料推估，僅供提醒；{REFILL_DISCLAIMER}。
      </p>
    </section>
  );
}

function RecheckSuggestions({ candidates, limit }: { candidates: readonly RecheckCandidate[]; limit: number }) {
  const titleId = useId();
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  if (candidates.length === 0) return null;

  const visible = expanded ? candidates : candidates.slice(0, limit);

  return (
    <section aria-labelledby={titleId} className={SECTION_CLASS}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 id={titleId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">
          建議複驗
        </h3>
        <span className="text-xs text-gray-500 dark:text-gray-400">共 {candidates.length} 項</span>
      </div>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        最新數值異常且超過 {ABNORMAL_RECHECK_DAYS} 天未複驗，或已釘選但超過 {ROUTINE_RECHECK_DAYS} 天沒有新數值的項目。
      </p>
      <ul id={listId} className="mt-2 divide-y divide-gray-100 dark:divide-gray-700">
        {visible.map(candidate => {
          const { summary, ageDays } = candidate;
          const badge = recheckBadge(candidate);
          return (
            <li key={summary.key} className={ROW_CLASS}>
              <div className="min-w-0">
                <p className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{summary.subItem}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 break-all">{labSeriesDescription(summary)}</p>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span className={`badge ${badge.className}`}>{badge.label}</span>
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">
                  {formatDay(summary.latestDate)} · {ageDays} 天前
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      {candidates.length > limit && (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(open => !open)}
          className="mt-2 text-xs text-teal-600 dark:text-teal-400 hover:underline cursor-pointer"
        >
          {expanded ? '收合' : `顯示全部 ${candidates.length} 項`}
        </button>
      )}
    </section>
  );
}

interface Props {
  recheck: readonly RecheckCandidate[];
  refills: readonly RefillEntry[];
  limit?: number;
}

export default function KeyReminders({ recheck, refills, limit = DEFAULT_RECHECK_LIMIT }: Props) {
  if (recheck.length === 0 && refills.length === 0) return null;

  return (
    <>
      <RefillReminders entries={refills} />
      <RecheckSuggestions candidates={recheck} limit={limit} />
    </>
  );
}
