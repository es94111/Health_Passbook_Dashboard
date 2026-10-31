import { describe, expect, it } from 'vitest';
import type {
  BloodPressureMeasurement,
  GlucoseContext,
  GlucoseMeasurement,
  WeightMeasurement,
} from '../personalData';
import {
  CHART_RANGE_OPTIONS,
  GLUCOSE_CONTEXT_LABEL,
  MEASUREMENT_KIND_LABEL,
  MEASUREMENT_UNIT,
  buildTrendPoints,
  describeSummary,
  filterByChartRange,
  formatMeasurementMoment,
  formatMeasurementValue,
  isChartRange,
  isGlucoseContext,
  splitByKind,
  summarizeMeasurements,
  validateBloodPressure,
  validateGlucose,
  validateWeight,
} from './measurements';
import type {
  BloodPressureInput,
  ChartRange,
  GlucoseInput,
  NewMeasurement,
  ValidationResult,
  WeightInput,
} from './measurements';

const NOW = new Date(2026, 9, 31, 12, 0, 0);

interface Extra {
  time?: string;
  note?: string;
}

function bp(
  id: string,
  date: string,
  systolic: number,
  diastolic: number,
  extra: Extra & { pulse?: number } = {},
): BloodPressureMeasurement {
  return { id, kind: 'bp', date, systolic, diastolic, ...extra };
}

function glucose(
  id: string,
  date: string,
  value: number,
  extra: Extra & { context?: GlucoseContext } = {},
): GlucoseMeasurement {
  const { context = 'fasting', ...rest } = extra;
  return { id, kind: 'glucose', date, value, context, ...rest };
}

function weight(id: string, date: string, value: number, extra: Extra = {}): WeightMeasurement {
  return { id, kind: 'weight', date, value, ...extra };
}

function bpInput(overrides: Partial<BloodPressureInput> = {}): BloodPressureInput {
  return { date: '2026-10-31', time: '', systolic: '120', diastolic: '80', pulse: '', note: '', ...overrides };
}

function glucoseInput(overrides: Partial<GlucoseInput> = {}): GlucoseInput {
  return { date: '2026-10-31', time: '', value: '95', context: 'fasting', note: '', ...overrides };
}

function weightInput(overrides: Partial<WeightInput> = {}): WeightInput {
  return { date: '2026-10-31', time: '', value: '70', note: '', ...overrides };
}

function unwrap<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`驗證失敗：${result.error}`);
  return result.value;
}

function failure(error: string) {
  return { ok: false, error };
}

describe('常數與型別守衛', () => {
  it('提供繁體中文的類型、單位與情境標籤', () => {
    expect(MEASUREMENT_KIND_LABEL).toEqual({ bp: '血壓', glucose: '血糖', weight: '體重' });
    expect(MEASUREMENT_UNIT).toEqual({ bp: 'mmHg', glucose: 'mg/dL', weight: 'kg' });
    expect(GLUCOSE_CONTEXT_LABEL).toEqual({ fasting: '空腹', postMeal: '餐後', random: '隨機' });
  });

  it('isGlucoseContext 只接受三種情境', () => {
    expect(['fasting', 'postMeal', 'random'].every(value => isGlucoseContext(value))).toBe(true);
    expect(isGlucoseContext('')).toBe(false);
    expect(isGlucoseContext('breakfast')).toBe(false);
  });

  it('圖表範圍選項依序為近 30 天、近 90 天、近 1 年、全部，且皆通過 isChartRange', () => {
    expect(CHART_RANGE_OPTIONS.map(option => option.label)).toEqual(['近 30 天', '近 90 天', '近 1 年', '全部']);
    expect(CHART_RANGE_OPTIONS.every(option => isChartRange(option.value))).toBe(true);
    expect(isChartRange('7')).toBe(false);
    expect(isChartRange('')).toBe(false);
  });
});

