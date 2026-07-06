import { useMemo, useState } from 'react';
import type { NHIData } from '../parsers/types';
import { useUserStore } from '../UserStore';
import {
  computeLabSummaries,
  computeMedicationSummaries,
  buildAlerts,
  listLabItems,
  listMedications,
  formatDay,
  type LabSummary,
  type MedicationSummary,
} from '../lib/keySummary';

interface Props {
  data: NHIData;
}

// ── Small presentational helpers ────────────────────────────────────────────────

function TrendMark({ s }: { s: LabSummary }) {
  if (s.trend === null || s.delta === null) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">首次紀錄</span>;
  }
  const improving = (s.status === 'high' || s.status === 'low') && !s.worsening && s.delta !== 0;
  const color = s.worsening
    ? 'text-red-600 dark:text-red-400'
    : improving
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-gray-500 dark:text-gray-400';
  const arrow = s.trend === 'up' ? '▲' : s.trend === 'down' ? '▼' : '▬';
  const absDelta = Math.abs(s.delta);
  const deltaText = Number.isInteger(absDelta) ? String(absDelta) : absDelta.toFixed(2);
  return (
    <span className={`text-xs font-medium tabular-nums ${color}`}>
      {arrow} {deltaText}
      {s.worsening && <span className="ml-1">變差</span>}
    </span>
  );
}

const STATUS_META: Record<LabSummary['status'], { label: string; badge: string; value: string }> = {
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
  normal: {
    label: '正常',
    badge: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
    value: 'text-emerald-600 dark:text-emerald-400',
  },
  unknown: {
    label: '無參考值',
    badge: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
    value: 'text-gray-800 dark:text-gray-100',
  },
};

function fmtValue(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}

function LabCard({ s, onUnpin }: { s: LabSummary; onUnpin: () => void }) {
  const meta = STATUS_META[s.status];
  const ref =
    s.refLow !== null && s.refHigh !== null ? `${s.refLow}–${s.refHigh}`
    : s.refHigh !== null ? `≤ ${s.refHigh}`
    : s.refLow !== null ? `≥ ${s.refLow}` : '—';
  return (
    <div className="relative rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <button
        onClick={onUnpin}
        title="取消釘選"
        aria-label={`取消釘選 ${s.subItem}`}
        className="absolute top-2 right-2 text-amber-500 hover:text-gray-400 text-sm leading-none cursor-pointer"
      >
        ★
      </button>
      <div className="flex items-start justify-between pr-5">
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{s.subItem}</div>
          <div className="text-xs text-gray-400 dark:text-gray-500 truncate">{s.testGroup}</div>
        </div>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className={`text-2xl font-bold tabular-nums ${meta.value}`}>{fmtValue(s.latestValue)}</span>
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </div>
      <div className="mt-1"><TrendMark s={s} /></div>
      <div className="mt-2 flex justify-between text-xs text-gray-400 dark:text-gray-500 font-mono">
        <span>參考 {ref}</span>
        <span>{formatDay(s.latestDate)}</span>
      </div>
    </div>
  );
}

function MedCard({ m, onUnpin }: { m: MedicationSummary; onUnpin: () => void }) {
  return (
    <div className="relative rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <button
        onClick={onUnpin}
        title="取消釘選"
        aria-label={`取消釘選 ${m.name}`}
        className="absolute top-2 right-2 text-amber-500 hover:text-gray-400 text-sm leading-none cursor-pointer"
      >
        ★
      </button>
      <div className="pr-5">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">{m.name}</div>
        <div className="text-xs text-gray-400 dark:text-gray-500 font-mono truncate">{m.code}</div>
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-2xl font-bold tabular-nums text-teal-600 dark:text-teal-400">{m.count}</span>
        <span className="text-xs text-gray-500 dark:text-gray-400">次開立</span>
        {m.recentCount > 0 && (
          <span className="badge bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">近 90 天 {m.recentCount} 次</span>
        )}
      </div>
      <div className="mt-2 text-xs text-gray-400 dark:text-gray-500 font-mono text-right">
        上次 {formatDay(m.lastDate)}
      </div>
    </div>
  );
}

// ── Pin picker modal ────────────────────────────────────────────────────────────

