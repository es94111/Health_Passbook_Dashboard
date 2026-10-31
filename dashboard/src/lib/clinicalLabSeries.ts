import type { LabResult, TextLabResult } from '../parsers/types';
import { buildAlerts, type LabSummary } from './keySummary';
import { clinicalDateTime, originLabel } from './clinicalRecords';

export interface LabSeries {
  key: string;
  subItem: string;
  subItems: string[];
  testGroup: string;
  testGroups: string[];
  code: string;
  unit: string;
  source: string;
  hospital: string;
  records: LabResult[];
  consistentReference: boolean;
}

export interface LabSeriesSummary extends LabSummary {
  key: string;
  subItems: string[];
  code: string;
  unit: string;
  source: string;
  hospital: string;
  refText?: string;
  referenceChanged: boolean;
}

export function labSource(record: Pick<LabResult, 'source' | 'origins'>): string {
  return record.source || [...new Set((record.origins ?? []).map(origin =>
    [origin.format, origin.source].filter(Boolean).join(' · '),
  ))].sort().join(' / ');
}

export function labSeriesKey(record: LabResult): string {
  return `lab-series:${JSON.stringify([
    record.code ? ['code', record.code] : ['name', record.subItem],
    record.unit ?? '', labSource(record), record.hospital,
  ])}`;
}

function referenceKey(record: LabResult): string {
  return JSON.stringify([record.refLow, record.refHigh, record.refText ?? '']);
}

export function labReference(record: Pick<LabResult, 'refLow' | 'refHigh' | 'refText'>): string {
  if (record.refText) return record.refText;
  if (record.refLow !== null && record.refHigh !== null) return `${record.refLow}–${record.refHigh}`;
  if (record.refLow !== null) return `≥ ${record.refLow}`;
  if (record.refHigh !== null) return `≤ ${record.refHigh}`;
  return '未提供';
}

export function labReadingKey(record: LabResult | TextLabResult): string {
  return JSON.stringify([
    (record.origins ?? []).map(originLabel).sort(), clinicalDateTime(record.date),
    record.subItem, record.testGroup, record.hospital, record.unit, record.source,
    'value' in record ? [record.value, record.refLow, record.refHigh] : record.text,
    record.refText,
  ]);
}

export function buildLabSeries(records: LabResult[]): LabSeries[] {
  const groups = new Map<string, LabResult[]>();
  for (const record of records) {
    const key = labSeriesKey(record);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  return [...groups].map(([key, group]) => {
    const sorted = [...group].sort((a, b) => clinicalDateTime(a.date) - clinicalDateTime(b.date));
    const latest = sorted[sorted.length - 1];
    return {
      key, subItem: latest.subItem, subItems: [...new Set(sorted.map(record => record.subItem))],
      testGroup: latest.testGroup, testGroups: [...new Set(sorted.map(record => record.testGroup))],
      code: latest.code ?? '', unit: latest.unit ?? '', source: labSource(latest), hospital: latest.hospital,
      records: sorted, consistentReference: new Set(sorted.map(referenceKey)).size === 1,
    };
  }).sort((a, b) => a.subItem.localeCompare(b.subItem) || a.key.localeCompare(b.key));
}

export function labSeriesDescription(series: Pick<LabSeries, 'unit' | 'hospital' | 'source'>): string {
  return [series.unit || '單位未提供', series.hospital || '院所未提供', series.source || '來源未提供'].join(' · ');
}

export function isLabSeriesPinned(series: Pick<LabSeries, 'key' | 'subItems'>, pinned: string[]): boolean {
  return pinned.includes(series.key) || series.subItems.some(name => pinned.includes(name));
}

export function labSeriesPinTarget(series: Pick<LabSeries, 'key' | 'subItems'>, pinned: string[]): string {
  return pinned.includes(series.key) ? series.key : series.subItems.find(name => pinned.includes(name)) ?? series.key;
}

export function computeLabSeriesSummaries(records: LabResult[], pinned: string[]): LabSeriesSummary[] {
  return buildLabSeries(records).filter(series => isLabSeriesPinned(series, pinned)).map(series => {
    const latest = series.records[series.records.length - 1];
    const previous = series.records[series.records.length - 2];
    const { refLow, refHigh } = latest;
    const status = refHigh !== null && latest.value > refHigh ? 'high'
      : refLow !== null && latest.value < refLow ? 'low'
      : refLow !== null || refHigh !== null ? 'normal' : 'unknown';
    const delta = previous ? latest.value - previous.value : null;
    const referenceChanged = Boolean(previous && referenceKey(latest) !== referenceKey(previous));
    return {
      key: series.key, subItem: series.subItem, subItems: series.subItems, testGroup: series.testGroup,
      code: series.code, unit: series.unit, source: series.source, hospital: series.hospital,
      latestValue: latest.value, latestDate: latest.date, previousValue: previous?.value ?? null,
      refLow, refHigh, refText: latest.refText, referenceChanged, status, delta,
      trend: delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      worsening: !referenceChanged && ((status === 'high' && delta !== null && delta > 0)
        || (status === 'low' && delta !== null && delta < 0)),
      readingsCount: series.records.length,
    };
  });
}

export function buildLabSeriesAlerts(summaries: LabSeriesSummary[]) {
  return summaries.flatMap(series => buildAlerts([series]).map(alert => ({
    ...alert, id: `${series.key}:${alert.date.getTime()}`,
    message: `${labSeriesDescription(series)}｜${alert.message}`,
  }))).sort((a, b) => a.severity !== b.severity ? (a.severity === 'high' ? -1 : 1)
    : b.date.getTime() - a.date.getTime());
}
