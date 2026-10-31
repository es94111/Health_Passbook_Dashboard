import { describe, expect, it } from 'vitest';
import type { LabResult } from '../parsers/types';
import {
  abnormalLabSeriesSummaries, buildLabSeries, buildLabSeriesAlerts, computeAllLabSeriesSummaries,
  computeLabSeriesSummaries, isAbnormalSummary, isLabSeriesPinned,
  labReference, labSeriesKey, labSeriesPinTarget, summarizeSeries,
} from './clinicalLabSeries';

const reading = (overrides: Partial<LabResult> = {}): LabResult => ({
  date: new Date('2025-01-01T00:00:00Z'), hospital: '甲醫院', testGroup: '生化', subItem: '血糖',
  value: 100, refLow: 70, refHigh: 110, unit: 'mg/dL', source: 'FHIR', code: 'loinc|2345-7', ...overrides,
});

describe('clinical lab series', () => {
  it('separates clinical codes, missing or differing units, sources, and hospitals', () => {
    const records = [reading(), reading({ code: 'local|2345-7' }), reading({ code: undefined }),
      reading({ unit: 'mmol/L' }), reading({ unit: undefined }), reading({ source: 'NHI' }),
      reading({ hospital: '乙醫院' }), reading({ source: undefined })];
    const groups = buildLabSeries(records);
    expect(groups).toHaveLength(records.length);
    expect(new Set(groups.map(group => group.key)).size).toBe(records.length);
    expect(groups.every(group => group.records.length === 1)).toBe(true);
  });

  it('groups alternate labels only when their clinical code and measurement context match', () => {
    const groups = buildLabSeries([reading(), reading({ subItem: 'Glucose', value: 105 }),
      reading({ code: undefined, subItem: 'loinc|2345-7' })]);
    expect(groups).toHaveLength(2);
    const coded = groups.find(group => group.code)!;
    expect(coded.records).toHaveLength(2);
    expect(coded.subItems).toEqual(['血糖', 'Glucose']);
  });

  it('uses provenance source when an explicit source is unavailable', () => {
    const groups = buildLabSeries([
      reading({ source: undefined, origins: [{ format: 'FHIR', source: 'import-a', id: '1' }] }),
      reading({ source: undefined, origins: [{ format: 'FHIR', source: 'import-a', id: '2' }] }),
      reading({ source: undefined, origins: [{ format: 'FHIR', source: 'import-b', id: '3' }] }),
      reading({ source: undefined, origins: [{ format: 'NHI', source: 'import-a', id: '4' }] }),
    ]);
    expect(groups.map(group => group.records.length).sort()).toEqual([1, 1, 2]);
  });

  it('keeps legacy name pins while computing each unit/source trend independently', () => {
    const records = [reading({ value: 100 }), reading({ value: 120, date: new Date('2025-02-01') }),
      reading({ value: 5, unit: 'mmol/L', refLow: 3, refHigh: 6 }),
      reading({ value: 5.5, unit: 'mmol/L', refLow: 3, refHigh: 6, date: new Date('2025-02-01') }),
      reading({ value: 300, source: 'NHI' }), reading({ value: 400, hospital: '乙醫院' })];
    const summaries = computeLabSeriesSummaries(records, ['血糖']);
    expect(summaries).toHaveLength(4);
    expect(summaries.find(summary => summary.unit === 'mmol/L')).toMatchObject({ latestValue: 5.5, delta: 0.5, readingsCount: 2 });
    expect(summaries.find(summary => summary.unit === 'mg/dL' && summary.source === 'FHIR' && summary.hospital === '甲醫院'))
      .toMatchObject({ latestValue: 120, previousValue: 100, delta: 20, readingsCount: 2 });
    expect(summaries.find(summary => summary.source === 'NHI')).toMatchObject({ latestValue: 300, previousValue: null, delta: null, readingsCount: 1 });
    expect(summaries.find(summary => summary.hospital === '乙醫院')).toMatchObject({ latestValue: 400, delta: null });
  });

  it('supports independent series pins and old display-name pins after a label change', () => {
    const records = [reading(), reading({ subItem: 'Glucose', date: new Date('2025-02-01') }), reading({ source: 'NHI' })];
    const groups = buildLabSeries(records);
    const series = groups.find(group => group.source === 'FHIR')!;
    expect(isLabSeriesPinned(series, ['血糖'])).toBe(true);
    expect(labSeriesPinTarget(series, ['血糖'])).toBe('血糖');
    expect(labSeriesPinTarget(series, [])).toBe(series.key);
    expect(computeLabSeriesSummaries(records, [series.key])).toHaveLength(1);
    expect(isLabSeriesPinned(groups.find(group => group.source === 'NHI')!, [series.key])).toBe(false);
    expect(labSeriesKey(records[0])).toBe(series.key);
  });

  it('does not reuse an older range for a reading with no range', () => {
    const records = [reading(), reading({ date: new Date('2025-02-01'), value: 200, refLow: null, refHigh: null })];
    expect(buildLabSeries(records)[0].consistentReference).toBe(false);
    const [summary] = computeLabSeriesSummaries(records, ['血糖']);
    expect(summary).toMatchObject({ refLow: null, refHigh: null, status: 'unknown', delta: 100, referenceChanged: true, worsening: false });
    expect(buildLabSeriesAlerts([summary])).toEqual([]);
  });

  it('treats changed numeric or textual reference ranges as per-reading ranges', () => {
    expect(buildLabSeries([reading(), reading({ refHigh: 120 })])[0].consistentReference).toBe(false);
    expect(buildLabSeries([reading({ refText: '成人 70–110' }), reading({ refText: '成人 70–110' })])[0].consistentReference).toBe(true);
    expect(buildLabSeries([reading({ refText: '成人' }), reading({ refText: '兒童' })])[0].consistentReference).toBe(false);
    expect(labReference(reading({ refText: '依檢驗院所判讀' }))).toBe('依檢驗院所判讀');
  });

  it('keeps alert IDs distinct for identical values and dates in separate series', () => {
    const alerts = buildLabSeriesAlerts(computeLabSeriesSummaries([
      reading({ value: 150 }), reading({ value: 150, source: 'NHI' }), reading({ value: 150, hospital: '乙醫院' }),
    ], ['血糖']));
    expect(alerts).toHaveLength(3);
    expect(new Set(alerts.map(alert => alert.id)).size).toBe(3);
    expect(alerts.some(alert => alert.message.includes('NHI'))).toBe(true);
    expect(alerts.some(alert => alert.message.includes('乙醫院'))).toBe(true);
  });
});

