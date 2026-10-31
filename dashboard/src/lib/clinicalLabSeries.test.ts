import { describe, expect, it } from 'vitest';
import type { LabResult } from '../parsers/types';
import {
  buildLabSeries, buildLabSeriesAlerts, computeLabSeriesSummaries, isLabSeriesPinned,
  labReference, labSeriesKey, labSeriesPinTarget,
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
