import { describe, expect, it } from 'vitest';
import type { Visit } from '../parsers/types';
import {
  buildAlerts, computeAllMedicationSummaries, computeMedicationSummaries, formatDay, formatLabValue, isDrugCode,
  statusFor, type LabSummary,
} from './keySummary';

const DAY = 86_400_000;

const proc = (code: string, name: string, qty = 1) => ({ code, name, qty });

function visit(date: Date, procedures: Visit['procedures']): Visit {
  return { date, hospital: '甲醫院', diagnoses: [], procedures };
}

describe('isDrugCode', () => {
  it('accepts codes that start with two uppercase letters only', () => {
    expect(isDrugCode('AB12345678')).toBe(true);
    expect(isDrugCode('A1')).toBe(false);
    expect(isDrugCode('ab1')).toBe(false);
    expect(isDrugCode('01012B')).toBe(false);
    expect(isDrugCode('')).toBe(false);
  });
});

describe('computeMedicationSummaries (pinned)', () => {
  it('follows the pinned order and skips unpinned or unseen codes', () => {
    const visits = [visit(new Date(2025, 0, 10), [proc('AA1', '藥甲'), proc('BB2', '藥乙'), proc('CC3', '藥丙')])];
    const result = computeMedicationSummaries(visits, ['CC3', 'ZZ9', 'AA1']);
    expect(result.map(m => m.code)).toEqual(['CC3', 'AA1']);
  });

  it('totals appearances and keeps the latest date regardless of visit order', () => {
    const visits = [
      visit(new Date(2025, 2, 1), [proc('AA1', '藥甲')]),
      visit(new Date(2025, 0, 1), [proc('AA1', '藥甲')]),
      visit(new Date(2025, 1, 1), [proc('AA1', '藥甲')]),
    ];
    const [summary] = computeMedicationSummaries(visits, ['AA1']);
    expect(summary.count).toBe(3);
    expect(summary.lastDate).toEqual(new Date(2025, 2, 1));
  });

  it('uses the most frequent name, the first seen on a tie, and the code when no name exists', () => {
    const frequent = [
      visit(new Date(2025, 0, 1), [proc('AA1', '舊名')]),
      visit(new Date(2025, 1, 1), [proc('AA1', '新名')]),
      visit(new Date(2025, 2, 1), [proc('AA1', '新名')]),
    ];
    expect(computeMedicationSummaries(frequent, ['AA1'])[0].name).toBe('新名');

    const tie = [
      visit(new Date(2025, 0, 1), [proc('AA1', '甲名')]),
      visit(new Date(2025, 1, 1), [proc('AA1', '乙名')]),
    ];
    expect(computeMedicationSummaries(tie, ['AA1'])[0].name).toBe('甲名');

    const unnamed = [visit(new Date(2025, 0, 1), [proc('AA1', '')])];
    expect(computeMedicationSummaries(unnamed, ['AA1'])[0].name).toBe('AA1');
  });

  it('measures the 90-day window from the latest visit in the data, not from today', () => {
    const latest = new Date(2025, 5, 30);
    const visits = [
      visit(new Date(latest.getTime() - 90 * DAY - 1), [proc('AA1', '藥甲')]),
      visit(new Date(latest.getTime() - 90 * DAY), [proc('AA1', '藥甲')]),
      visit(latest, [proc('AA1', '藥甲')]),
    ];
    const [summary] = computeMedicationSummaries(visits, ['AA1']);
    expect(summary.count).toBe(3);
    expect(summary.recentCount).toBe(2);
  });
});

describe('computeAllMedicationSummaries', () => {
  it('returns an empty list when there are no visits or orders', () => {
    expect(computeAllMedicationSummaries([])).toEqual([]);
    expect(computeAllMedicationSummaries([visit(new Date(2025, 0, 1), [])])).toEqual([]);
  });

  it('keeps only drug codes and ignores fees, lowercase and empty codes', () => {
    const visits = [visit(new Date(2025, 0, 1), [
      proc('AA1', '藥甲'), proc('01012B', '診察費'), proc('', '無代碼'), proc('a1', '小寫'),
    ])];
    expect(computeAllMedicationSummaries(visits).map(m => m.code)).toEqual(['AA1']);
  });

  it('sorts by last prescribed date, then count, then code', () => {
    const visits = [
      visit(new Date(2025, 0, 1), [proc('AA1', '藥甲'), proc('BB2', '藥乙')]),
      visit(new Date(2025, 1, 1), [proc('CC3', '藥丙'), proc('BB2', '藥乙')]),
      visit(new Date(2025, 1, 1), [proc('AA0', '藥丁')]),
    ];
    expect(computeAllMedicationSummaries(visits).map(m => m.code)).toEqual(['BB2', 'AA0', 'CC3', 'AA1']);
  });

  it('reports the same figures as the pinned variant for every code', () => {
    const latest = new Date(2025, 5, 30);
    const visits = [
      visit(new Date(2025, 0, 5), [proc('AA1', '藥甲'), proc('BB2', '藥乙')]),
      visit(new Date(latest.getTime() - 30 * DAY), [proc('AA1', '藥甲新名'), proc('AA1', '藥甲新名')]),
      visit(latest, [proc('CC3', '藥丙')]),
    ];
    const all = computeAllMedicationSummaries(visits);
    expect(all).toHaveLength(3);
    for (const entry of all) {
      expect(computeMedicationSummaries(visits, [entry.code])).toEqual([entry]);
    }
  });
});

