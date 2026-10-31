import { useState, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PersonalContext, type PersonalContextValue } from '../personalContext';
import { emptyPersonal, PERSONAL_LIMITS, type LabTarget, type PersonalData } from '../personalData';
import { validateLabTarget } from '../lib/labTargets';
import TargetEditor from './TargetEditor';

afterEach(cleanup);

type Mutator = Parameters<PersonalContextValue['update']>[0];
type EditorProps = { seriesKey: string; subItem: string; unit?: string };

const KEY = 'lab-series:glucose';
const OTHER = 'lab-series:other';
const DEFAULT_PROPS: EditorProps = { seriesKey: KEY, subItem: '血糖', unit: 'mg/dL' };

const withTargets = (targets: Record<string, LabTarget>): PersonalData => ({ ...emptyPersonal(), targets });

const manyTargets = (count: number): Record<string, LabTarget> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`other-${index}`, { high: index }]));

function valueOf(overrides: Partial<PersonalContextValue> = {}): PersonalContextValue {
  return {
    personal: emptyPersonal(), canEdit: true, saving: false, error: null, clearError: () => {},
    update: async () => true, ...overrides,
  };
}

function tree(overrides: Partial<PersonalContextValue> = {}, props: Partial<EditorProps> = {}) {
  return (
    <PersonalContext.Provider value={valueOf(overrides)}>
      <TargetEditor {...DEFAULT_PROPS} {...props} />
    </PersonalContext.Provider>
  );
}

const renderWithValue = (overrides: Partial<PersonalContextValue> = {}, props: Partial<EditorProps> = {}) =>
  render(tree(overrides, props));

