import { useMemo, useState } from 'react';
import type { NHIData } from '../parsers/types';
import { useUserStore } from '../UserStore';
import { usePersonal } from '../personalContext';
import { useNow } from '../lib/clock';
import {
  computeMedicationSummaries,
  listMedications,
  formatDay,
  formatLabValue,
  type MedicationSummary,
} from '../lib/keySummary';
import {
  abnormalLabSeriesSummaries, buildLabSeries, buildLabSeriesAlerts, computeAllLabSeriesSummaries,
  isLabSeriesPinned, labReference, labSeriesDescription, labSeriesPinTarget, type LabSeriesSummary,
} from '../lib/clinicalLabSeries';
import { computeFreshness, latestRecordDate, recheckCandidates } from '../lib/freshness';
import { refillReminders } from '../lib/refills';
import AbnormalOverview from './AbnormalOverview';
import DataFreshness from './DataFreshness';
import KeyReminders from './KeyReminders';

interface Props {
  data: NHIData;
  now?: Date;
}

// ── Small presentational helpers ────────────────────────────────────────────────

function TrendMark({ s }: { s: LabSeriesSummary }) {
  if (s.trend === null || s.delta === null) {
    return <span className="text-xs text-gray-400 dark:text-gray-500">首次紀錄</span>;
  }
  const improving = !s.referenceChanged && (s.status === 'high' || s.status === 'low') && !s.worsening && s.delta !== 0;
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

const STATUS_META: Record<LabSeriesSummary['status'], { label: string; badge: string; value: string }> = {
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

function LabCard({ s, onUnpin }: { s: LabSeriesSummary; onUnpin: () => void }) {
  const meta = STATUS_META[s.status];
  const description = labSeriesDescription(s);
  return (
    <article aria-label={`${s.subItem}（${description}${s.code ? ` · ${s.code}` : ''}）`} className="relative min-w-0 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4">
      <button
        type="button"
        onClick={onUnpin}
        title="取消釘選"
        aria-label={`取消釘選 ${s.subItem}（${description}）`}
        className="absolute top-2 right-2 text-amber-500 hover:text-gray-400 text-sm leading-none cursor-pointer"
      >
        ★
      </button>
      <div className="flex items-start justify-between pr-5">
        <div className="min-w-0">
          <h4 className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{s.subItem}</h4>
          <div className="text-xs text-gray-500 dark:text-gray-400 break-words">{s.testGroup}</div>
          <p className="text-xs text-gray-500 dark:text-gray-400 break-all">{description}</p>
          {s.code && <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">代碼：{s.code}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-2">
        <span className={`text-2xl font-bold tabular-nums ${meta.value}`}>{formatLabValue(s.latestValue)}</span>
        {s.unit && <span className="text-xs font-mono text-gray-500 dark:text-gray-400">{s.unit}</span>}
        <span className={`badge ${meta.badge}`}>{meta.label}</span>
      </div>
      <div className="mt-1"><TrendMark s={s} /></div>
      {s.referenceChanged && <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">參考區間已變更；僅比較同序列數值。</p>}
      <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-gray-500 dark:text-gray-400 font-mono">
        <span className="break-words">{s.targetApplied ? '個人目標' : '本次參考'} {labReference(s)}</span>
        <span>{formatDay(s.latestDate)} · {s.readingsCount} 筆</span>
      </div>
    </article>
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

  const labItems = useMemo(() => buildLabSeries(data.labResults), [data.labResults]);
  const medItems = useMemo(() => listMedications(data.visits), [data.visits]);

  const query = q.trim().toLowerCase();
  const filteredLabs = query
    ? labItems.filter(series => [...series.subItems, ...series.testGroups, series.code, labSeriesDescription(series)]
      .some(value => value.toLowerCase().includes(query)))
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
                const pinned = isLabSeriesPinned(o, store.preferences.pinnedLabItems);
                return (
                  <button
                    key={o.key}
                    type="button"
                    aria-pressed={pinned}
                    onClick={() => store.toggleLabPin(labSeriesPinTarget(o, store.preferences.pinnedLabItems))}
                    className="w-full flex items-center gap-3 px-2 py-2 rounded-lg text-left hover:bg-gray-50 dark:hover:bg-gray-700/60 cursor-pointer"
                  >
                    <span className={`text-base leading-none ${pinned ? 'text-amber-500' : 'text-gray-300 dark:text-gray-600'}`}>
                      {pinned ? '★' : '☆'}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-gray-800 dark:text-gray-100 truncate">{o.subItem}</span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400 break-words">{o.testGroup} · {o.records.length} 筆</span>
                      <span className="block text-xs text-gray-500 dark:text-gray-400 break-all">{labSeriesDescription(o)}{o.code ? ` · ${o.code}` : ''}</span>
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 font-mono">{formatDay(o.records[o.records.length - 1].date)}</span>
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

export default function KeySummary({ data, now: nowProp }: Props) {
  const store = useUserStore();
  const { personal } = usePersonal();
  const now = useNow(nowProp);
  const [editing, setEditing] = useState(false);

  const { pinnedLabItems, pinnedMedications } = store.preferences;

  const allLabSummaries = useMemo(
    () => computeAllLabSeriesSummaries(data.labResults, personal.targets),
    [data.labResults, personal.targets],
  );
  const labSummaries = useMemo(
    () => allLabSummaries.filter((s) => isLabSeriesPinned(s, pinnedLabItems)),
    [allLabSummaries, pinnedLabItems],
  );
  const unpinnedAbnormal = useMemo(
    () => abnormalLabSeriesSummaries(allLabSummaries).filter((s) => !isLabSeriesPinned(s, pinnedLabItems)),
    [allLabSummaries, pinnedLabItems],
  );
  const recheck = useMemo(
    () => recheckCandidates(allLabSummaries, (s) => isLabSeriesPinned(s, pinnedLabItems), now),
    [allLabSummaries, pinnedLabItems, now],
  );
  const reminders = useMemo(() => refillReminders(personal.refills, now), [personal.refills, now]);
  const freshness = useMemo(() => computeFreshness(latestRecordDate(data), now), [data, now]);
  const medSummaries = useMemo(
    () => computeMedicationSummaries(data.visits, pinnedMedications),
    [data.visits, pinnedMedications],
  );
  const alerts = useMemo(() => buildLabSeriesAlerts(labSummaries), [labSummaries]);
  const visibleAlerts = alerts.filter((a) => !store.isAlertAcknowledged(a.id));

  const hasPins = pinnedLabItems.length > 0 || pinnedMedications.length > 0;
  const showInsights = unpinnedAbnormal.length > 0 || recheck.length > 0 || reminders.length > 0;

  return (
    <section aria-labelledby="key-summary-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
        <div className="min-w-0">
          <h2 id="key-summary-title" className="text-lg font-semibold text-gray-800 dark:text-gray-100">
            我的重點摘要
          </h2>
          <DataFreshness freshness={freshness} />
        </div>
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

      {showInsights && (
        <div className="space-y-3 mb-4">
          <AbnormalOverview summaries={unpinnedAbnormal} />
          <KeyReminders refills={reminders} recheck={recheck} />
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
                    <LabCard key={s.key} s={s} onUnpin={() => store.toggleLabPin(labSeriesPinTarget(s, pinnedLabItems))} />
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
