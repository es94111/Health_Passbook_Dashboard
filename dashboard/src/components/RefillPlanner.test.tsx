import { useState } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RefillPlanner from './RefillPlanner';
import { REFILL_DISCLAIMER } from '../lib/refills';
import { PERSONAL_LIMITS, emptyPersonal } from '../personalData';
import type { PersonalData, RefillPlan } from '../personalData';
import { PersonalContext } from '../personalContext';
import type { PersonalContextValue } from '../personalContext';
import type { Visit } from '../parsers/types';

const NOW = new Date(2026, 9, 31, 12, 0, 0);

type Mutator = Parameters<PersonalContextValue['update']>[0];

afterEach(cleanup);

function Harness({
  initial = emptyPersonal(),
  canEdit = true,
  fail = false,
  children,
}: {
  initial?: PersonalData;
  canEdit?: boolean;
  fail?: boolean;
  children: ReactNode;
}) {
  const [personal, setPersonal] = useState(initial);
  const value: PersonalContextValue = {
    personal,
    canEdit,
    saving: false,
    error: null,
    clearError: () => {},
    update: async mutator => {
      if (fail) return false;
      setPersonal(current => mutator(current));
      return true;
    },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

function renderPlanner(options: { initial?: PersonalData; canEdit?: boolean; fail?: boolean; visits?: Visit[] } = {}) {
  const { visits, ...harness } = options;
  return render(
    <Harness {...harness}>
      <RefillPlanner now={NOW} visits={visits} />
    </Harness>,
  );
}

function renderWithValue(overrides: Partial<PersonalContextValue> = {}) {
  const value: PersonalContextValue = {
    personal: emptyPersonal(),
    canEdit: true,
    saving: false,
    error: null,
    clearError: () => {},
    update: async () => true,
    ...overrides,
  };
  return render(
    <PersonalContext.Provider value={value}>
      <RefillPlanner now={NOW} />
    </PersonalContext.Provider>,
  );
}

function makeUpdate(result = true) {
  return vi.fn<PersonalContextValue['update']>(async () => result);
}

function lastMutator(update: ReturnType<typeof makeUpdate>): Mutator {
  const call = update.mock.calls[update.mock.calls.length - 1];
  if (!call) throw new Error('update 尚未被呼叫');
  return call[0];
}

function refill(overrides: Partial<RefillPlan> = {}): RefillPlan {
  return { id: 'r1', drugName: '乙藥', prescribedDate: '2026-10-10', daysPerFill: 28, fills: 3, taken: 1, ...overrides };
}

function withRefills(refills: RefillPlan[]): PersonalData {
  return { ...emptyPersonal(), refills };
}

const OVERDUE = refill({ id: 'overdue', drugName: '甲藥', prescribedDate: '2026-09-20' });
const OPEN = refill({ id: 'open', drugName: '乙藥', prescribedDate: '2026-10-10' });
const NOT_YET = refill({ id: 'notyet', drugName: '丙藥', prescribedDate: '2026-10-25' });
const FINISHED = refill({ id: 'done', drugName: '丁藥', prescribedDate: '2026-08-01', taken: 3 });
const ALL_NAMES = ['甲藥', '乙藥', '丙藥', '丁藥', '戊藥'];

function visitOn(date: Date, procedures: Visit['procedures']): Visit {
  return { date, hospital: '台大醫院', diagnoses: [], procedures };
}

const DRUG_VISITS: Visit[] = [
  visitOn(new Date(2026, 7, 1), [{ code: 'AB12345678', name: '降血壓藥', qty: 28 }]),
  visitOn(new Date(2026, 9, 1), [
    { code: 'AB12345678', name: '降血壓藥', qty: 28 },
    { code: '01001C', name: '診察費', qty: 1 },
  ]),
];

const VALID_FORM: Record<string, string> = {
  藥品名稱: '降血壓藥',
  處方開立日: '2026-10-10',
  每次天數: '28',
  連續處方總次數: '3',
};

function field(label: string): HTMLInputElement {
  return screen.getByLabelText(label) as HTMLInputElement;
}

function enter(label: string, value: string) {
  fireEvent.change(field(label), { target: { value } });
}

function fill(values: Record<string, string> = VALID_FORM) {
  for (const [label, value] of Object.entries(values)) enter(label, value);
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
  });
}

function addButton(): HTMLButtonElement {
  return screen.getByText('新增', { selector: 'button' }) as HTMLButtonElement;
}

