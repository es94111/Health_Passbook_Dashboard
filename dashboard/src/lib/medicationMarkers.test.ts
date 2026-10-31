import { describe, expect, it } from 'vitest';
import type { Visit } from '../parsers/types';
import { formatLocalDate } from './clock';
import {
  describeMedicationOverlay, placeMedicationMarkers, prescriptionDays,
  type MarkerAnchor, type MarkerPlacement,
} from './medicationMarkers';

const at = (month: number, day: number, year = 2025): Date => new Date(year, month - 1, day);
const dayOf = (month: number, day: number, year = 2025): string => formatLocalDate(at(month, day, year));

const visit = (date: Date, codes: string[] = ['AB123'], overrides: Partial<Visit> = {}): Visit => ({
  date, hospital: '甲醫院', diagnoses: [],
  procedures: codes.map(code => ({ code, name: `藥品${code}`, qty: 1 })),
  ...overrides,
});

const anchorOn = (month: number, day: number, x = `r${month}/${day}`, year = 2025): MarkerAnchor => ({
  date: at(month, day, year), x,
});

const NO_MATCH: MarkerPlacement = { lines: [], inRange: 0, outside: 0, first: null, last: null };

describe('prescriptionDays', () => {
  it('沒有看診紀錄時回傳空陣列', () => {
    expect(prescriptionDays([], 'AB123')).toEqual([]);
  });

  it('回傳含該藥品代碼之看診的當地日期，由舊到新排序', () => {
    const visits = [visit(at(3, 3)), visit(at(1, 5)), visit(at(2, 1))];
    expect(prescriptionDays(visits, 'AB123')).toEqual(['2025-01-05', '2025-02-01', '2025-03-03']);
  });

  it('只比對完全相同的代碼，不含其他藥品或前綴相同的代碼', () => {
    const visits = [
      visit(at(1, 5), ['AB123']),
      visit(at(1, 6), ['AB1234']),
      visit(at(1, 7), ['AB12']),
      visit(at(1, 8), ['ab123']),
      visit(at(1, 9), ['CD456']),
    ];
    expect(prescriptionDays(visits, 'AB123')).toEqual(['2025-01-05']);
  });

  it('同一天的多次看診或同一次看診重複開立只計一次', () => {
    const visits = [
      visit(at(1, 5)),
      visit(new Date(2025, 0, 5, 18, 30), ['CD456', 'AB123']),
      visit(at(1, 20), ['AB123', 'AB123']),
    ];
    expect(prescriptionDays(visits, 'AB123')).toEqual(['2025-01-05', '2025-01-20']);
  });

  it('混有其他處置項目的看診仍會計入', () => {
    expect(prescriptionDays([visit(at(2, 2), ['01001C', 'AB123', '02002A'])], 'AB123')).toEqual(['2025-02-02']);
  });

  it('沒有任何處置項目的看診不會計入', () => {
    expect(prescriptionDays([visit(at(2, 2), [])], 'AB123')).toEqual([]);
  });

  it('略過日期無效的看診', () => {
    const visits = [visit(new Date(Number.NaN)), visit(at(4, 1))];
    expect(prescriptionDays(visits, 'AB123')).toEqual(['2025-04-01']);
  });

  it('依當地時間換算日期，不受時間點影響', () => {
    const visits = [visit(new Date(2025, 0, 5, 23, 30)), visit(new Date(2025, 0, 6, 0, 5))];
    expect(prescriptionDays(visits, 'AB123')).toEqual(['2025-01-05', '2025-01-06']);
  });

  it('不會更動傳入的看診陣列', () => {
    const visits = Object.freeze([visit(at(3, 3)), visit(at(1, 5))]);
    const before = visits.map(item => item.date.getTime());
    prescriptionDays(visits, 'AB123');
    expect(visits.map(item => item.date.getTime())).toEqual(before);
  });
});

