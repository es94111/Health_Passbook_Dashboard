import { useMemo, useState } from 'react';
import { formatLocalDate } from '../lib/clock';
import {
  computeDiagnosisGroups,
  filterDiagnosisGroups,
  sortDiagnosisGroups,
} from '../lib/diagnosisGroups';
import type { DiagnosisGroup, DiagnosisSort } from '../lib/diagnosisGroups';
import type { Visit } from '../parsers/types';

const MAX_HOSPITALS = 3;

function summarizeHospitals(hospitals: string[]): string {
  const names = hospitals.slice(0, MAX_HOSPITALS).join('、');
  return hospitals.length > MAX_HOSPITALS ? `${names} 等 ${hospitals.length} 家` : names;
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-6 text-center text-sm text-gray-500 dark:text-gray-400">
      {message}
    </div>
  );
}

function GroupRow({
  group,
  open,
  onToggle,
}: {
  group: DiagnosisGroup;
  open: boolean;
  onToggle: (root: string) => void;
}) {
  return (
    <li className="min-w-0 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="badge font-mono bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
              {group.root}
            </span>
            <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">
              {group.name}
            </h3>
          </div>
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
            <span>
              <span className="font-mono">{group.visitCount}</span> 次就診
            </span>
            <span>
              首次就診 <span className="font-mono">{formatLocalDate(group.firstDate)}</span>
            </span>
            <span>
              最近就診 <span className="font-mono">{formatLocalDate(group.lastDate)}</span>
            </span>
          </p>
          {group.hospitals.length > 0 && (
            <p className="mt-1 text-sm text-gray-700 dark:text-gray-300 break-words">
              院所：{summarizeHospitals(group.hospitals)}
            </p>
          )}
        </div>
        <button
          type="button"
          className="btn-secondary px-3 py-1.5 text-xs shrink-0 print:hidden"
          aria-expanded={open}
          aria-label={`${open ? '收合' : '展開'} ${group.root} 細項`}
          onClick={() => onToggle(group.root)}
        >
          {open ? '收合' : '展開'}
        </button>
      </div>
      {open && (
        <ul
          aria-label={`${group.root} 細項診斷碼`}
          className="mt-3 border-t border-gray-100 dark:border-gray-700 divide-y divide-gray-100 dark:divide-gray-700"
        >
          {group.codes.map((item) => (
            <li key={item.code} className="flex items-baseline gap-3 py-1.5 text-sm">
              <span className="font-mono text-gray-900 dark:text-gray-100 shrink-0">
                {item.code}
              </span>
              <span className="min-w-0 flex-1 text-gray-700 dark:text-gray-300 break-words">
                {item.name}
              </span>
              <span className="font-mono text-xs text-gray-500 dark:text-gray-400 shrink-0">
                {`${item.count} 次`}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default function DiagnosisGroups({ visits }: { visits: Visit[] }) {
  const [sort, setSort] = useState<DiagnosisSort>('recent');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>());

  const groups = useMemo(() => computeDiagnosisGroups(visits), [visits]);
  const shown = useMemo(
    () => sortDiagnosisGroups(filterDiagnosisGroups(groups, query), sort),
    [groups, query, sort],
  );

  function toggle(root: string) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(root)) next.delete(root);
      else next.add(root);
      return next;
    });
  }

  return (
    <section className="card" aria-label="診斷彙總">
      <h2 className="section-title mb-2">診斷彙總</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        依診斷碼前 3 碼（ICD 大類）彙總，僅統計門診紀錄；同一疾病可能因新舊版 ICD 編碼而分成不同群組。
      </p>
      {groups.length === 0 ? (
        <EmptyState message="尚無診斷資料" />
      ) : (
        <>
          <div className="flex flex-col sm:flex-row gap-3 mb-3 print:hidden">
            <input
              className="input flex-1 min-w-0"
              aria-label="搜尋診斷"
              placeholder="搜尋診斷碼或名稱"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              className="input"
              aria-label="診斷排序"
              value={sort}
              onChange={(event) => setSort(event.target.value === 'count' ? 'count' : 'recent')}
            >
              <option value="recent">最近就診</option>
              <option value="count">就診次數</option>
            </select>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-3" role="status">
            {`顯示 ${shown.length} / ${groups.length} 個診斷群組`}
          </p>
          {shown.length === 0 ? (
            <EmptyState message="沒有符合條件的診斷群組" />
          ) : (
            <ul aria-label="診斷群組清單" className="space-y-3">
              {shown.map((group) => (
                <GroupRow
                  key={group.root}
                  group={group}
                  open={expanded.has(group.root)}
                  onToggle={toggle}
                />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