async function submit() {
  await click(addButton());
}

function rowOf(name: string): HTMLElement {
  const row = screen.getByText(name).closest('li');
  if (!row) throw new Error(`找不到「${name}」所在的列`);
  return row;
}

function rowButton(name: string, label: string): HTMLButtonElement {
  return within(rowOf(name)).getByRole('button', { name: label }) as HTMLButtonElement;
}

function listedNames(): Array<string | undefined> {
  return screen
    .getAllByRole('listitem')
    .map(item => ALL_NAMES.find(name => within(item).queryByText(name) !== null));
}

describe('RefillPlanner', () => {
  describe('版面與揭露', () => {
    it('以具名區塊呈現標題與新增表單，表單列印時隱藏', () => {
      renderPlanner();
      expect(screen.getByRole('region', { name: '慢性病連續處方領藥提醒' })).not.toBeNull();
      expect(screen.getByRole('heading', { level: 2, name: '慢性病連續處方領藥提醒' })).not.toBeNull();
      const form = screen.getByRole('form', { name: '新增連續處方' });
      expect(form.className).toContain('print:hidden');
    });

    it('揭露僅供提醒、以健保署與藥局為準，且不宣稱領藥期限', () => {
      renderPlanner();
      const text = document.body.textContent ?? '';
      expect(text).toContain('僅供提醒，非醫囑');
      expect(text).toContain(REFILL_DISCLAIMER);
      expect(text).not.toContain('領藥期限');
      expect(screen.getAllByText(new RegExp(REFILL_DISCLAIMER))).toHaveLength(1);
    });

    it('表單欄位的預設值、提示與輸入模式', () => {
      renderPlanner();
      expect(field('每次天數').value).toBe('');
      expect(field('連續處方總次數').value).toBe('');
      expect(field('已領藥次數').value).toBe('1');
      expect(field('每次天數').getAttribute('placeholder')).toBe('例：28');
      expect(field('連續處方總次數').getAttribute('placeholder')).toBe('例：3');
      for (const label of ['每次天數', '連續處方總次數', '已領藥次數']) {
        expect(field(label).getAttribute('type')).toBe('text');
        expect(field(label).getAttribute('inputmode')).toBe('numeric');
      }
      expect(field('處方開立日').getAttribute('type')).toBe('date');
      for (const label of ['藥品名稱', '處方開立日', '每次天數', '連續處方總次數', '已領藥次數']) {
        expect(field(label).getAttribute('aria-required')).toBe('true');
      }
      for (const label of ['藥品代碼', '醫院', '備註']) {
        expect(field(label).getAttribute('aria-required')).toBeNull();
      }
    });

    it('處方開立日的 max 為今天', () => {
      renderPlanner();
      expect(field('處方開立日').getAttribute('max')).toBe('2026-10-31');
    });

    it('尚未登記時顯示空狀態而不渲染清單', () => {
      renderPlanner();
      expect(screen.getByText('尚未登記任何連續處方')).not.toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });
  });

  describe('唯讀與限制', () => {
    it('沒有 provider 時為唯讀：表單與選單皆禁用，且只顯示一次唯讀提示', () => {
      render(<RefillPlanner now={NOW} visits={DRUG_VISITS} />);
      const labels = ['藥品名稱', '藥品代碼', '醫院', '處方開立日', '每次天數', '連續處方總次數', '已領藥次數', '備註'];
      for (const label of labels) expect(field(label).disabled).toBe(true);
      expect((screen.getByLabelText('從健保用藥紀錄帶入') as HTMLSelectElement).disabled).toBe(true);
      expect(addButton().disabled).toBe(true);
      expect(screen.getAllByText(/目前為唯讀狀態/)).toHaveLength(1);
      expect(screen.getByText('尚未登記任何連續處方')).not.toBeNull();
    });

    it('唯讀時既有資料的領藥與刪除按鈕皆禁用', () => {
      renderPlanner({ initial: withRefills([OPEN]), canEdit: false });
      expect(rowButton('乙藥', '已領藥（+1）').disabled).toBe(true);
      expect(rowButton('乙藥', '刪除').disabled).toBe(true);
      expect(addButton().disabled).toBe(true);
    });

    it('儲存中時禁用新增、領藥與刪除', () => {
      renderWithValue({ personal: withRefills([OPEN]), saving: true });
      expect(rowButton('乙藥', '已領藥（+1）').disabled).toBe(true);
      expect(rowButton('乙藥', '刪除').disabled).toBe(true);
      expect(addButton().disabled).toBe(true);
      expect(field('藥品名稱').disabled).toBe(true);
    });

    it('已達 200 筆上限時拒絕新增', async () => {
      const many = Array.from({ length: PERSONAL_LIMITS.refills }, (_, index) =>
        refill({ id: `r${index}`, drugName: `藥品${index}` }),
      );
      const update = makeUpdate();
      renderWithValue({ personal: withRefills(many), update });
      fill();
      await submit();
      expect(document.querySelector('[role="alert"]')?.textContent).toBe('連續處方已達上限（200 筆）');
      expect(update).not.toHaveBeenCalled();
    });
  });

  describe('新增', () => {
    it('新增成功後出現在清單，並重置輸入', async () => {
      renderPlanner();
      fill({
        ...VALID_FORM,
        藥品代碼: 'AB12345678',
        醫院: '台大醫院',
        備註: '飯後服用',
      });
      await submit();

      const row = await waitFor(() => rowOf('降血壓藥'));
      expect(within(row).getByText('AB12345678').className).toContain('font-mono');
      expect(within(row).getByText('可領藥')).not.toBeNull();
      expect(within(row).getByText('2026-10-28').className).toContain('font-mono');
      expect(row.textContent).toContain('台大醫院');
      expect(row.textContent).toContain('已領 1/3 次 · 每次 28 天');
      expect(row.textContent).toContain('最早可領藥日：2026-10-28');
      expect(row.textContent).toContain('預估藥量用完日：2026-11-07');
      expect(row.textContent).toContain('飯後服用');

      await waitFor(() => expect(field('藥品名稱').value).toBe(''));
      for (const label of ['藥品代碼', '醫院', '處方開立日', '每次天數', '連續處方總次數', '備註']) {
        expect(field(label).value).toBe('');
      }
      expect(field('已領藥次數').value).toBe('1');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('尚未登記任何連續處方')).toBeNull();
    });

    const INVALID_CASES: Array<{ name: string; values: Record<string, string>; message: string }> = [
      { name: '未輸入藥品名稱', values: { ...VALID_FORM, 藥品名稱: '' }, message: '請輸入藥品名稱' },
      { name: '每次天數超出範圍', values: { ...VALID_FORM, 每次天數: '181' }, message: '每次天數需為 1–180 的整數' },
      { name: '已領藥次數大於總次數', values: { ...VALID_FORM, 已領藥次數: '4' }, message: '已領藥次數需介於 1 與總次數之間' },
      { name: '處方開立日晚於今天', values: { ...VALID_FORM, 處方開立日: '2026-11-01' }, message: '處方開立日不能晚於今天' },
    ];

    it.each(INVALID_CASES)('$name時顯示錯誤且不呼叫 update', async ({ values, message }) => {
      const update = makeUpdate();
      renderWithValue({ update });
      fill(values);
      await submit();
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect(update).not.toHaveBeenCalled();
      expect(field('藥品名稱').value).toBe(values['藥品名稱']);
    });

    it('編輯任一欄位後清除錯誤訊息', async () => {
      renderPlanner();
      await submit();
      expect(screen.getByRole('alert')).not.toBeNull();
      enter('藥品名稱', '降血壓藥');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('update 失敗時保留已輸入內容且不新增', async () => {
      renderPlanner({ fail: true });
      fill({ ...VALID_FORM, 備註: '早晚各一次' });
      await submit();
      expect(field('藥品名稱').value).toBe('降血壓藥');
      expect(field('處方開立日').value).toBe('2026-10-10');
      expect(field('每次天數').value).toBe('28');
      expect(field('連續處方總次數').value).toBe('3');
      expect(field('備註').value).toBe('早晚各一次');
      expect(screen.getByText('尚未登記任何連續處方')).not.toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });
  });

  describe('從健保用藥紀錄帶入', () => {
    it('帶入藥品名稱、代碼與最近處方日，且仍可修改', async () => {
      renderPlanner({ visits: DRUG_VISITS });
      const select = screen.getByLabelText('從健保用藥紀錄帶入') as HTMLSelectElement;
      expect(within(select).getAllByRole('option').map(option => option.textContent)).toEqual([
        '從健保用藥紀錄帶入…',
        '降血壓藥（AB12345678，最近 2026-10-01）',
      ]);

      fireEvent.change(select, { target: { value: 'AB12345678' } });
      expect(field('藥品名稱').value).toBe('降血壓藥');
      expect(field('藥品代碼').value).toBe('AB12345678');
      expect(field('處方開立日').value).toBe('2026-10-01');
      expect(select.value).toBe('');

      enter('處方開立日', '2026-10-05');
      enter('每次天數', '28');
      enter('連續處方總次數', '3');
      await submit();

      const row = await waitFor(() => rowOf('降血壓藥'));
      expect(row.textContent).toContain('AB12345678');
      expect(row.textContent).toContain('預估藥量用完日：2026-11-02');
    });

    it.each([
      { name: '未提供 visits', visits: undefined },
      { name: 'visits 為空', visits: [] },
      { name: 'visits 只有非藥品醫令', visits: [visitOn(new Date(2026, 9, 1), [{ code: '01001C', name: '診察費', qty: 1 }])] },
    ])('$name時不顯示帶入選單', ({ visits }) => {
      renderPlanner({ visits });
      expect(screen.queryByLabelText('從健保用藥紀錄帶入')).toBeNull();
    });
  });

  describe('清單狀態與排序', () => {
    it.each([
      { name: '逾期', plan: OVERDUE, drug: '甲藥', badge: '藥量可能已用完', opens: '2026-10-08', ends: '2026-10-18', timing: '預估已用完 13 天' },
      { name: '可領藥', plan: OPEN, drug: '乙藥', badge: '可領藥', opens: '2026-10-28', ends: '2026-11-07', timing: '預估 7 天後用完' },
      { name: '尚未到期', plan: NOT_YET, drug: '丙藥', badge: '尚未到期', opens: '2026-11-12', ends: '2026-11-22', timing: '12 天後開始可領' },
    ])('$name：以文字徽章、最早可領藥日與預估用完日呈現', ({ plan, drug, badge, opens, ends, timing }) => {
      renderPlanner({ initial: withRefills([plan]) });
      const row = rowOf(drug);
      expect(within(row).getByText(badge).className).toContain('dark:');
      expect(row.textContent).toContain(`最早可領藥日：${opens}`);
      expect(row.textContent).toContain(`預估藥量用完日：${ends}`);
      expect(row.textContent).toContain(timing);
    });

    it('已領完的處方只顯示預估用完日，不顯示最早可領藥日並禁用領藥', () => {
      renderPlanner({ initial: withRefills([FINISHED]) });
      const row = rowOf('丁藥');
      expect(within(row).getByText('連續處方已領完，需回診開立新處方')).not.toBeNull();
      expect(row.textContent).toContain('已領 3/3 次 · 每次 28 天');
      expect(row.textContent).toContain('預估藥量用完日：2026-10-24');
      expect(row.textContent).not.toContain('最早可領藥日');
      expect(rowButton('丁藥', '已領藥（+1）').disabled).toBe(true);
    });

    it('依急迫度排序：逾期 → 可領藥 → 尚未到期 → 已領完', () => {
      renderPlanner({ initial: withRefills([NOT_YET, FINISHED, OPEN, OVERDUE]) });
      expect(listedNames()).toEqual(['甲藥', '乙藥', '丙藥', '丁藥']);
    });

    it('同為逾期時，逾期較久者在前', () => {
      const longer = refill({ id: 'longer', drugName: '戊藥', prescribedDate: '2026-08-01' });
      renderPlanner({ initial: withRefills([OVERDUE, longer]) });
      expect(listedNames()).toEqual(['戊藥', '甲藥']);
    });
  });

  describe('領藥', () => {
    it('按「已領藥（+1）」會遞增已領次數並重新推估用完日與狀態', async () => {
      renderPlanner({ initial: withRefills([OPEN]) });
      expect(rowOf('乙藥').textContent).toContain('已領 1/3 次 · 每次 28 天');

      await click(rowButton('乙藥', '已領藥（+1）'));

      const row = rowOf('乙藥');
      expect(row.textContent).toContain('已領 2/3 次 · 每次 28 天');
      expect(row.textContent).toContain('預估藥量用完日：2026-12-05');
      expect(row.textContent).toContain('最早可領藥日：2026-11-25');
      expect(within(row).getByText('尚未到期')).not.toBeNull();
    });

    it('領完最後一次後禁用按鈕並顯示領完提示', async () => {
      renderPlanner({ initial: withRefills([refill({ taken: 2 })]) });
      expect(rowButton('乙藥', '已領藥（+1）').disabled).toBe(false);

      await click(rowButton('乙藥', '已領藥（+1）'));

      const row = rowOf('乙藥');
      expect(row.textContent).toContain('已領 3/3 次');
      expect(within(row).getByText('連續處方已領完，需回診開立新處方')).not.toBeNull();
      expect(row.textContent).not.toContain('最早可領藥日');
      expect(rowButton('乙藥', '已領藥（+1）').disabled).toBe(true);
    });

    it('update 失敗時不改變已領次數', async () => {
      renderPlanner({ initial: withRefills([OPEN]), fail: true });
      await click(rowButton('乙藥', '已領藥（+1）'));
      expect(rowOf('乙藥').textContent).toContain('已領 1/3 次');
    });
  });

  describe('刪除', () => {
    it('需兩段式確認：取消保留、確認才移除', async () => {
      renderPlanner({ initial: withRefills([OPEN, NOT_YET]) });
      const row = rowOf('乙藥');

      await click(rowButton('乙藥', '刪除'));
      expect(within(row).getByText('確定刪除？')).not.toBeNull();
      expect(within(row).queryByRole('button', { name: '刪除' })).toBeNull();

      await click(rowButton('乙藥', '取消'));
      expect(within(row).queryByText('確定刪除？')).toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(2);

      await click(rowButton('乙藥', '刪除'));
      await click(rowButton('乙藥', '確認'));
      expect(screen.queryByText('乙藥')).toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
      expect(screen.getByText('丙藥')).not.toBeNull();
    });

    it('刪除最後一筆後回到空狀態', async () => {
      renderPlanner({ initial: withRefills([OPEN]) });
      await click(rowButton('乙藥', '刪除'));
      await click(rowButton('乙藥', '確認'));
      expect(screen.getByText('尚未登記任何連續處方')).not.toBeNull();
      expect(screen.queryByRole('list')).toBeNull();
    });

    it('update 失敗時保留該筆資料', async () => {
      renderPlanner({ initial: withRefills([OPEN]), fail: true });
      await click(rowButton('乙藥', '刪除'));
      await click(rowButton('乙藥', '確認'));
      expect(screen.getByText('乙藥')).not.toBeNull();
      expect(screen.getAllByRole('listitem')).toHaveLength(1);
    });
  });

  describe('update 的 mutator 以傳入的 current 為基準', () => {
    it('新增：附加到 current.refills 並保留既有資料', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      fill();
      await submit();
      expect(update).toHaveBeenCalledTimes(1);

      const existing = refill({ id: 'existing', drugName: '既有藥' });
      const current = withRefills([existing]);
      const next = lastMutator(update)(current);
      expect(current.refills).toHaveLength(1);
      expect(next.refills).toHaveLength(2);
      expect(next.refills[0]).toEqual(existing);
      expect(next.refills[1]).toStrictEqual({
        id: expect.any(String),
        drugName: '降血壓藥',
        prescribedDate: '2026-10-10',
        daysPerFill: 28,
        fills: 3,
        taken: 1,
      });
    });

    it('領藥：以 current 的已領次數為準，上限為總次數，找不到 id 時不變更', async () => {
      const update = makeUpdate();
      renderWithValue({ personal: withRefills([OPEN]), update });
      await click(rowButton('乙藥', '已領藥（+1）'));

      const mutator = lastMutator(update);
      const current = withRefills([{ ...OPEN, taken: 2 }, NOT_YET]);
      expect(mutator(current).refills.map(plan => plan.taken)).toEqual([3, 1]);
      expect(current.refills[0]?.taken).toBe(2);
      expect(mutator(withRefills([{ ...OPEN, taken: 3 }])).refills[0]?.taken).toBe(3);
      const missing = withRefills([NOT_YET]);
      expect(mutator(missing).refills).toEqual(missing.refills);
    });

    it('刪除：只移除指定 id，其餘以 current 為準', async () => {
      const update = makeUpdate();
      renderWithValue({ personal: withRefills([OPEN]), update });
      await click(rowButton('乙藥', '刪除'));
      await click(rowButton('乙藥', '確認'));

      const next = lastMutator(update)(withRefills([OPEN, NOT_YET]));
      expect(next.refills.map(plan => plan.id)).toEqual(['notyet']);
    });
  });
});
