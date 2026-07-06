import type { LabResult, Visit } from '../parsers/types';
import type { DateRangePreset } from '../api';

// ── Lab item summaries ──────────────────────────────────────────────────────────

export type LabStatus = 'normal' | 'high' | 'low' | 'unknown';
export type Trend = 'up' | 'down' | 'flat';

export interface LabSummary {
  subItem: string;
  testGroup: string;
  latestValue: number;
  latestDate: Date;
  previousValue: number | null;
  refLow: number | null;
  refHigh: number | null;
  status: LabStatus;
  delta: number | null;      // latestValue - previousValue
  trend: Trend | null;
  worsening: boolean;        // abnormal AND moving further from the healthy range
  readingsCount: number;
}

function statusFor(value: number, refLow: number | null, refHigh: number | null): LabStatus {
  if (refHigh !== null && value > refHigh) return 'high';
  if (refLow !== null && value < refLow) return 'low';
  if (refLow !== null || refHigh !== null) return 'normal';
  return 'unknown';
}

/** Build a summary for each pinned lab subItem that has at least one reading. */
export function computeLabSummaries(labResults: LabResult[], pinned: string[]): LabSummary[] {
  const pinnedSet = new Set(pinned);
  const byItem = new Map<string, LabResult[]>();
  for (const r of labResults) {
    if (!pinnedSet.has(r.subItem)) continue;
    const arr = byItem.get(r.subItem) ?? [];
    arr.push(r);
    byItem.set(r.subItem, arr);
  }

  const summaries: LabSummary[] = [];
  for (const subItem of pinned) {
    const records = byItem.get(subItem);
    if (!records || records.length === 0) continue;

    const sorted = [...records].sort((a, b) => a.date.getTime() - b.date.getTime());
    const latest = sorted[sorted.length - 1];
    const prev = sorted.length > 1 ? sorted[sorted.length - 2] : null;

    // Prefer the reference range from the most recent reading that carries one.
    const refSource = [...sorted].reverse().find((r) => r.refLow !== null || r.refHigh !== null);
    const refLow = refSource?.refLow ?? null;
    const refHigh = refSource?.refHigh ?? null;

    const status = statusFor(latest.value, refLow, refHigh);
    const delta = prev ? latest.value - prev.value : null;
    const trend: Trend | null = delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
    const worsening =
      (status === 'high' && delta !== null && delta > 0) ||
      (status === 'low' && delta !== null && delta < 0);

    summaries.push({
      subItem,
      testGroup: latest.testGroup,
      latestValue: latest.value,
      latestDate: latest.date,
      previousValue: prev ? prev.value : null,
      refLow,
      refHigh,
      status,
      delta,
      trend,
      worsening,
      readingsCount: sorted.length,
    });
  }
  return summaries;
}

// ── Medication summaries ────────────────────────────────────────────────────────

export interface MedicationSummary {
  code: string;
  name: string;
  lastDate: Date;
  count: number;        // total appearances across visits
  recentCount: number;  // appearances within 90 days of the latest visit in the dataset
}

const RECENT_WINDOW_DAYS = 90;

export function isDrugCode(code: string): boolean {
  return /^[A-Z]{2}/.test(code);
}

export function computeMedicationSummaries(visits: Visit[], pinned: string[]): MedicationSummary[] {
  const pinnedSet = new Set(pinned);

  // Latest visit date in the dataset — "recent" is measured relative to this,
  // since NHI exports are historical and may not reach today's date.
  let datasetLatest = 0;
  for (const v of visits) datasetLatest = Math.max(datasetLatest, v.date.getTime());
  const recentCutoff = datasetLatest - RECENT_WINDOW_DAYS * 86_400_000;

  interface Acc { name: string; nameFreq: Map<string, number>; lastDate: Date; count: number; recentCount: number; }
  const acc = new Map<string, Acc>();

  for (const visit of visits) {
    for (const proc of visit.procedures) {
      if (!proc.code || !pinnedSet.has(proc.code)) continue;
      const entry = acc.get(proc.code) ?? {
        name: proc.name, nameFreq: new Map(), lastDate: visit.date, count: 0, recentCount: 0,
      };
      entry.count += 1;
      if (visit.date > entry.lastDate) entry.lastDate = visit.date;
      if (visit.date.getTime() >= recentCutoff) entry.recentCount += 1;
      if (proc.name) entry.nameFreq.set(proc.name, (entry.nameFreq.get(proc.name) ?? 0) + 1);
      acc.set(proc.code, entry);
    }
  }

  const summaries: MedicationSummary[] = [];
  for (const code of pinned) {
    const entry = acc.get(code);
    if (!entry) continue;
    // Use the most frequently seen name for this code
    let name = entry.name;
    let best = 0;
    for (const [n, f] of entry.nameFreq) if (f > best) { best = f; name = n; }
    summaries.push({ code, name: name || code, lastDate: entry.lastDate, count: entry.count, recentCount: entry.recentCount });
  }
  return summaries;
}