describe('splitByKind', () => {
  it('空陣列回傳三個空陣列', () => {
    expect(splitByKind([])).toEqual({ bp: [], glucose: [], weight: [] });
  });

  it('依類型分組', () => {
    const result = splitByKind([
      weight('w1', '2026-10-30', 70),
      bp('b1', '2026-10-30', 120, 80),
      glucose('g1', '2026-10-30', 95),
    ]);
    expect(result.bp.map(item => item.id)).toEqual(['b1']);
    expect(result.glucose.map(item => item.id)).toEqual(['g1']);
    expect(result.weight.map(item => item.id)).toEqual(['w1']);
  });

  it('各陣列依日期升冪排序', () => {
    const result = splitByKind([
      weight('c', '2026-10-31', 72),
      weight('a', '2025-12-31', 70),
      weight('b', '2026-01-01', 71),
    ]);
    expect(result.weight.map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('同一天未填時間者排最前，其後依時間升冪', () => {
    const result = splitByKind([
      bp('late', '2026-10-30', 130, 85, { time: '21:30' }),
      bp('early', '2026-10-30', 125, 82, { time: '07:00' }),
      bp('none', '2026-10-30', 120, 80),
    ]);
    expect(result.bp.map(item => item.id)).toEqual(['none', 'early', 'late']);
  });

  it('同日同時間以 id 穩定排序，與輸入順序無關', () => {
    const a = weight('a', '2026-10-30', 70, { time: '08:00' });
    const b = weight('b', '2026-10-30', 71, { time: '08:00' });
    const c = weight('c', '2026-10-30', 72, { time: '08:00' });
    expect(splitByKind([c, a, b]).weight.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(splitByKind([b, c, a]).weight.map(item => item.id)).toEqual(['a', 'b', 'c']);
  });

  it('不修改傳入的陣列', () => {
    const input = [weight('b', '2026-10-31', 71), weight('a', '2026-10-30', 70)];
    splitByKind(input);
    expect(input.map(item => item.id)).toEqual(['b', 'a']);
  });
});

describe('summarizeMeasurements', () => {
  it('沒有任何資料時筆數為 0、latest 與平均皆為 null', () => {
    const summary = summarizeMeasurements([], NOW);
    expect(summary.bp).toEqual({
      count: 0,
      latest: null,
      systolic: { avg7: null, avg30: null },
      diastolic: { avg7: null, avg30: null },
    });
    expect(summary.glucose).toEqual({ count: 0, latest: null, value: { avg7: null, avg30: null } });
    expect(summary.weight).toEqual({ count: 0, latest: null, value: { avg7: null, avg30: null } });
  });

  it('只有今天一筆時，最新值與兩個平均皆等於該筆', () => {
    const summary = summarizeMeasurements([weight('a', '2026-10-31', 70.5)], NOW).weight;
    expect(summary.count).toBe(1);
    expect(summary.latest?.id).toBe('a');
    expect(summary.value.avg7).toBeCloseTo(70.5, 5);
    expect(summary.value.avg30).toBeCloseTo(70.5, 5);
  });

  const WINDOW_CASES: Array<[string, Date, string, boolean, boolean]> = [
    ['今天', NOW, '2026-10-31', true, true],
    ['6 天前仍在 7 日窗口內', NOW, '2026-10-25', true, true],
    ['7 天前已在 7 日窗口外、仍在 30 日內', NOW, '2026-10-24', false, true],
    ['29 天前仍在 30 日窗口內', NOW, '2026-10-02', false, true],
    ['30 天前已在 30 日窗口外', NOW, '2026-10-01', false, false],
    ['明天（未來日期）不納入任何平均', NOW, '2026-11-01', false, false],
    ['跨月：6 天前', new Date(2026, 10, 3, 9, 30), '2026-10-28', true, true],
    ['跨月：7 天前', new Date(2026, 10, 3, 9, 30), '2026-10-27', false, true],
    ['跨年：6 天前', new Date(2026, 0, 3, 8, 0), '2025-12-28', true, true],
    ['跨年：7 天前', new Date(2026, 0, 3, 8, 0), '2025-12-27', false, true],
    ['跨年：29 天前', new Date(2026, 0, 3, 8, 0), '2025-12-05', false, true],
    ['跨年：30 天前', new Date(2026, 0, 3, 8, 0), '2025-12-04', false, false],
    ['閏年 2 月：6 天前', new Date(2028, 2, 1, 23, 59, 59), '2028-02-24', true, true],
    ['閏年 2 月：7 天前', new Date(2028, 2, 1, 23, 59, 59), '2028-02-23', false, true],
  ];

  it.each(WINDOW_CASES)('平均窗口邊界：%s', (_label, now, date, inSevenDays, inThirtyDays) => {
    const summary = summarizeMeasurements([weight('a', date, 70)], now).weight;
    expect(summary.value.avg7 !== null).toBe(inSevenDays);
    expect(summary.value.avg30 !== null).toBe(inThirtyDays);
  });

  it('now 的時分秒不影響以日曆日計算的窗口', () => {
    const readings = [weight('a', '2026-10-25', 70), weight('b', '2026-10-24', 80)];
    const morning = summarizeMeasurements(readings, new Date(2026, 9, 31, 0, 0, 0)).weight;
    const night = summarizeMeasurements(readings, new Date(2026, 9, 31, 23, 59, 59)).weight;
    expect(morning.value).toEqual(night.value);
    expect(morning.value.avg7).toBeCloseTo(70, 5);
    expect(morning.value.avg30).toBeCloseTo(75, 5);
  });

  it('未來日期不納入平均，但仍計入筆數', () => {
    const summary = summarizeMeasurements(
      [weight('a', '2026-10-31', 70), weight('b', '2026-11-05', 999)],
      NOW,
    ).weight;
    expect(summary.count).toBe(2);
    expect(summary.value.avg7).toBeCloseTo(70, 5);
    expect(summary.value.avg30).toBeCloseTo(70, 5);
  });

  it('血壓的收縮壓與舒張壓分別計算 7 日與 30 日平均', () => {
    const summary = summarizeMeasurements(
      [
        bp('a', '2026-10-31', 120, 80),
        bp('b', '2026-10-29', 130, 90),
        bp('c', '2026-10-25', 140, 100),
        bp('d', '2026-10-24', 150, 110),
        bp('e', '2026-10-01', 160, 120),
      ],
      NOW,
    ).bp;
    expect(summary.count).toBe(5);
    expect(summary.latest?.id).toBe('a');
    expect(summary.systolic.avg7).toBeCloseTo(130, 5);
    expect(summary.diastolic.avg7).toBeCloseTo(90, 5);
    expect(summary.systolic.avg30).toBeCloseTo(135, 5);
    expect(summary.diastolic.avg30).toBeCloseTo(95, 5);
  });

  it('平均值不四捨五入', () => {
    const summary = summarizeMeasurements(
      [glucose('a', '2026-10-31', 100), glucose('b', '2026-10-30', 101), glucose('c', '2026-10-29', 101)],
      NOW,
    ).glucose;
    expect(summary.value.avg7).toBeCloseTo(302 / 3, 10);
  });

  it('同一天的多筆讀值都納入平均', () => {
    const summary = summarizeMeasurements(
      [weight('a', '2026-10-31', 70, { time: '07:00' }), weight('b', '2026-10-31', 72, { time: '21:00' })],
      NOW,
    ).weight;
    expect(summary.value.avg7).toBeCloseTo(71, 5);
  });

  it('latest 是排序後的最後一筆，而非最後加入的一筆', () => {
    const summary = summarizeMeasurements(
      [weight('z', '2026-10-30', 71), weight('a', '2026-10-31', 70.5), weight('m', '2026-10-29', 72)],
      NOW,
    ).weight;
    expect(summary.latest?.id).toBe('a');
  });

  it('三種類型彼此獨立計算', () => {
    const summary = summarizeMeasurements(
      [glucose('g', '2026-10-31', 95), weight('w', '2026-10-31', 70), bp('b', '2026-10-31', 120, 80)],
      NOW,
    );
    expect(summary.glucose.value.avg7).toBeCloseTo(95, 5);
    expect(summary.weight.value.avg7).toBeCloseTo(70, 5);
    expect(summary.bp.systolic.avg7).toBeCloseTo(120, 5);
    expect(summary.bp.diastolic.avg7).toBeCloseTo(80, 5);
  });
});

describe('describeSummary', () => {
  it('無資料時以「—」表示，且沒有最新時間', () => {
    expect(describeSummary(summarizeMeasurements([], NOW), 'weight')).toEqual({
      count: 0,
      latestValue: '—',
      latestMoment: null,
      avg7: '—',
      avg30: '—',
    });
  });

  it('血壓顯示「收縮/舒張」並以 0 位小數呈現平均', () => {
    const summary = summarizeMeasurements(
      [
        bp('a', '2026-10-31', 120, 80, { time: '07:30' }),
        bp('b', '2026-10-29', 130, 90),
        bp('c', '2026-10-25', 140, 100),
        bp('d', '2026-10-24', 150, 110),
      ],
      NOW,
    );
    expect(describeSummary(summary, 'bp')).toEqual({
      count: 4,
      latestValue: '120/80',
      latestMoment: '2026-10-31 07:30',
      avg7: '130/90',
      avg30: '135/95',
    });
  });

  it('血糖平均以 0 位小數、體重平均以 1 位小數呈現', () => {
    const summary = summarizeMeasurements(
      [
        glucose('g1', '2026-10-31', 100),
        glucose('g2', '2026-10-30', 100),
        glucose('g3', '2026-10-29', 101),
        weight('w1', '2026-10-31', 70),
        weight('w2', '2026-10-30', 71),
        weight('w3', '2026-10-29', 71),
      ],
      NOW,
    );
    expect(describeSummary(summary, 'glucose').avg7).toBe('100');
    expect(describeSummary(summary, 'weight').avg7).toBe('70.7');
    expect(describeSummary(summary, 'weight').latestValue).toBe('70.0');
  });

  it('只有 30 日內（不在 7 日內）的資料時，7 日平均為「—」', () => {
    const summary = summarizeMeasurements([weight('a', '2026-10-10', 70)], NOW);
    const display = describeSummary(summary, 'weight');
    expect(display.avg7).toBe('—');
    expect(display.avg30).toBe('70.0');
  });
});

describe('格式化輔助函式', () => {
  it('formatMeasurementValue 依類型格式化', () => {
    expect(formatMeasurementValue(bp('a', '2026-10-31', 125, 80))).toBe('125/80');
    expect(formatMeasurementValue(glucose('b', '2026-10-31', 95.5))).toBe('95.5');
    expect(formatMeasurementValue(glucose('c', '2026-10-31', 100))).toBe('100');
    expect(formatMeasurementValue(weight('d', '2026-10-31', 70))).toBe('70.0');
  });

  it('formatMeasurementMoment 有時間才附上時間', () => {
    expect(formatMeasurementMoment(weight('a', '2026-10-31', 70))).toBe('2026-10-31');
    expect(formatMeasurementMoment(weight('b', '2026-10-31', 70, { time: '07:05' }))).toBe('2026-10-31 07:05');
  });
});

describe('filterByChartRange', () => {
  const RANGE_CASES: Array<[ChartRange, string, boolean]> = [
    ['30', '2026-10-02', true],
    ['30', '2026-10-01', false],
    ['90', '2026-08-03', true],
    ['90', '2026-08-02', false],
    ['365', '2025-11-01', true],
    ['365', '2025-10-31', false],
    ['30', '2026-11-01', false],
    ['all', '2026-11-01', true],
    ['all', '1999-01-01', true],
  ];

  it.each(RANGE_CASES)('範圍 %s：%s 是否保留 → %s', (range, date, kept) => {
    expect(filterByChartRange([weight('x', date, 70)], range, NOW)).toHaveLength(kept ? 1 : 0);
  });

  it('保留原本的排序，且不修改傳入的陣列', () => {
    const input = [weight('a', '2026-10-29', 70), weight('b', '2026-10-30', 71), weight('c', '2026-10-31', 72)];
    const result = filterByChartRange(input, 'all', NOW);
    expect(result.map(item => item.id)).toEqual(['a', 'b', 'c']);
    expect(result).not.toBe(input);
  });
});

describe('buildTrendPoints', () => {
  it('血壓每點含收縮壓（primary）與舒張壓（secondary）', () => {
    const points = buildTrendPoints([
      bp('a', '2026-10-30', 120, 80, { time: '07:30' }),
      bp('b', '2026-10-31', 130, 85),
    ]);
    expect(points).toEqual([
      { index: 0, id: 'a', label: '2026-10-30 07:30', primary: 120, secondary: 80 },
      { index: 1, id: 'b', label: '2026-10-31', primary: 130, secondary: 85 },
    ]);
  });

  it('血糖與體重只有 primary，不含 secondary 欄位', () => {
    expect(buildTrendPoints([glucose('g', '2026-10-31', 95)])).toStrictEqual([
      { index: 0, id: 'g', label: '2026-10-31', primary: 95 },
    ]);
    expect(buildTrendPoints([weight('w', '2026-10-31', 70.5)])).toStrictEqual([
      { index: 0, id: 'w', label: '2026-10-31', primary: 70.5 },
    ]);
  });
});

describe('validateBloodPressure', () => {
  it('成功時回傳完整欄位且不含 id', () => {
    const value = unwrap(validateBloodPressure(bpInput({ pulse: '72', time: '07:30', note: '晨起量測' }), NOW));
    expect(value).toEqual({
      kind: 'bp',
      systolic: 120,
      diastolic: 80,
      pulse: 72,
      date: '2026-10-31',
      time: '07:30',
      note: '晨起量測',
    });
    expect('id' in value).toBe(false);
  });

  it('選填欄位空白時不含 pulse、time、note 欄位', () => {
    const value = unwrap(validateBloodPressure(bpInput({ pulse: '  ', time: ' ', note: '   ' }), NOW));
    expect(Object.keys(value).sort()).toEqual(['date', 'diastolic', 'kind', 'systolic']);
    expect('pulse' in value).toBe(false);
    expect('time' in value).toBe(false);
    expect('note' in value).toBe(false);
  });

  it('輸入前後的空白會被修剪', () => {
    const value = unwrap(
      validateBloodPressure(
        bpInput({ systolic: ' 130 ', diastolic: ' 85', pulse: '70 ', date: ' 2026-10-30 ', time: ' 08:15 ', note: '  飯後  ' }),
        NOW,
      ),
    );
    expect(value).toEqual({
      kind: 'bp',
      systolic: 130,
      diastolic: 85,
      pulse: 70,
      date: '2026-10-30',
      time: '08:15',
      note: '飯後',
    });
  });

  const BOUNDARY_CASES: Array<[string, Partial<BloodPressureInput>, Partial<BloodPressureMeasurement>]> = [
    ['收縮壓下限 30', { systolic: '30', diastolic: '10' }, { systolic: 30, diastolic: 10 }],
    ['收縮壓上限 300', { systolic: '300', diastolic: '80' }, { systolic: 300 }],
    ['舒張壓下限 10', { systolic: '120', diastolic: '10' }, { diastolic: 10 }],
    ['舒張壓上限 200', { systolic: '250', diastolic: '200' }, { diastolic: 200 }],
    ['脈搏下限 20', { pulse: '20' }, { pulse: 20 }],
    ['脈搏上限 300', { pulse: '300' }, { pulse: 300 }],
    ['收縮壓僅比舒張壓大 1', { systolic: '81', diastolic: '80' }, { systolic: 81, diastolic: 80 }],
  ];

  it.each(BOUNDARY_CASES)('邊界值可通過：%s', (_label, overrides, expected) => {
    expect(unwrap(validateBloodPressure(bpInput(overrides), NOW))).toMatchObject(expected);
  });

  const ERROR_CASES: Array<[string, Partial<BloodPressureInput>, string]> = [
    ['收縮壓空白', { systolic: '' }, '請輸入收縮壓'],
    ['收縮壓只有空白字元', { systolic: '   ' }, '請輸入收縮壓'],
    ['收縮壓不是數字', { systolic: 'abc' }, '收縮壓必須是數字'],
    ['收縮壓為負數', { systolic: '-120' }, '收縮壓必須是數字'],
    ['收縮壓為科學記號', { systolic: '1e2' }, '收縮壓必須是數字'],
    ['收縮壓有小數', { systolic: '120.5' }, '收縮壓必須是整數'],
    ['收縮壓低於 30', { systolic: '29' }, '收縮壓需介於 30–300 mmHg'],
    ['收縮壓高於 300', { systolic: '301' }, '收縮壓需介於 30–300 mmHg'],
    ['舒張壓空白', { diastolic: '' }, '請輸入舒張壓'],
    ['舒張壓不是數字', { diastolic: 'x' }, '舒張壓必須是數字'],
    ['舒張壓有小數', { diastolic: '80.5' }, '舒張壓必須是整數'],
    ['舒張壓低於 10', { diastolic: '9' }, '舒張壓需介於 10–200 mmHg'],
    ['舒張壓高於 200', { systolic: '250', diastolic: '201' }, '舒張壓需介於 10–200 mmHg'],
    ['收縮壓等於舒張壓', { systolic: '80', diastolic: '80' }, '收縮壓必須大於舒張壓'],
    ['收縮壓小於舒張壓', { systolic: '80', diastolic: '90' }, '收縮壓必須大於舒張壓'],
    ['脈搏不是數字', { pulse: 'abc' }, '脈搏必須是數字'],
    ['脈搏有小數', { pulse: '72.5' }, '脈搏必須是整數'],
    ['脈搏低於 20', { pulse: '19' }, '脈搏需介於 20–300 次/分'],
    ['脈搏高於 300', { pulse: '301' }, '脈搏需介於 20–300 次/分'],
  ];

  it.each(ERROR_CASES)('失敗：%s', (_label, overrides, message) => {
    expect(validateBloodPressure(bpInput(overrides), NOW)).toEqual(failure(message));
  });

  it('依序檢查：先收縮壓、再舒張壓、再大小關係、再脈搏、最後日期', () => {
    expect(validateBloodPressure(bpInput({ systolic: '', diastolic: '', date: '' }), NOW)).toEqual(
      failure('請輸入收縮壓'),
    );
    expect(validateBloodPressure(bpInput({ systolic: '20', diastolic: '300' }), NOW)).toEqual(
      failure('收縮壓需介於 30–300 mmHg'),
    );
    expect(validateBloodPressure(bpInput({ systolic: '120', diastolic: '5', date: '' }), NOW)).toEqual(
      failure('舒張壓需介於 10–200 mmHg'),
    );
    expect(validateBloodPressure(bpInput({ systolic: '100', diastolic: '150', pulse: 'x', date: '' }), NOW)).toEqual(
      failure('收縮壓必須大於舒張壓'),
    );
    expect(validateBloodPressure(bpInput({ pulse: 'x', date: '' }), NOW)).toEqual(failure('脈搏必須是數字'));
  });
});

describe('validateGlucose', () => {
  it('成功時回傳完整欄位且不含 id', () => {
    const value = unwrap(
      validateGlucose(glucoseInput({ value: '95.5', context: 'postMeal', time: '13:20', note: '午餐後' }), NOW),
    );
    expect(value).toEqual({
      kind: 'glucose',
      value: 95.5,
      context: 'postMeal',
      date: '2026-10-31',
      time: '13:20',
      note: '午餐後',
    });
    expect('id' in value).toBe(false);
  });

  it('time 與 note 空白時不含這兩個欄位', () => {
    const value = unwrap(validateGlucose(glucoseInput(), NOW));
    expect(Object.keys(value).sort()).toEqual(['context', 'date', 'kind', 'value']);
  });

  it.each<[string, GlucoseContext]>([
    ['空腹', 'fasting'],
    ['餐後', 'postMeal'],
    ['隨機', 'random'],
  ])('可選擇情境：%s', (_label, context) => {
    expect(unwrap(validateGlucose(glucoseInput({ context }), NOW)).context).toBe(context);
  });

  const BOUNDARY_CASES: Array<[string, string, number]> = [
    ['下限 10', '10', 10],
    ['下限 10.0', '10.0', 10],
    ['上限 1500', '1500', 1500],
    ['一位小數', '95.5', 95.5],
    ['整數', '95', 95],
  ];

  it.each(BOUNDARY_CASES)('血糖值可通過：%s', (_label, text, expected) => {
    expect(unwrap(validateGlucose(glucoseInput({ value: text }), NOW)).value).toBeCloseTo(expected, 5);
  });

  const ERROR_CASES: Array<[string, Partial<GlucoseInput>, string]> = [
    ['血糖值空白', { value: '' }, '請輸入血糖值'],
    ['血糖值只有空白字元', { value: '  ' }, '請輸入血糖值'],
    ['血糖值不是數字', { value: 'abc' }, '血糖值必須是數字'],
    ['血糖值為負數', { value: '-95' }, '血糖值必須是數字'],
    ['血糖值缺少整數部分', { value: '.5' }, '血糖值必須是數字'],
    ['血糖值小數點後沒有數字', { value: '95.' }, '血糖值必須是數字'],
    ['血糖值超過一位小數', { value: '95.55' }, '血糖值最多一位小數'],
    ['血糖值低於 10', { value: '9.9' }, '血糖值需介於 10–1500 mg/dL'],
    ['血糖值高於 1500', { value: '1500.1' }, '血糖值需介於 10–1500 mg/dL'],
    ['未選擇情境', { context: '' }, '請選擇情境'],
  ];

  it.each(ERROR_CASES)('失敗：%s', (_label, overrides, message) => {
    expect(validateGlucose(glucoseInput(overrides), NOW)).toEqual(failure(message));
  });

  it('先檢查血糖值，再檢查情境，最後才檢查日期', () => {
    expect(validateGlucose(glucoseInput({ value: '', context: '', date: '' }), NOW)).toEqual(
      failure('請輸入血糖值'),
    );
    expect(validateGlucose(glucoseInput({ context: '', date: '' }), NOW)).toEqual(failure('請選擇情境'));
  });
});

describe('validateWeight', () => {
  it('成功時回傳完整欄位且不含 id', () => {
    const value = unwrap(validateWeight(weightInput({ value: '68.4', time: '06:45', note: '空腹' }), NOW));
    expect(value).toEqual({ kind: 'weight', value: 68.4, date: '2026-10-31', time: '06:45', note: '空腹' });
    expect('id' in value).toBe(false);
  });

  it('time 與 note 空白時不含這兩個欄位', () => {
    const value = unwrap(validateWeight(weightInput(), NOW));
    expect(Object.keys(value).sort()).toEqual(['date', 'kind', 'value']);
  });

  const BOUNDARY_CASES: Array<[string, string, number]> = [
    ['下限 1', '1', 1],
    ['下限 1.0', '1.0', 1],
    ['上限 500', '500', 500],
    ['整數', '70', 70],
    ['一位小數', '70.5', 70.5],
  ];

  it.each(BOUNDARY_CASES)('體重可通過：%s', (_label, text, expected) => {
    expect(unwrap(validateWeight(weightInput({ value: text }), NOW)).value).toBeCloseTo(expected, 5);
  });

  const ERROR_CASES: Array<[string, Partial<WeightInput>, string]> = [
    ['體重空白', { value: '' }, '請輸入體重'],
    ['體重不是數字', { value: 'abc' }, '體重必須是數字'],
    ['體重為負數', { value: '-70' }, '體重必須是數字'],
    ['體重缺少整數部分', { value: '.5' }, '體重必須是數字'],
    ['體重使用逗號當小數點', { value: '70,5' }, '體重必須是數字'],
    ['體重超過一位小數', { value: '70.55' }, '體重最多一位小數'],
    ['體重為 0', { value: '0' }, '體重需介於 1–500 kg'],
    ['體重低於 1', { value: '0.9' }, '體重需介於 1–500 kg'],
    ['體重高於 500', { value: '500.1' }, '體重需介於 1–500 kg'],
  ];

  it.each(ERROR_CASES)('失敗：%s', (_label, overrides, message) => {
    expect(validateWeight(weightInput(overrides), NOW)).toEqual(failure(message));
  });
});

type CommonOverrides = { date?: string; time?: string; note?: string };

const COMMON_VALIDATORS: Array<[string, (overrides: CommonOverrides) => ValidationResult<NewMeasurement>]> = [
  ['血壓', overrides => validateBloodPressure(bpInput(overrides), NOW)],
  ['血糖', overrides => validateGlucose(glucoseInput(overrides), NOW)],
  ['體重', overrides => validateWeight(weightInput(overrides), NOW)],
];

describe.each(COMMON_VALIDATORS)('%s：日期、時間與備註共用驗證', (_name, run) => {
  const DATE_ERROR_CASES: Array<[string, string, string]> = [
    ['日期空白', '', '請選擇日期'],
    ['日期只有空白字元', '   ', '請選擇日期'],
    ['使用斜線分隔', '2026/10/31', '日期格式不正確'],
    ['月份少一位數', '2026-1-05', '日期格式不正確'],
    ['非真實日曆日 2026-02-30', '2026-02-30', '日期格式不正確'],
    ['非閏年的 2 月 29 日', '2026-02-29', '日期格式不正確'],
    ['四月沒有 31 日', '2026-04-31', '日期格式不正確'],
    ['月份為 13', '2026-13-01', '日期格式不正確'],
    ['早於 1900-01-01', '1899-12-31', '日期不能早於 1900-01-01'],
    ['晚於今天', '2026-11-01', '日期不能晚於今天'],
    ['遠在未來', '2099-01-01', '日期不能晚於今天'],
  ];

  it.each(DATE_ERROR_CASES)('日期失敗：%s', (_label, date, message) => {
    expect(run({ date })).toEqual(failure(message));
  });

  it.each(['2026-10-31', '2026-10-30', '2024-02-29', '1900-01-01'])('日期可通過：%s', date => {
    expect(unwrap(run({ date })).date).toBe(date);
  });

  const TIME_ERROR_CASES: Array<[string, string]> = [
    ['小時只有一位數', '7:30'],
    ['小時超過 23', '24:00'],
    ['分鐘超過 59', '12:60'],
    ['含秒數', '12:30:15'],
    ['不是時間', 'abc'],
    ['使用句點', '12.30'],
  ];

  it.each(TIME_ERROR_CASES)('時間失敗：%s', (_label, time) => {
    expect(run({ time })).toEqual(failure('時間格式不正確（HH:mm）'));
  });

  it.each(['00:00', '07:05', '23:59'])('時間可通過：%s', time => {
    expect(unwrap(run({ time })).time).toBe(time);
  });

  it('時間空白時省略 time 欄位', () => {
    expect('time' in unwrap(run({ time: '' }))).toBe(false);
    expect('time' in unwrap(run({ time: '  ' }))).toBe(false);
  });

  it('備註剛好 300 字可通過，超過 300 字失敗', () => {
    expect(unwrap(run({ note: '測'.repeat(300) })).note).toHaveLength(300);
    expect(run({ note: '測'.repeat(301) })).toEqual(failure('備註不可超過 300 字'));
  });

  it('備註以修剪後的長度計算，空白備註省略 note 欄位', () => {
    expect(unwrap(run({ note: `  ${'測'.repeat(300)}  ` })).note).toHaveLength(300);
    expect('note' in unwrap(run({ note: '   ' }))).toBe(false);
  });

  it('日期今天可通過，且判斷不受 now 的時分秒影響', () => {
    expect(unwrap(run({ date: '2026-10-31' })).date).toBe('2026-10-31');
    expect(run({ date: '2026-11-01' })).toEqual(failure('日期不能晚於今天'));
  });
});