describe('placeMedicationMarkers', () => {
  const READINGS = [anchorOn(1, 10), anchorOn(2, 10), anchorOn(3, 10)];

  it('處方標在處方日當天或之後的第一次檢驗', () => {
    const placement = placeMedicationMarkers([dayOf(1, 20)], READINGS);
    expect(placement.lines).toEqual(['r2/10']);
    expect(placement.inRange).toBe(1);
    expect(placement.outside).toBe(0);
  });

  it('處方日與檢驗同一天時，標在該次檢驗', () => {
    expect(placeMedicationMarkers([dayOf(2, 10)], READINGS).lines).toEqual(['r2/10']);
  });

  it('檢驗帶有時間點時，仍以當地日期判斷是否同一天', () => {
    const readings = [
      { date: new Date(2025, 0, 10, 8, 0), x: 'a' },
      { date: new Date(2025, 1, 10, 23, 59), x: 'b' },
    ];
    expect(placeMedicationMarkers([dayOf(2, 10)], readings).lines).toEqual(['b']);
  });

  it('第一次與最後一次檢驗當天的處方都算在期間內', () => {
    const placement = placeMedicationMarkers([dayOf(1, 10), dayOf(3, 10)], READINGS);
    expect(placement.lines).toEqual(['r1/10', 'r3/10']);
    expect(placement.inRange).toBe(2);
    expect(placement.outside).toBe(0);
    expect(placement.first).toBe(dayOf(1, 10));
    expect(placement.last).toBe(dayOf(3, 10));
  });

  it('早於第一次檢驗或晚於最後一次檢驗的處方不畫線，只計入期間外', () => {
    const placement = placeMedicationMarkers([dayOf(1, 9), dayOf(3, 11)], READINGS);
    expect(placement).toEqual({ lines: [], inRange: 0, outside: 2, first: null, last: null });
  });

  it('同一次檢驗之前的多張處方合併成一條線', () => {
    const placement = placeMedicationMarkers([dayOf(1, 11), dayOf(1, 20), dayOf(2, 1)], READINGS);
    expect(placement.lines).toEqual(['r2/10']);
    expect(placement.inRange).toBe(3);
  });

  it('多條線依檢驗時間由舊到新排列，不受處方日順序影響', () => {
    const placement = placeMedicationMarkers([dayOf(2, 20), dayOf(1, 15)], READINGS);
    expect(placement.lines).toEqual(['r2/10', 'r3/10']);
    expect(placement.first).toBe(dayOf(1, 15));
    expect(placement.last).toBe(dayOf(2, 20));
  });

  it('檢驗資料未排序時結果相同', () => {
    const shuffled = [anchorOn(3, 10), anchorOn(1, 10), anchorOn(2, 10)];
    const days = [dayOf(1, 15), dayOf(2, 20)];
    expect(placeMedicationMarkers(days, shuffled)).toEqual(placeMedicationMarkers(days, READINGS));
  });

  it('重複的處方日只計一次', () => {
    const placement = placeMedicationMarkers([dayOf(1, 20), dayOf(1, 20), dayOf(1, 20)], READINGS);
    expect(placement.inRange).toBe(1);
    expect(placement.outside).toBe(0);
    expect(placement.lines).toEqual(['r2/10']);
  });

  it('同一天的多筆檢驗共用同一個 x，只畫一條線', () => {
    const readings = [anchorOn(1, 10), anchorOn(2, 10, 'same'), anchorOn(2, 10, 'same'), anchorOn(3, 10)];
    expect(placeMedicationMarkers([dayOf(1, 20)], readings).lines).toEqual(['same']);
  });

  it('first 與 last 只反映期間內的處方', () => {
    const days = [dayOf(1, 1), dayOf(1, 20), dayOf(2, 20), dayOf(4, 1)];
    const placement = placeMedicationMarkers(days, READINGS);
    expect(placement.inRange).toBe(2);
    expect(placement.outside).toBe(2);
    expect(placement.first).toBe(dayOf(1, 20));
    expect(placement.last).toBe(dayOf(2, 20));
  });

  it('只有一次檢驗時，只有當天的處方算在期間內', () => {
    const only = [anchorOn(2, 10)];
    expect(placeMedicationMarkers([dayOf(2, 10)], only)).toEqual({
      lines: ['r2/10'], inRange: 1, outside: 0, first: dayOf(2, 10), last: dayOf(2, 10),
    });
    expect(placeMedicationMarkers([dayOf(2, 9), dayOf(2, 11)], only)).toEqual({
      lines: [], inRange: 0, outside: 2, first: null, last: null,
    });
  });

  it('日期未提供或無效的檢驗不參與定位', () => {
    const readings: MarkerAnchor[] = [
      { date: null, x: '日期未提供' },
      { date: new Date(Number.NaN), x: 'invalid' },
      anchorOn(2, 10),
      anchorOn(3, 10),
    ];
    const placement = placeMedicationMarkers([dayOf(1, 20), dayOf(2, 20)], readings);
    expect(placement.lines).toEqual(['r3/10']);
    expect(placement.inRange).toBe(1);
    expect(placement.outside).toBe(1);
  });

  it('沒有檢驗時，所有處方都算在期間外', () => {
    expect(placeMedicationMarkers([dayOf(1, 20), dayOf(2, 20)], [])).toEqual({
      lines: [], inRange: 0, outside: 2, first: null, last: null,
    });
  });

  it('檢驗全部沒有有效日期時，等同沒有檢驗', () => {
    const readings: MarkerAnchor[] = [{ date: null, x: 'a' }, { date: new Date(Number.NaN), x: 'b' }];
    expect(placeMedicationMarkers([dayOf(1, 20)], readings)).toEqual({
      lines: [], inRange: 0, outside: 1, first: null, last: null,
    });
  });

  it('沒有處方時回傳全為零的結果', () => {
    expect(placeMedicationMarkers([], READINGS)).toEqual(NO_MATCH);
    expect(placeMedicationMarkers([], [])).toEqual(NO_MATCH);
  });

  it('跨年份時依日期而非字串長度排序', () => {
    const readings = [anchorOn(12, 20, 'dec', 2024), anchorOn(1, 10, 'jan', 2025)];
    const placement = placeMedicationMarkers(['2024-12-31', '2024-12-01', '2025-02-01'], readings);
    expect(placement.lines).toEqual(['jan']);
    expect(placement.inRange).toBe(1);
    expect(placement.outside).toBe(2);
    expect(placement.first).toBe('2024-12-31');
    expect(placement.last).toBe('2024-12-31');
  });

  it('不會更動傳入的處方日與檢驗陣列', () => {
    const days = Object.freeze([dayOf(2, 20), dayOf(1, 15)]);
    const anchors = Object.freeze([anchorOn(3, 10), anchorOn(1, 10), anchorOn(2, 10)]);
    placeMedicationMarkers(days, anchors);
    expect(days).toEqual([dayOf(2, 20), dayOf(1, 15)]);
    expect(anchors.map(anchor => anchor.x)).toEqual(['r3/10', 'r1/10', 'r2/10']);
  });
});