describe('lab series targets and abnormal overview', () => {
  const later = (overrides: Partial<LabResult> = {}) =>
    reading({ date: new Date('2025-02-01T00:00:00Z'), ...overrides });

  it('summarizes every series regardless of pins', () => {
    const records = [
      reading(),
      reading({ subItem: '膽固醇', code: 'loinc|2093-3', value: 180, refLow: null, refHigh: 200 }),
    ];
    const all = computeAllLabSeriesSummaries(records);
    expect(all).toHaveLength(buildLabSeries(records).length);
    expect(new Set(all.map(summary => summary.subItem))).toEqual(new Set(['血糖', '膽固醇']));
    expect(computeLabSeriesSummaries(records, [])).toEqual([]);
  });

  it('keeps the lab range and omits targetApplied without a target', () => {
    const [series] = buildLabSeries([reading({ value: 100, refText: '成人 70–110' })]);
    const summary = summarizeSeries(series);
    expect(summary).toMatchObject({ refLow: 70, refHigh: 110, refText: '成人 70–110', status: 'normal' });
    expect(summary).not.toHaveProperty('targetApplied');
  });

  it('re-derives the range and status from a personal target', () => {
    const [series] = buildLabSeries([reading({ value: 100, refText: '成人 70–110' })]);
    const high = summarizeSeries(series, { high: 90 });
    expect(high).toMatchObject({ targetApplied: true, refLow: null, refHigh: 90, status: 'high' });
    expect(high.refText).toBeUndefined();
    expect(summarizeSeries(series, { low: 120 }))
      .toMatchObject({ targetApplied: true, refLow: 120, refHigh: null, status: 'low' });
    expect(summarizeSeries(series, { low: 80, high: 120 }))
      .toMatchObject({ refLow: 80, refHigh: 120, status: 'normal' });
  });

  it('ignores a changed lab range once a target is applied', () => {
    const [series] = buildLabSeries([reading({ value: 100, refHigh: 110 }), later({ value: 140, refHigh: 130 })]);
    expect(summarizeSeries(series))
      .toMatchObject({ referenceChanged: true, status: 'high', worsening: false });
    expect(summarizeSeries(series, { high: 90 }))
      .toMatchObject({ referenceChanged: false, status: 'high', worsening: true, delta: 40 });
  });

  it('applies a target only to the series it belongs to', () => {
    const records = [reading(), reading({ subItem: '膽固醇', code: 'loinc|2093-3', value: 100 })];
    const glucose = buildLabSeries(records).find(series => series.subItem === '血糖')!;
    const summaries = computeAllLabSeriesSummaries(records, { [glucose.key]: { high: 90 } });
    expect(summaries.find(summary => summary.subItem === '血糖')).toMatchObject({ targetApplied: true, status: 'high' });
    const cholesterol = summaries.find(summary => summary.subItem === '膽固醇');
    expect(cholesterol).toMatchObject({ status: 'normal', refLow: 70, refHigh: 110 });
    expect(cholesterol).not.toHaveProperty('targetApplied');
  });

  it('applies targets to pinned series by series key or by legacy name', () => {
    const records = [reading({ value: 100 })];
    const [series] = buildLabSeries(records);
    const targets = { [series.key]: { low: 80, high: 120 } };

    for (const pinned of [[series.key], ['血糖']]) {
      expect(computeLabSeriesSummaries(records, pinned, targets))
        .toMatchObject([{ targetApplied: true, refLow: 80, refHigh: 120, status: 'normal' }]);
    }

    const [unrelated] = computeLabSeriesSummaries(records, [series.key], { 'lab-series:other': { high: 1 } });
    expect(unrelated).toMatchObject({ refLow: 70, refHigh: 110, status: 'normal' });
    expect(unrelated).not.toHaveProperty('targetApplied');
  });

  it('recognizes only high and low summaries as abnormal', () => {
    expect(isAbnormalSummary({ status: 'high' })).toBe(true);
    expect(isAbnormalSummary({ status: 'low' })).toBe(true);
    expect(isAbnormalSummary({ status: 'normal' })).toBe(false);
    expect(isAbnormalSummary({ status: 'unknown' })).toBe(false);
  });

  it('lists abnormal series worsening first, then newest, then by name, without mutating the input', () => {
    const march = new Date('2025-03-01T00:00:00Z');
    const records = [
      reading({ subItem: 'Delta', code: 'c|d', value: 100 }),
      later({ subItem: 'Delta', code: 'c|d', value: 120 }),
      reading({ subItem: 'Beta', code: 'c|b', value: 130, date: march }),
      reading({ subItem: 'Alpha', code: 'c|a', value: 130, date: march }),
      reading({ subItem: 'Echo', code: 'c|e', value: 50, date: new Date('2025-01-15T00:00:00Z') }),
      reading({ subItem: 'Normal', code: 'c|n', value: 90 }),
    ];
    const summaries = computeAllLabSeriesSummaries(records).reverse();
    const before = summaries.map(summary => summary.key);

    const abnormal = abnormalLabSeriesSummaries(summaries);

    expect(abnormal.map(summary => summary.subItem)).toEqual(['Delta', 'Alpha', 'Beta', 'Echo']);
    expect(abnormal.map(summary => summary.status)).toEqual(['high', 'high', 'high', 'low']);
    expect(summaries.map(summary => summary.key)).toEqual(before);
    expect(abnormal).not.toBe(summaries);
  });

  it('falls back to the series key when name and date are identical', () => {
    const summaries = computeAllLabSeriesSummaries([
      reading({ value: 130, hospital: 'Hosp B' }), reading({ value: 130, hospital: 'Hosp A' }),
    ]).reverse();
    expect(abnormalLabSeriesSummaries(summaries).map(summary => summary.hospital)).toEqual(['Hosp A', 'Hosp B']);
  });

  it('returns an empty list when nothing is abnormal', () => {
    expect(abnormalLabSeriesSummaries(computeAllLabSeriesSummaries([reading({ value: 90 })]))).toEqual([]);
    expect(abnormalLabSeriesSummaries([])).toEqual([]);
  });

  it('words alerts with the personal target only when one was applied', () => {
    const [series] = buildLabSeries([reading({ value: 100 })]);

    const [plain] = buildLabSeriesAlerts(computeAllLabSeriesSummaries([reading({ value: 150 })]));
    expect(plain.message).toBe('mg/dL · 甲醫院 · FHIR｜血糖 偏高：150（參考 70–110）');

    const [targeted] = buildLabSeriesAlerts(
      computeAllLabSeriesSummaries([reading({ value: 100 })], { [series.key]: { high: 90 } }),
    );
    expect(targeted.message).toBe('mg/dL · 甲醫院 · FHIR｜血糖 偏高：100（個人目標上限 90）');

    const lenient = computeAllLabSeriesSummaries([reading({ value: 150 })], { [series.key]: { high: 200 } });
    expect(buildLabSeriesAlerts(lenient)).toEqual([]);
  });
});