const labSummary = (overrides: Partial<LabSummary> = {}): LabSummary => ({
  subItem: '血糖', testGroup: '生化', latestValue: 130, latestDate: new Date(2025, 5, 1),
  previousValue: null, refLow: 70, refHigh: 110, status: 'high', delta: null, trend: null,
  worsening: false, readingsCount: 1, ...overrides,
});

describe('statusFor', () => {
  it('flags values above the upper bound as high and below the lower bound as low', () => {
    expect(statusFor(111, 70, 110)).toBe('high');
    expect(statusFor(69, 70, 110)).toBe('low');
  });

  it('treats values on or inside the bounds as normal', () => {
    expect(statusFor(70, 70, 110)).toBe('normal');
    expect(statusFor(110, 70, 110)).toBe('normal');
    expect(statusFor(90, 70, 110)).toBe('normal');
  });

  it('only checks the bound that exists for a one-sided range', () => {
    expect(statusFor(11, null, 10)).toBe('high');
    expect(statusFor(-100, null, 10)).toBe('normal');
    expect(statusFor(9, 10, null)).toBe('low');
    expect(statusFor(1000, 10, null)).toBe('normal');
  });

  it('is unknown when neither bound exists', () => {
    expect(statusFor(100, null, null)).toBe('unknown');
  });
});

describe('buildAlerts', () => {
  it('skips normal and unknown summaries', () => {
    const alerts = buildAlerts([
      labSummary({ status: 'normal', latestValue: 90 }),
      labSummary({ status: 'unknown', refLow: null, refHigh: null }),
    ]);
    expect(alerts).toEqual([]);
  });

  it('describes a two-sided and a one-sided lab range', () => {
    expect(buildAlerts([labSummary()])[0].message).toBe('血糖 偏高：130（參考 70–110）');
    expect(buildAlerts([labSummary({ refLow: null })])[0].message).toBe('血糖 偏高：130（參考上限 110）');
    expect(buildAlerts([labSummary({ status: 'low', latestValue: 60, refHigh: null })])[0].message)
      .toBe('血糖 偏低：60（參考下限 70）');
  });

  it('omits the range when no bound exists', () => {
    expect(buildAlerts([labSummary({ refLow: null, refHigh: null })])[0].message).toBe('血糖 偏高：130');
  });

  it('names the personal target instead of the lab range when one was applied', () => {
    expect(buildAlerts([labSummary({ targetApplied: true, refLow: 70, refHigh: 90 })])[0].message)
      .toBe('血糖 偏高：130（個人目標 70–90）');
    expect(buildAlerts([labSummary({ targetApplied: true, refLow: null, refHigh: 90 })])[0].message)
      .toBe('血糖 偏高：130（個人目標上限 90）');
    expect(buildAlerts([
      labSummary({ targetApplied: true, status: 'low', latestValue: 60, refLow: 80, refHigh: null }),
    ])[0].message).toBe('血糖 偏低：60（個人目標下限 80）');
  });

  it('never mentions a personal target for a plain lab range', () => {
    for (const refLow of [70, null]) {
      expect(buildAlerts([labSummary({ refLow })])[0].message).not.toContain('個人目標');
    }
  });

  it('marks a worsening abnormal result as high severity', () => {
    const [watch] = buildAlerts([labSummary()]);
    const [high] = buildAlerts([labSummary({ worsening: true })]);
    expect(watch.severity).toBe('watch');
    expect(watch.message).not.toContain('惡化');
    expect(high.severity).toBe('high');
    expect(high.message).toBe('血糖 偏高：130（參考 70–110），且較上次惡化');
  });

  it('keys the alert by item and local calendar day', () => {
    const [alert] = buildAlerts([labSummary({ latestDate: new Date(2025, 0, 5, 23, 30) })]);
    expect(alert.id).toBe('lab:血糖:2025-01-05');
    expect(alert.subItem).toBe('血糖');
  });

  it('lists high severity first, then the most recent', () => {
    const alerts = buildAlerts([
      labSummary({ subItem: '甲', latestDate: new Date(2025, 5, 10) }),
      labSummary({ subItem: '乙', latestDate: new Date(2025, 0, 1), worsening: true }),
      labSummary({ subItem: '丙', latestDate: new Date(2025, 6, 1) }),
    ]);
    expect(alerts.map(a => a.subItem)).toEqual(['乙', '丙', '甲']);
  });
});

describe('formatLabValue', () => {
  it('keeps whole numbers as they are', () => {
    expect(formatLabValue(100)).toBe('100');
    expect(formatLabValue(0)).toBe('0');
    expect(formatLabValue(-3)).toBe('-3');
  });

  it('shows everything else with two decimals', () => {
    expect(formatLabValue(5.5)).toBe('5.50');
    expect(formatLabValue(1.234)).toBe('1.23');
    expect(formatLabValue(-2.5)).toBe('-2.50');
  });
});

describe('formatDay', () => {
  it('zero-pads month and day', () => {
    expect(formatDay(new Date(2026, 9, 5))).toBe('2026-10-05');
    expect(formatDay(new Date(2025, 0, 1))).toBe('2025-01-01');
  });

  it('uses the local calendar day, even late in the evening', () => {
    expect(formatDay(new Date(2025, 0, 31, 23, 59))).toBe('2025-01-31');
  });
});