// ── Alerts ──────────────────────────────────────────────────────────────────────

export interface Alert {
  id: string;
  subItem: string;
  severity: 'high' | 'watch';
  message: string;
  date: Date;
}

function isoDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** One alert per pinned lab item whose latest reading is out of range. */
export function buildAlerts(labSummaries: LabSummary[]): Alert[] {
  const alerts: Alert[] = [];
  for (const s of labSummaries) {
    if (s.status !== 'high' && s.status !== 'low') continue;
    const dir = s.status === 'high' ? '偏高' : '偏低';
    const refText =
      s.refLow !== null && s.refHigh !== null ? `參考 ${s.refLow}–${s.refHigh}`
      : s.refHigh !== null ? `參考上限 ${s.refHigh}`
      : s.refLow !== null ? `參考下限 ${s.refLow}` : '';
    const worse = s.worsening ? '，且較上次惡化' : '';
    alerts.push({
      id: `lab:${s.subItem}:${isoDay(s.latestDate)}`,
      subItem: s.subItem,
      severity: s.worsening ? 'high' : 'watch',
      message: `${s.subItem} ${dir}：${s.latestValue}${refText ? `（${refText}）` : ''}${worse}`,
      date: s.latestDate,
    });
  }
  // Most severe / most recent first
  return alerts.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return b.date.getTime() - a.date.getTime();
  });
}

// ── Picker option lists ─────────────────────────────────────────────────────────

export interface LabItemOption { subItem: string; testGroup: string; count: number; latestDate: Date; }
export interface MedicationOption { code: string; name: string; count: number; latestDate: Date; }

export function listLabItems(labResults: LabResult[]): LabItemOption[] {
  const map = new Map<string, LabItemOption>();
  for (const r of labResults) {
    if (!r.subItem) continue;
    const opt = map.get(r.subItem);
    if (opt) {
      opt.count += 1;
      if (r.date > opt.latestDate) opt.latestDate = r.date;
    } else {
      map.set(r.subItem, { subItem: r.subItem, testGroup: r.testGroup, count: 1, latestDate: r.date });
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.subItem.localeCompare(b.subItem));
}

export function listMedications(visits: Visit[]): MedicationOption[] {
  interface Acc { name: string; nameFreq: Map<string, number>; count: number; latestDate: Date; }
  const map = new Map<string, Acc>();
  for (const visit of visits) {
    for (const proc of visit.procedures) {
      if (!proc.code || !isDrugCode(proc.code)) continue;
      const entry = map.get(proc.code) ?? { name: proc.name, nameFreq: new Map(), count: 0, latestDate: visit.date };
      entry.count += 1;
      if (visit.date > entry.latestDate) entry.latestDate = visit.date;
      if (proc.name) entry.nameFreq.set(proc.name, (entry.nameFreq.get(proc.name) ?? 0) + 1);
      map.set(proc.code, entry);
    }
  }
  const out: MedicationOption[] = [];
  for (const [code, entry] of map) {
    let name = entry.name;
    let best = 0;
    for (const [n, f] of entry.nameFreq) if (f > best) { best = f; name = n; }
    out.push({ code, name: name || code, count: entry.count, latestDate: entry.latestDate });
  }
  return out.sort((a, b) => b.count - a.count || a.code.localeCompare(b.code));
}

// ── Date range presets ──────────────────────────────────────────────────────────

export const DATE_RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: '3m', label: '近 3 個月' },
  { value: '6m', label: '近 6 個月' },
  { value: '1y', label: '近 1 年' },
  { value: '3y', label: '近 3 年' },
];

const PRESET_MONTHS: Record<Exclude<DateRangePreset, 'all'>, number> = { '3m': 3, '6m': 6, '1y': 12, '3y': 36 };

/** Start date for a preset, measured back from `anchor` (usually the dataset's latest date). Null = no lower bound. */
export function presetToStartDate(preset: DateRangePreset, anchor: Date): Date | null {
  if (preset === 'all') return null;
  const d = new Date(anchor);
  d.setMonth(d.getMonth() - PRESET_MONTHS[preset]);
  return d;
}

export function formatDay(d: Date): string {
  return isoDay(d);
}