function PinPicker({ data, onClose }: { data: NHIData; onClose: () => void }) {
  const store = useUserStore();
  const [tab, setTab] = useState<'lab' | 'med'>('lab');
  const [q, setQ] = useState('');

  const labItems = useMemo(() => listLabItems(data.labResults), [data.labResults]);
  const medItems = useMemo(() => listMedications(data.visits), [data.visits]);

  const query = q.trim().toLowerCase();
  const filteredLabs = query
    ? labItems.filter((o) => o.subItem.toLowerCase().includes(query) || o.testGroup.toLowerCase().includes(query))
    : labItems;
  const filteredMeds = query
    ? medItems.filter((o) => o.name.toLowerCase().includes(query) || o.code.toLowerCase().includes(query))
    : medItems;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="編輯重點追蹤項目"
    >
      <div
        className="w-full max-w-lg max-h-[80vh] flex flex-col rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100">編輯重點追蹤</h3>
          <button onClick={onClose} aria-label="關閉" className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer text-lg leading-none">✕</button>
        </div>

        <div className="px-4 pt-3 flex gap-1">
          <button
            onClick={() => setTab('lab')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${tab === 'lab' ? 'bg-teal-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
          >
            檢驗項目 · {store.preferences.pinnedLabItems.length}
          </button>
          <button
            onClick={() => setTab('med')}
            className={`px-3 py-1.5 text-sm rounded-md transition-colors cursor-pointer ${tab === 'med' ? 'bg-teal-600 text-white' : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'}`}
          >
            藥品 · {store.preferences.pinnedMedications.length}
          </button>
        </div>

        <div className="px-4 pt-3">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={tab === 'lab' ? '搜尋檢驗項目…' : '搜尋藥品名稱或代碼…'}
            className="input w-full"
            autoFocus
          />
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1">
          {tab === 'lab' ? (
            filteredLabs.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">沒有符合的檢驗項目</p>
            ) : (
              filteredLabs.map((o) => {
                const pinned = store.isLabPinned(o.subItem);
                return (
                  <button
                    key={o.subItem}
                    onClick={() => store.toggleLabPin(o.subItem)}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 cursor-pointer"
                  >
                    <span className={`text-base leading-none ${pinned ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600'}`}>
                      {pinned ? '★' : '☆'}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-800 dark:text-gray-100 truncate">{o.subItem}</span>
                      <span className="block text-xs text-gray-400 dark:text-gray-500 truncate">{o.testGroup} · {o.count} 筆</span>
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{formatDay(o.latestDate)}</span>
                  </button>
                );
              })
            )
          ) : (
            filteredMeds.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-6">沒有符合的藥品</p>
            ) : (
              filteredMeds.map((o) => {
                const pinned = store.isMedicationPinned(o.code);
                return (
                  <button
                    key={o.code}
                    onClick={() => store.toggleMedicationPin(o.code)}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 cursor-pointer"
                  >
                    <span className={`text-base leading-none ${pinned ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600'}`}>
                      {pinned ? '★' : '☆'}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-800 dark:text-gray-100 truncate">{o.name}</span>
                      <span className="block text-xs text-gray-400 dark:text-gray-500 font-mono truncate">{o.code} · {o.count} 次</span>
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{formatDay(o.latestDate)}</span>
                  </button>
                );
              })
            )
          )}
        </div>

        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700 text-right">
          <button onClick={onClose} className="btn-primary">完成</button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────────────

export default function KeySummary({ data }: Props) {
  const store = useUserStore();
  const [editing, setEditing] = useState(false);

  const { pinnedLabItems, pinnedMedications } = store.preferences;

  const labSummaries = useMemo(
    () => computeLabSummaries(data.labResults, pinnedLabItems),
    [data.labResults, pinnedLabItems],
  );
  const medSummaries = useMemo(
    () => computeMedicationSummaries(data.visits, pinnedMedications),
    [data.visits, pinnedMedications],
  );
  const alerts = useMemo(() => buildAlerts(labSummaries), [labSummaries]);
  const visibleAlerts = alerts.filter((a) => !store.isAlertAcknowledged(a.id));

  const hasPins = pinnedLabItems.length > 0 || pinnedMedications.length > 0;

  return (
    <section aria-labelledby="key-summary-title">
      <div className="flex items-baseline justify-between mb-3">
        <h2 id="key-summary-title" className="text-lg font-semibold text-gray-800 dark:text-gray-100">
          我的重點摘要
        </h2>
        <button
          onClick={() => setEditing(true)}
          className="text-sm text-teal-600 dark:text-teal-400 hover:underline cursor-pointer"
        >
          編輯追蹤項目
        </button>
      </div>

      {/* Alerts */}
      {visibleAlerts.length > 0 && (
        <div className="space-y-2 mb-4">
          {visibleAlerts.map((a) => (
            <div
              key={a.id}
              className={`flex items-start justify-between gap-3 rounded-lg border-l-4 px-3 py-2 ${
                a.severity === 'high'
                  ? 'border-red-500 bg-red-50 dark:bg-red-950/30'
                  : 'border-amber-500 bg-amber-50 dark:bg-amber-950/30'
              }`}
            >
              <span className="text-sm text-gray-700 dark:text-gray-200">{a.message}</span>
              <button
                onClick={() => store.acknowledgeAlert(a.id)}
                className="shrink-0 text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 cursor-pointer"
                aria-label="忽略此提醒"
              >
                忽略 ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {!hasPins ? (
        <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-6 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">尚未釘選任何追蹤項目</p>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
            釘選血糖、HbA1c、LDL、肝腎功能或常用藥品，即可在此追蹤最新數值與趨勢。
          </p>
          <button onClick={() => setEditing(true)} className="btn-primary mt-3">選擇追蹤項目</button>
        </div>
      ) : (
        <div className="space-y-4">
          {pinnedLabItems.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">檢驗指標</h3>
              {labSummaries.length === 0 ? (
                <p className="text-sm text-gray-400">釘選的檢驗項目在目前資料中沒有數值。</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {labSummaries.map((s) => (
                    <LabCard key={s.subItem} s={s} onUnpin={() => store.toggleLabPin(s.subItem)} />
                  ))}
                </div>
              )}
            </div>
          )}

          {pinnedMedications.length > 0 && (
            <div>
              <h3 className="text-xs font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500 mb-2">追蹤藥品</h3>
              {medSummaries.length === 0 ? (
                <p className="text-sm text-gray-400">釘選的藥品在目前資料中沒有紀錄。</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {medSummaries.map((m) => (
                    <MedCard key={m.code} m={m} onUnpin={() => store.toggleMedicationPin(m.code)} />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {editing && <PinPicker data={data} onClose={() => setEditing(false)} />}
    </section>
  );
}