function Harness({ initial = emptyPersonal(), fail = false, children }: {
  initial?: PersonalData; fail?: boolean; children: ReactNode;
}) {
  const [personal, setPersonal] = useState(initial);
  const value: PersonalContextValue = {
    personal, canEdit: true, saving: false, error: null, clearError: () => {},
    update: async mutator => {
      if (fail) return false;
      setPersonal(current => mutator(current));
      return true;
    },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

const makeUpdate = (result = true) => vi.fn<PersonalContextValue['update']>(async () => result);

function lastMutator(update: ReturnType<typeof makeUpdate>): Mutator {
  const call = update.mock.calls.at(-1);
  if (!call) throw new Error('update 尚未被呼叫');
  return call[0];
}

const LOW = '下限（≥）';
const HIGH = '上限（≤）';
const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const enter = (label: string, value: string) => { fireEvent.change(field(label), { target: { value } }); };
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const openEditor = async (verb = '設定') => { await click(button(`${verb}個人目標：血糖`)); };
const saveButton = () => button('儲存');
const submitForm = async () => {
  await act(async () => { fireEvent.submit(screen.getByRole('form', { name: '血糖 個人目標' })); });
};

describe('TargetEditor', () => {
  describe('顯示條件', () => {
    it('唯讀且未展開時不顯示任何內容', () => {
      const { container } = renderWithValue({ canEdit: false });
      expect(container.firstChild).toBeNull();
    });

    it('可編輯時預設收合，按鈕顯示「設定個人目標」', () => {
      renderWithValue();
      const toggle = button('設定個人目標：血糖');
      expect(toggle.textContent).toBe('設定個人目標');
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBeNull();
      expect(screen.queryByRole('form')).toBeNull();
    });

    it('已有目標時按鈕改為「編輯個人目標」', () => {
      renderWithValue({ personal: withTargets({ [KEY]: { low: 70, high: 99 } }) });
      expect(button('編輯個人目標：血糖').textContent).toBe('編輯個人目標');
    });

    it('其他項目的目標不影響本項目的按鈕文字', () => {
      renderWithValue({ personal: withTargets({ [OTHER]: { high: 5 } }) });
      expect(button('設定個人目標：血糖').textContent).toBe('設定個人目標');
    });

    it('識別碼與 Object 原型屬性同名時仍視為未設定', () => {
      renderWithValue({}, { seriesKey: 'toString' });
      expect(button('設定個人目標：血糖').textContent).toBe('設定個人目標');
    });

    it('收合時不含 aria-pressed，也不產生 status 或 alert', () => {
      renderWithValue({ saving: true, error: '儲存失敗：網路中斷' });
      expect(button('設定個人目標：血糖').hasAttribute('aria-pressed')).toBe(false);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
    });
  });

  describe('展開編輯器', () => {
    it('展開後顯示具名表單與兩個空白欄位，並以 aria-controls 關聯', async () => {
      renderWithValue();
      await openEditor();
      const form = screen.getByRole('form', { name: '血糖 個人目標' });
      expect(field(LOW).value).toBe('');
      expect(field(HIGH).value).toBe('');
      const toggle = button('設定個人目標：血糖');
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      expect(toggle.getAttribute('aria-controls')).toBe(form.id);
      expect(toggle.textContent).toBe('設定個人目標');
    });

    it('已有目標時以現有數值預填', async () => {
      renderWithValue({ personal: withTargets({ [KEY]: { low: 70, high: 99 } }) });
      await openEditor('編輯');
      expect(field(LOW).value).toBe('70');
      expect(field(HIGH).value).toBe('99');
    });

    it('單向目標只預填有設定的那一端', async () => {
      renderWithValue({ personal: withTargets({ [KEY]: { high: 90 } }) });
      await openEditor('編輯');
      expect(field(LOW).value).toBe('');
      expect(field(HIGH).value).toBe('90');
    });

    it('說明文字含單位，並與兩個欄位以 aria-describedby 關聯', async () => {
      renderWithValue();
      await openEditor();
      const hint = screen.getByText(/至少填寫一項/);
      expect(hint.textContent).toContain('單位：mg/dL');
      expect(field(LOW).getAttribute('aria-describedby')).toBe(hint.id);
      expect(field(HIGH).getAttribute('aria-describedby')).toBe(hint.id);
    });

    it('沒有單位時不顯示單位提示', async () => {
      renderWithValue({}, { unit: undefined });
      await openEditor();
      expect(screen.getByText(/至少填寫一項/).textContent).not.toContain('單位');
    });

    it('再按一次按鈕會收合，重新展開時錯誤訊息已清除', async () => {
      renderWithValue();
      await openEditor();
      await click(saveButton());
      expect(screen.getByRole('alert')).toBeTruthy();
      await click(button('設定個人目標：血糖'));
      expect(screen.queryByRole('form')).toBeNull();
      await openEditor();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('狀態列', () => {
    it('展開後儲存中顯示 status，並停用輸入與儲存', async () => {
      renderWithValue({ saving: true });
      await openEditor();
      expect(screen.getByRole('status').textContent).toBe('儲存中…');
      expect(field(LOW).disabled).toBe(true);
      expect(field(HIGH).disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(button('取消').disabled).toBe(false);
    });

    it('展開後顯示儲存失敗訊息，關閉按鈕會呼叫 clearError', async () => {
      const clearError = vi.fn();
      renderWithValue({ error: '儲存失敗：網路中斷', clearError });
      await openEditor();
      expect(screen.getByRole('alert').textContent).toContain('儲存失敗：網路中斷');
      await click(button('關閉錯誤訊息'));
      expect(clearError).toHaveBeenCalledTimes(1);
    });

    it('展開期間變成唯讀時保留表單、停用輸入並顯示唯讀提示', async () => {
      const { rerender } = render(tree());
      await openEditor();
      enter(LOW, '70');
      rerender(tree({ canEdit: false }));
      expect(screen.getByRole('form', { name: '血糖 個人目標' })).toBeTruthy();
      expect(field(LOW).value).toBe('70');
      expect(field(LOW).disabled).toBe(true);
      expect(field(HIGH).disabled).toBe(true);
      expect(saveButton().disabled).toBe(true);
      expect(screen.getByText(/目前為唯讀狀態/)).toBeTruthy();
    });
  });

  describe('驗證', () => {
    it('兩端皆空白時顯示錯誤且不呼叫 update', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      await click(saveButton());
      expect(screen.getByRole('alert').textContent).toBe('請至少填寫下限或上限');
      expect(update).not.toHaveBeenCalled();
    });

    it('修改欄位後會清除錯誤', async () => {
      renderWithValue();
      await openEditor();
      await click(saveButton());
      expect(screen.getByRole('alert')).toBeTruthy();
      enter(LOW, '7');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('下限大於上限時顯示錯誤', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '100');
      enter(HIGH, '90');
      await click(saveButton());
      expect(screen.getByRole('alert').textContent).toBe('下限不可大於上限');
      expect(update).not.toHaveBeenCalled();
    });

    it('非數字時顯示驗證函式回報的訊息', async () => {
      const expected = validateLabTarget({ low: 'abc', high: '' });
      if (expected.ok) throw new Error('預期為無效輸入');
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, 'abc');
      await click(saveButton());
      expect(screen.getByRole('alert').textContent).toBe(expected.error);
      expect(update).not.toHaveBeenCalled();
    });

    it('新增項目已達上限時顯示錯誤且不呼叫 update', async () => {
      const update = makeUpdate();
      renderWithValue({ update, personal: withTargets(manyTargets(PERSONAL_LIMITS.targets)) });
      await openEditor();
      enter(HIGH, '90');
      await click(saveButton());
      expect(screen.getByRole('alert').textContent).toBe(`個人目標已達上限（${PERSONAL_LIMITS.targets} 項）`);
      expect(update).not.toHaveBeenCalled();
    });

    it('已設定過的項目在達到上限時仍可修改', async () => {
      const update = makeUpdate();
      const personal = withTargets({ ...manyTargets(PERSONAL_LIMITS.targets - 1), [KEY]: { high: 90 } });
      renderWithValue({ update, personal });
      await openEditor('編輯');
      enter(HIGH, '95');
      await click(saveButton());
      expect(update).toHaveBeenCalledTimes(1);
      expect(lastMutator(update)(personal).targets[KEY]).toStrictEqual({ high: 95 });
    });

    it('儲存中直接送出表單不會驗證也不會呼叫 update', async () => {
      const update = makeUpdate();
      renderWithValue({ update, saving: true });
      await openEditor();
      await submitForm();
      expect(update).not.toHaveBeenCalled();
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('儲存', () => {
    it('雙向目標：update 一次、寫入 { low, high } 並收合', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '70');
      enter(HIGH, '99');
      await click(saveButton());
      expect(update).toHaveBeenCalledTimes(1);
      expect(lastMutator(update)(emptyPersonal()).targets[KEY]).toStrictEqual({ low: 70, high: 99 });
      expect(screen.queryByRole('form')).toBeNull();
    });

    it('只填上限時不會寫入 low 鍵', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(HIGH, '90');
      await click(saveButton());
      expect(lastMutator(update)(emptyPersonal()).targets[KEY]).toStrictEqual({ high: 90 });
    });

    it('接受全形數字與小數', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '５.５');
      enter(HIGH, '９０');
      await click(saveButton());
      expect(lastMutator(update)(emptyPersonal()).targets[KEY]).toStrictEqual({ low: 5.5, high: 90 });
    });

    it('mutator 保留其他項目的目標與其餘個人資料', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(HIGH, '90');
      await click(saveButton());
      const base: PersonalData = { ...withTargets({ [OTHER]: { low: 1 } }), notes: [] };
      const next = lastMutator(update)(base);
      expect(next.targets).toStrictEqual({ [OTHER]: { low: 1 }, [KEY]: { high: 90 } });
      expect(next.refills).toBe(base.refills);
      expect(next.measurements).toBe(base.measurements);
    });

    it('點「儲存」與直接送出表單的結果相同', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '60');
      await submitForm();
      expect(update).toHaveBeenCalledTimes(1);
      expect(lastMutator(update)(emptyPersonal()).targets[KEY]).toStrictEqual({ low: 60 });
    });

    it('update 失敗時保持展開並保留輸入', async () => {
      const update = makeUpdate(false);
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '70');
      enter(HIGH, '99');
      await click(saveButton());
      expect(update).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('form', { name: '血糖 個人目標' })).toBeTruthy();
      expect(field(LOW).value).toBe('70');
      expect(field(HIGH).value).toBe('99');
    });
  });

  describe('清除目標', () => {
    it('尚未設定目標時沒有「清除目標」按鈕', async () => {
      renderWithValue();
      await openEditor();
      expect(screen.queryByRole('button', { name: '清除目標' })).toBeNull();
    });

    it('已有目標時只移除本項目並收合', async () => {
      const update = makeUpdate();
      const personal = withTargets({ [KEY]: { low: 70 }, [OTHER]: { high: 5 } });
      renderWithValue({ update, personal });
      await openEditor('編輯');
      await click(button('清除目標'));
      expect(update).toHaveBeenCalledTimes(1);
      expect(lastMutator(update)(personal).targets).toStrictEqual({ [OTHER]: { high: 5 } });
      expect(screen.queryByRole('form')).toBeNull();
    });

    it('清除失敗時保持展開', async () => {
      const update = makeUpdate(false);
      renderWithValue({ update, personal: withTargets({ [KEY]: { low: 70 } }) });
      await openEditor('編輯');
      await click(button('清除目標'));
      expect(update).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('form', { name: '血糖 個人目標' })).toBeTruthy();
    });

    it('儲存中時停用「清除目標」', async () => {
      renderWithValue({ saving: true, personal: withTargets({ [KEY]: { low: 70 } }) });
      await openEditor('編輯');
      expect(button('清除目標').disabled).toBe(true);
    });
  });

  describe('取消', () => {
    it('取消會收合且不呼叫 update', async () => {
      const update = makeUpdate();
      renderWithValue({ update });
      await openEditor();
      enter(LOW, '70');
      await click(button('取消'));
      expect(screen.queryByRole('form')).toBeNull();
      expect(update).not.toHaveBeenCalled();
    });

    it('取消後重新展開會回到已儲存的數值', async () => {
      renderWithValue({ personal: withTargets({ [KEY]: { low: 70, high: 99 } }) });
      await openEditor('編輯');
      enter(LOW, '1');
      enter(HIGH, '2');
      await click(button('取消'));
      await openEditor('編輯');
      expect(field(LOW).value).toBe('70');
      expect(field(HIGH).value).toBe('99');
    });
  });

  describe('與狀態連動', () => {
    it('儲存後按鈕改為「編輯個人目標」，重新展開可看到數值', async () => {
      render(<Harness><TargetEditor {...DEFAULT_PROPS} /></Harness>);
      await openEditor();
      enter(LOW, '70');
      enter(HIGH, '99');
      await click(saveButton());
      expect(button('編輯個人目標：血糖')).toBeTruthy();
      await openEditor('編輯');
      expect(field(LOW).value).toBe('70');
      expect(field(HIGH).value).toBe('99');
    });

    it('清除後按鈕回到「設定個人目標」', async () => {
      render(
        <Harness initial={withTargets({ [KEY]: { high: 90 } })}>
          <TargetEditor {...DEFAULT_PROPS} />
        </Harness>,
      );
      await openEditor('編輯');
      await click(button('清除目標'));
      expect(button('設定個人目標：血糖')).toBeTruthy();
      await openEditor();
      expect(field(HIGH).value).toBe('');
    });

    it('儲存失敗時按鈕文字不變', async () => {
      render(<Harness fail><TargetEditor {...DEFAULT_PROPS} /></Harness>);
      await openEditor();
      enter(HIGH, '90');
      await click(saveButton());
      expect(screen.getByRole('form', { name: '血糖 個人目標' })).toBeTruthy();
      expect(button('設定個人目標：血糖')).toBeTruthy();
    });
  });
});
