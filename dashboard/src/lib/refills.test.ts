import { describe, expect, it } from 'vitest';
import { emptyPersonal, normalizePersonalData, type RefillPlan } from '../personalData';
import { addDays, formatLocalDate } from './clock';
import {
  REFILL_DISCLAIMER,
  REFILL_WINDOW_DAYS,
  computeRefillStatus,
  describeRefillTiming,
  refillReminders,
  sortRefillsByUrgency,
  validateRefillPlan,
  type RefillFormInput,
  type RefillState,
} from './refills';

const NOW = new Date(2026, 9, 31, 12, 0, 0);

function plan(overrides: Partial<RefillPlan> = {}): RefillPlan {
  return {
    id: 'r1',
    drugName: '降血壓藥',
    prescribedDate: '2026-10-01',
    daysPerFill: 28,
    fills: 3,
    taken: 1,
    ...overrides,
  };
}

// taken=1、daysPerFill=28 時，預估用完日恰為 NOW 當天 + k 天
function endingIn(k: number, overrides: Partial<RefillPlan> = {}): RefillPlan {
  return plan({ prescribedDate: formatLocalDate(addDays(NOW, k - 28)), ...overrides });
}

function ids(entries: { plan: RefillPlan }[]): string[] {
  return entries.map(entry => entry.plan.id);
}

describe('常數', () => {
  it('提醒視窗與揭露文字', () => {
    expect(REFILL_WINDOW_DAYS).toBe(10);
    expect(REFILL_DISCLAIMER).toBe('實際規定以健保署與藥局為準');
  });
});