describe('describeMedicationOverlay', () => {
  it('期間內沒有處方時只說明這點', () => {
    expect(describeMedicationOverlay('藥品甲', NO_MATCH)).toBe('用藥時間點：藥品甲 · 此系列的檢驗期間內沒有處方');
  });

  it('期間內沒有處方、但有期間外的處方時一併說明', () => {
    const placement: MarkerPlacement = { ...NO_MATCH, outside: 2 };
    expect(describeMedicationOverlay('藥品甲', placement)).toBe(
      '用藥時間點：藥品甲 · 此系列的檢驗期間內沒有處方；另有 2 次處方在此系列的檢驗期間之外',
    );
  });

  it('期間內只有一天有處方時只顯示該日', () => {
    const placement: MarkerPlacement = { lines: ['x'], inRange: 1, outside: 0, first: '2025-01-20', last: '2025-01-20' };
    expect(describeMedicationOverlay('藥品甲', placement)).toBe(
      '用藥時間點：藥品甲 · 期間內 1 次處方（2025-01-20），藍色虛線標在處方後的第一次檢驗',
    );
  });

  it('期間內有多次處方時顯示起訖日', () => {
    const placement: MarkerPlacement = { lines: ['x', 'y'], inRange: 3, outside: 0, first: '2025-01-20', last: '2025-03-01' };
    expect(describeMedicationOverlay('藥品甲', placement)).toBe(
      '用藥時間點：藥品甲 · 期間內 3 次處方（2025-01-20 至 2025-03-01），藍色虛線標在處方後的第一次檢驗',
    );
  });

  it('期間內外都有處方時以分號並列', () => {
    const placement: MarkerPlacement = { lines: ['x'], inRange: 2, outside: 1, first: '2025-01-20', last: '2025-02-20' };
    expect(describeMedicationOverlay('藥品甲', placement)).toBe(
      '用藥時間點：藥品甲 · 期間內 2 次處方（2025-01-20 至 2025-02-20），藍色虛線標在處方後的第一次檢驗；另有 1 次處方在此系列的檢驗期間之外',
    );
  });

  it('原樣顯示藥品名稱', () => {
    expect(describeMedicationOverlay('Metformin 500mg (膜衣錠)', NO_MATCH).startsWith('用藥時間點：Metformin 500mg (膜衣錠) · ')).toBe(true);
  });

  it('搭配 placeMedicationMarkers 的實際結果', () => {
    const readings = [anchorOn(1, 10), anchorOn(2, 10), anchorOn(3, 10)];
    const placement = placeMedicationMarkers([dayOf(1, 1), dayOf(1, 20), dayOf(2, 20), dayOf(4, 1)], readings);
    expect(describeMedicationOverlay('藥品甲', placement)).toBe(
      '用藥時間點：藥品甲 · 期間內 2 次處方（2025-01-20 至 2025-02-20），藍色虛線標在處方後的第一次檢驗；另有 2 次處方在此系列的檢驗期間之外',
    );
  });
});