describe('computeRefillStatus', () => {
  it('尚未到期：最早可領藥日還沒到', () => {
    const status = computeRefillStatus(endingIn(30), NOW);
    expect(status.state).toBe('notYet');
    expect(status.label).toBe('尚未到期');
    expect(status.daysUntilOpen).toBe(20);
    expect(status.daysUntilEnd).toBe(30);
    expect(status.remainingFills).toBe(2);
    expect(status.windowOpensOn).not.toBeNull();
  });

  it('可領藥：已過最早可領藥日但藥量尚未用完', () => {
    const status = computeRefillStatus(endingIn(5), NOW);
    expect(status.state).toBe('open');
    expect(status.label).toBe('可領藥');
    expect(status.daysUntilOpen).toBe(-5);
    expect(status.daysUntilEnd).toBe(5);
  });

  it('藥量可能已用完：預估用完日已過', () => {
    const status = computeRefillStatus(plan(), NOW);
    expect(formatLocalDate(status.supplyEndsOn)).toBe('2026-10-29');
    expect(status.state).toBe('overdue');
    expect(status.label).toBe('藥量可能已用完');
    expect(status.daysUntilEnd).toBe(-2);
  });

  it('已領完：taken 等於 fills 時不再有最早可領藥日', () => {
    const status = computeRefillStatus(plan({ fills: 3, taken: 3 }), NOW);
    expect(status.state).toBe('finished');
    expect(status.label).toBe('連續處方已領完，需回診開立新處方');
    expect(status.windowOpensOn).toBeNull();
    expect(status.remainingFills).toBe(0);
  });

  it('已領完的判斷優先於日期（即使日期上已逾期）', () => {
    expect(computeRefillStatus(plan({ prescribedDate: '2026-01-01', fills: 1, taken: 1 }), NOW).state).toBe(
      'finished',
    );
    expect(computeRefillStatus(endingIn(5, { fills: 2, taken: 2 }), NOW).state).toBe('finished');
  });

  it('剩餘次數為總次數減已領次數', () => {
    expect(computeRefillStatus(plan({ fills: 5, taken: 2 }), NOW).remainingFills).toBe(3);
  });

  const boundaries: { k: number; state: RefillState }[] = [
    { k: 11, state: 'notYet' },
    { k: 10, state: 'open' },
    { k: 1, state: 'open' },
    { k: 0, state: 'overdue' },
    { k: -1, state: 'overdue' },
  ];

  it.each(boundaries)('預估用完日在今天起 $k 天後 → $state', ({ k, state }) => {
    const status = computeRefillStatus(endingIn(k), NOW);
    expect(status.state).toBe(state);
    expect(status.daysUntilEnd).toBe(k);
    expect(status.daysUntilOpen).toBe(k - REFILL_WINDOW_DAYS);
  });

  it('已領藥次數越多，預估用完日越晚', () => {
    const status = computeRefillStatus(plan({ taken: 2 }), NOW);
    expect(formatLocalDate(status.supplyEndsOn)).toBe('2026-11-26');
    expect(formatLocalDate(status.windowOpensOn as Date)).toBe('2026-11-16');
    expect(status.state).toBe('notYet');
    expect(status.daysUntilOpen).toBe(16);
  });

  it('跨月：1 月 31 日起算 28 天', () => {
    const status = computeRefillStatus(plan({ prescribedDate: '2026-01-31' }), NOW);
    expect(formatLocalDate(status.supplyEndsOn)).toBe('2026-02-28');
    expect(formatLocalDate(status.windowOpensOn as Date)).toBe('2026-02-18');
  });

  it('跨年：12 月 20 日起算 30 天', () => {
    const status = computeRefillStatus(plan({ prescribedDate: '2026-12-20', daysPerFill: 30 }), NOW);
    expect(formatLocalDate(status.supplyEndsOn)).toBe('2027-01-19');
    expect(formatLocalDate(status.windowOpensOn as Date)).toBe('2027-01-09');
  });

  it('閏年：2028 年有 2 月 29 日，2027 年沒有', () => {
    const leap = computeRefillStatus(plan({ prescribedDate: '2028-02-01' }), NOW);
    const common = computeRefillStatus(plan({ prescribedDate: '2027-02-01' }), NOW);
    expect(formatLocalDate(leap.supplyEndsOn)).toBe('2028-02-29');
    expect(formatLocalDate(common.supplyEndsOn)).toBe('2027-03-01');
  });

  it('預估用完日恰為今天（閏日）→ 逾期且 daysUntilEnd 為 0', () => {
    const status = computeRefillStatus(plan({ prescribedDate: '2028-02-01' }), new Date(2028, 1, 29, 8, 0, 0));
    expect(status.state).toBe('overdue');
    expect(status.daysUntilEnd).toBe(0);
  });

  it('now 的時分秒不影響結果：同一天 00:00 與 23:59 相同', () => {
    const early = new Date(2026, 9, 31, 0, 0, 0);
    const late = new Date(2026, 9, 31, 23, 59, 59);
    for (const k of [11, 10, 1, 0]) {
      expect(computeRefillStatus(endingIn(k), early)).toEqual(computeRefillStatus(endingIn(k), late));
    }
  });

  it('跨過午夜後換算成新的一天', () => {
    const sample = endingIn(1);
    expect(computeRefillStatus(sample, new Date(2026, 9, 31, 23, 59, 59)).state).toBe('open');
    const nextDay = computeRefillStatus(sample, new Date(2026, 10, 1, 0, 0, 0));
    expect(nextDay.state).toBe('overdue');
    expect(nextDay.daysUntilEnd).toBe(0);
  });

  it('回傳的日期都是當地午夜', () => {
    const status = computeRefillStatus(plan(), new Date(2026, 9, 31, 17, 45, 12));
    for (const date of [status.supplyEndsOn, status.windowOpensOn as Date]) {
      expect([date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds()]).toEqual([0, 0, 0, 0]);
    }
  });
});

describe('describeRefillTiming', () => {
  it('依狀態說明時程', () => {
    expect(describeRefillTiming(computeRefillStatus(endingIn(15), NOW))).toBe('5 天後開始可領');
    expect(describeRefillTiming(computeRefillStatus(endingIn(3), NOW))).toBe('預估 3 天後用完');
    expect(describeRefillTiming(computeRefillStatus(endingIn(0), NOW))).toBe('預估今天用完');
    expect(describeRefillTiming(computeRefillStatus(plan(), NOW))).toBe('預估已用完 2 天');
  });

  it('已領完的處方沒有時程說明', () => {
    expect(describeRefillTiming(computeRefillStatus(plan({ fills: 1, taken: 1 }), NOW))).toBeNull();
  });
});

describe('sortRefillsByUrgency', () => {
  it('依 逾期（最久在前）→ 可領藥（最快用完在前）→ 尚未到期（最早可領在前）→ 已領完 排序', () => {
    const scrambled = [
      plan({ id: 'finished', fills: 3, taken: 3 }),
      endingIn(50, { id: 'notYetFar' }),
      endingIn(9, { id: 'openLater' }),
      endingIn(-1, { id: 'overdueNew' }),
      endingIn(15, { id: 'notYetNear' }),
      endingIn(-20, { id: 'overdueOld' }),
      endingIn(2, { id: 'openSoon' }),
    ];
    expect(ids(sortRefillsByUrgency(scrambled, NOW))).toEqual([
      'overdueOld',
      'overdueNew',
      'openSoon',
      'openLater',
      'notYetNear',
      'notYetFar',
      'finished',
    ]);
  });

  it('同分時維持輸入順序（穩定排序）', () => {
    const a = endingIn(5, { id: 'a' });
    const b = endingIn(5, { id: 'b' });
    expect(ids(sortRefillsByUrgency([a, b], NOW))).toEqual(['a', 'b']);
    expect(ids(sortRefillsByUrgency([b, a], NOW))).toEqual(['b', 'a']);

    const doneA = plan({ id: 'doneA', fills: 2, taken: 2 });
    const doneB = plan({ id: 'doneB', fills: 4, taken: 4, prescribedDate: '2026-02-01' });
    expect(ids(sortRefillsByUrgency([doneB, doneA], NOW))).toEqual(['doneB', 'doneA']);
  });

  it('空清單回傳空陣列', () => {
    expect(sortRefillsByUrgency([], NOW)).toEqual([]);
  });

  it('不修改輸入陣列，回傳原本的處方物件與對應狀態', () => {
    const overdue = plan({ id: 'overdue' });
    const open = endingIn(4, { id: 'open' });
    const input = [open, overdue];
    const entries = sortRefillsByUrgency(input, NOW);
    expect(input).toEqual([open, overdue]);
    expect(input[0]).toBe(open);
    expect(entries[0].plan).toBe(overdue);
    expect(entries[1].plan).toBe(open);
    expect(entries[0].status).toEqual(computeRefillStatus(overdue, NOW));
  });
});

describe('refillReminders', () => {
  it('只保留可領藥與可能已逾期的處方，並依急迫度排序', () => {
    const entries = refillReminders(
      [
        plan({ id: 'finished', fills: 3, taken: 3 }),
        endingIn(40, { id: 'notYet' }),
        endingIn(6, { id: 'open' }),
        endingIn(-3, { id: 'overdue' }),
      ],
      NOW,
    );
    expect(ids(entries)).toEqual(['overdue', 'open']);
    expect(entries.map(entry => entry.status.state)).toEqual(['overdue', 'open']);
  });

  it('沒有需要處理的處方時回傳空陣列', () => {
    expect(refillReminders([endingIn(40), plan({ fills: 1, taken: 1 })], NOW)).toEqual([]);
    expect(refillReminders([], NOW)).toEqual([]);
  });
});

function input(overrides: Partial<RefillFormInput> = {}): RefillFormInput {
  return {
    drugName: '降血壓藥',
    drugCode: '',
    hospital: '',
    prescribedDate: '2026-10-01',
    daysPerFill: '28',
    fills: '3',
    taken: '1',
    note: '',
    ...overrides,
  };
}

describe('validateRefillPlan', () => {
  it('只填必填欄位時，成功值不含空欄位或 undefined', () => {
    expect(validateRefillPlan(input(), NOW)).toStrictEqual({
      ok: true,
      value: { drugName: '降血壓藥', prescribedDate: '2026-10-01', daysPerFill: 28, fills: 3, taken: 1 },
    });
  });

  it('輸入會先 trim，選填欄位有值時一併帶出', () => {
    const result = validateRefillPlan(
      input({
        drugName: '  降血壓藥  ',
        drugCode: ' AB12345678 ',
        hospital: ' 台大醫院 ',
        prescribedDate: ' 2026-10-01 ',
        daysPerFill: ' 28 ',
        fills: ' 3 ',
        taken: ' 2 ',
        note: ' 飯後服用 ',
      }),
      NOW,
    );
    expect(result).toStrictEqual({
      ok: true,
      value: {
        drugName: '降血壓藥',
        drugCode: 'AB12345678',
        hospital: '台大醫院',
        prescribedDate: '2026-10-01',
        daysPerFill: 28,
        fills: 3,
        taken: 2,
        note: '飯後服用',
      },
    });
  });

  const failures: { name: string; overrides: Partial<RefillFormInput>; message: string }[] = [
    { name: '藥品名稱空白', overrides: { drugName: '   ' }, message: '請輸入藥品名稱' },
    { name: '藥品名稱 121 字', overrides: { drugName: '藥'.repeat(121) }, message: '藥品名稱不能超過 120 字' },
    { name: '藥品代碼 41 字', overrides: { drugCode: 'A'.repeat(41) }, message: '藥品代碼不能超過 40 字' },
    { name: '醫院 121 字', overrides: { hospital: '院'.repeat(121) }, message: '醫院名稱不能超過 120 字' },
    { name: '處方開立日空白', overrides: { prescribedDate: '' }, message: '請輸入處方開立日' },
    {
      name: '處方開立日格式錯誤',
      overrides: { prescribedDate: 'abc' },
      message: '處方開立日需為 1900-01-01 起的有效日期',
    },
    {
      name: '處方開立日為 2 月 30 日',
      overrides: { prescribedDate: '2026-02-30' },
      message: '處方開立日需為 1900-01-01 起的有效日期',
    },
    {
      name: '處方開立日為 13 月',
      overrides: { prescribedDate: '2026-13-01' },
      message: '處方開立日需為 1900-01-01 起的有效日期',
    },
    {
      name: '處方開立日早於 1900-01-01',
      overrides: { prescribedDate: '1899-12-31' },
      message: '處方開立日需為 1900-01-01 起的有效日期',
    },
    { name: '處方開立日晚於今天', overrides: { prescribedDate: '2026-11-01' }, message: '處方開立日不能晚於今天' },
    { name: '每次天數空白', overrides: { daysPerFill: '' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 0', overrides: { daysPerFill: '0' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 181', overrides: { daysPerFill: '181' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 1.5', overrides: { daysPerFill: '1.5' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 -3', overrides: { daysPerFill: '-3' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 abc', overrides: { daysPerFill: 'abc' }, message: '每次天數需為 1–180 的整數' },
    { name: '每次天數 2e1', overrides: { daysPerFill: '2e1' }, message: '每次天數需為 1–180 的整數' },
    { name: '總次數空白', overrides: { fills: '' }, message: '連續處方總次數需為 1–12 的整數' },
    { name: '總次數 0', overrides: { fills: '0' }, message: '連續處方總次數需為 1–12 的整數' },
    { name: '總次數 13', overrides: { fills: '13' }, message: '連續處方總次數需為 1–12 的整數' },
    { name: '總次數 2.5', overrides: { fills: '2.5' }, message: '連續處方總次數需為 1–12 的整數' },
    { name: '已領藥次數空白', overrides: { taken: '' }, message: '已領藥次數需介於 1 與總次數之間' },
    { name: '已領藥次數 0', overrides: { taken: '0' }, message: '已領藥次數需介於 1 與總次數之間' },
    { name: '已領藥次數超過總次數', overrides: { taken: '4' }, message: '已領藥次數需介於 1 與總次數之間' },
    { name: '已領藥次數 x', overrides: { taken: 'x' }, message: '已領藥次數需介於 1 與總次數之間' },
    { name: '備註 301 字', overrides: { note: '註'.repeat(301) }, message: '備註不能超過 300 字' },
  ];

  it.each(failures)('$name → $message', ({ overrides, message }) => {
    expect(validateRefillPlan(input(overrides), NOW)).toEqual({ ok: false, error: message });
  });

  it('依表單順序回報第一個錯誤', () => {
    expect(validateRefillPlan(input({ drugName: '', prescribedDate: '' }), NOW)).toEqual({
      ok: false,
      error: '請輸入藥品名稱',
    });
    expect(validateRefillPlan(input({ daysPerFill: '0', fills: '0' }), NOW)).toEqual({
      ok: false,
      error: '每次天數需為 1–180 的整數',
    });
    expect(validateRefillPlan(input({ fills: '13', taken: '20' }), NOW)).toEqual({
      ok: false,
      error: '連續處方總次數需為 1–12 的整數',
    });
  });

  it('每次天數與總次數的邊界值都可接受', () => {
    for (const daysPerFill of ['1', '180']) {
      expect(validateRefillPlan(input({ daysPerFill }), NOW).ok).toBe(true);
    }
    expect(validateRefillPlan(input({ fills: '1', taken: '1' }), NOW)).toMatchObject({
      ok: true,
      value: { fills: 1, taken: 1 },
    });
    expect(validateRefillPlan(input({ fills: '12', taken: '12' }), NOW)).toMatchObject({
      ok: true,
      value: { fills: 12, taken: 12 },
    });
  });

  it('已領藥次數等於總次數時可接受', () => {
    expect(validateRefillPlan(input({ fills: '3', taken: '3' }), NOW)).toMatchObject({
      ok: true,
      value: { fills: 3, taken: 3 },
    });
  });

  it('文字長度恰為上限時可接受', () => {
    const result = validateRefillPlan(
      input({
        drugName: '藥'.repeat(120),
        drugCode: 'A'.repeat(40),
        hospital: '院'.repeat(120),
        note: '註'.repeat(300),
      }),
      NOW,
    );
    expect(result.ok).toBe(true);
  });

  it('處方開立日可為今天或 1900-01-01', () => {
    expect(validateRefillPlan(input({ prescribedDate: '2026-10-31' }), NOW).ok).toBe(true);
    expect(validateRefillPlan(input({ prescribedDate: '1900-01-01' }), NOW).ok).toBe(true);
  });

  it('「今天」以當地日曆日判斷，不受時分秒影響', () => {
    const lateNight = new Date(2026, 9, 31, 23, 59, 59);
    expect(validateRefillPlan(input({ prescribedDate: '2026-10-31' }), lateNight).ok).toBe(true);
    expect(validateRefillPlan(input({ prescribedDate: '2026-11-01' }), lateNight).ok).toBe(false);
    expect(validateRefillPlan(input({ prescribedDate: '2026-11-01' }), new Date(2026, 10, 1, 0, 0, 0)).ok).toBe(true);
  });

  it.each([
    { name: '只有必填欄位', overrides: {} },
    {
      name: '含所有選填欄位',
      overrides: { drugCode: 'AB12345678', hospital: '台大醫院', note: '飯後服用' },
    },
  ])('驗證後的值可通過個人資料正規化：$name', ({ overrides }) => {
    const result = validateRefillPlan(input(overrides), NOW);
    if (!result.ok) throw new Error(result.error);
    expect(() =>
      normalizePersonalData({ ...emptyPersonal(), refills: [{ id: 'r1', ...result.value }] }),
    ).not.toThrow();
  });
});
