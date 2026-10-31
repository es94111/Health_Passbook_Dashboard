import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { PropsWithChildren, ReactNode } from 'react';
import { addDays, formatLocalDate } from '../lib/clock';
import { EMPTY_VALUE } from '../lib/measurements';
import { PersonalContext } from '../personalContext';
import type { PersonalContextValue } from '../personalContext';
import { PERSONAL_LIMITS, emptyPersonal } from '../personalData';
import type { GlucoseContext, Measurement, PersonalData } from '../personalData';
import Measurements from './Measurements';

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  LineChart: ({ children, data }: PropsWithChildren<{ data: { primary: number }[] }>) => (
    <div data-testid="trend-chart" data-values={JSON.stringify(data.map(point => point.primary))}>
      {children}
    </div>
  ),
  CartesianGrid: () => null,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

afterEach(cleanup);

const NOW = new Date(2026, 9, 31, 12, 0, 0);

interface HarnessProps {
  initial?: PersonalData;
  canEdit?: boolean;
  saving?: boolean;
  fail?: boolean;
  onUpdate?: () => void;
  children: ReactNode;
}

function Harness({ initial = emptyPersonal(), canEdit = true, saving = false, fail = false, onUpdate, children }: HarnessProps) {
  const [personal, setPersonal] = useState(initial);
  const value: PersonalContextValue = {
    personal,
    canEdit,
    saving,
    error: null,
    clearError: () => {},
    update: async mutator => {
      onUpdate?.();
      if (fail) return false;
      setPersonal(mutator(personal));
      return true;
    },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

function renderMeasurements(options: Omit<HarnessProps, 'children'> = {}) {
  return render(
    <Harness {...options}>
      <Measurements now={NOW} />
    </Harness>,
  );
}

function renderWithLatest(personal: PersonalData, latest: PersonalData): PersonalData[] {
  const written: PersonalData[] = [];
  const value: PersonalContextValue = {
    personal,
    canEdit: true,
    saving: false,
    error: null,
    clearError: () => {},
    update: async mutator => {
      written.push(mutator(latest));
      return true;
    },
  };
  render(
    <PersonalContext.Provider value={value}>
      <Measurements now={NOW} />
    </PersonalContext.Provider>,
  );
  return written;
}

function daysAgo(days: number): string {
  return formatLocalDate(addDays(NOW, -days));
}

interface Extras {
  time?: string;
  note?: string;
}

function bp(id: string, date: string, systolic: number, diastolic: number, extra: Extras & { pulse?: number } = {}): Measurement {
  return { id, kind: 'bp', date, systolic, diastolic, ...extra };
}

function glucose(id: string, date: string, value: number, context: GlucoseContext, extra: Extras = {}): Measurement {
  return { id, kind: 'glucose', date, value, context, ...extra };
}

function weight(id: string, date: string, value: number, extra: Extras = {}): Measurement {
  return { id, kind: 'weight', date, value, ...extra };
}

function withMeasurements(measurements: Measurement[]): PersonalData {
  return { ...emptyPersonal(), measurements };
}

function textbox(name: string): HTMLInputElement {
  return screen.getByRole('textbox', { name }) as HTMLInputElement;
}

function fill(name: string, value: string) {
  fireEvent.change(textbox(name), { target: { value } });
}

function fillBloodPressure(systolic: string, diastolic: string) {
  fill('收縮壓（mmHg）', systolic);
  fill('舒張壓（mmHg）', diastolic);
}

function dateInput(): HTMLInputElement {
  return screen.getByLabelText('日期') as HTMLInputElement;
}

function timeInput(): HTMLInputElement {
  return screen.getByLabelText('時間（選填）') as HTMLInputElement;
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole('button', { name: '新增' }) as HTMLButtonElement;
}

function recordRows(listName: string): HTMLElement[] {
  return within(screen.getByRole('list', { name: listName })).getAllByRole('listitem');
}

function onlyRow(listName: string): HTMLElement {
  const rows = recordRows(listName);
  expect(rows).toHaveLength(1);
  return rows[0] as HTMLElement;
}

function summaryCell(title: string): HTMLElement {
  const cell = screen.getByText(title).parentElement;
  if (!cell) throw new Error(`找不到摘要卡：${title}`);
  return cell;
}

function chartValues(): number[] {
  return JSON.parse(screen.getByTestId('trend-chart').getAttribute('data-values') ?? '[]') as number[];
}

describe('Measurements 自我量測', () => {
  describe('權限與預設狀態', () => {
    it('未包 PersonalContext.Provider 時為唯讀：表單禁用並顯示提示', () => {
      render(<Measurements now={NOW} />);
      expect(screen.getAllByText(/目前為唯讀狀態/)).toHaveLength(1);
      for (const name of ['收縮壓（mmHg）', '舒張壓（mmHg）', '脈搏（次/分，選填）', '備註（選填）']) {
        expect(textbox(name).disabled).toBe(true);
      }
      expect(dateInput().disabled).toBe(true);
      expect(timeInput().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      expect(screen.getByText('尚無血壓紀錄。')).toBeTruthy();
    });

    it('唯讀時仍可瀏覽既有紀錄，但新增與刪除皆禁用', () => {
      const onUpdate = vi.fn();
      renderMeasurements({ canEdit: false, onUpdate, initial: withMeasurements([bp('a', '2026-10-31', 120, 80)]) });
      expect(recordRows('血壓紀錄')).toHaveLength(1);
      expect(submitButton().disabled).toBe(true);
      expect((screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.submit(screen.getByRole('form', { name: '新增血壓紀錄' }));
      expect(screen.queryByRole('alert')).toBeNull();
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('儲存中時禁用輸入、新增與刪除，並顯示儲存中提示', () => {
      renderMeasurements({ saving: true, initial: withMeasurements([bp('a', '2026-10-31', 120, 80)]) });
      expect(screen.getByText('儲存中…')).toBeTruthy();
      expect(textbox('收縮壓（mmHg）').disabled).toBe(true);
      expect(dateInput().disabled).toBe(true);
      expect(submitButton().disabled).toBe(true);
      expect((screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' }) as HTMLButtonElement).disabled).toBe(true);
    });

    it('顯示標題與免責說明，預設選取血壓', () => {
      renderMeasurements();
      expect(screen.getByRole('region', { name: '自我量測' })).toBeTruthy();
      expect(screen.getByRole('heading', { level: 2, name: '自我量測' })).toBeTruthy();
      expect(screen.getByText(/不構成診斷或醫療建議/)).toBeTruthy();
      const group = screen.getByRole('group', { name: '量測類型' });
      expect(within(group).getAllByRole('button').map(button => button.textContent)).toEqual(['血壓', '血糖', '體重']);
      expect(within(group).getByRole('button', { name: '血壓' }).getAttribute('aria-pressed')).toBe('true');
      expect(within(group).getByRole('button', { name: '血糖' }).getAttribute('aria-pressed')).toBe('false');
      expect(within(group).getByRole('button', { name: '體重' }).getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByRole('form', { name: '新增血壓紀錄' })).toBeTruthy();
    });

    it('日期預設為今天且不可晚於今天；數值欄位使用數字輸入模式', () => {
      renderMeasurements();
      expect(dateInput().value).toBe('2026-10-31');
      expect(dateInput().max).toBe('2026-10-31');
      expect(timeInput().value).toBe('');
      expect(textbox('收縮壓（mmHg）').getAttribute('inputmode')).toBe('numeric');
      expect(textbox('脈搏（次/分，選填）').getAttribute('inputmode')).toBe('numeric');
      expect(textbox('收縮壓（mmHg）').getAttribute('autocomplete')).toBe('off');

      fireEvent.click(screen.getByRole('button', { name: '體重' }));
      expect(textbox('體重（kg）').getAttribute('inputmode')).toBe('decimal');
    });
  });

  describe('新增紀錄', () => {
    it('新增血壓：出現在清單，數值、時間與備註被重置，日期保留', async () => {
      renderMeasurements();
      fillBloodPressure('125', '80');
      fill('脈搏（次/分，選填）', '72');
      fill('備註（選填）', '起床後量測');
      fireEvent.change(timeInput(), { target: { value: '07:30' } });
      fireEvent.change(dateInput(), { target: { value: '2026-10-30' } });
      fireEvent.click(submitButton());

      await screen.findByRole('list', { name: '血壓紀錄' });
      const row = onlyRow('血壓紀錄');
      expect(within(row).getByText('2026-10-30 07:30')).toBeTruthy();
      expect(within(row).getByText('125/80')).toBeTruthy();
      expect(within(row).getByText('72')).toBeTruthy();
      expect(within(row).getByText('起床後量測')).toBeTruthy();

      await waitFor(() => expect(textbox('收縮壓（mmHg）').value).toBe(''));
      expect(textbox('舒張壓（mmHg）').value).toBe('');
      expect(textbox('脈搏（次/分，選填）').value).toBe('');
      expect(textbox('備註（選填）').value).toBe('');
      expect(timeInput().value).toBe('');
      expect(dateInput().value).toBe('2026-10-30');
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('收縮壓不大於舒張壓時顯示錯誤，不呼叫 update 且保留輸入', () => {
      const onUpdate = vi.fn();
      renderMeasurements({ onUpdate });
      fillBloodPressure('80', '90');
      fireEvent.click(submitButton());
      expect(screen.getByRole('alert').textContent).toBe('收縮壓必須大於舒張壓');
      expect(onUpdate).not.toHaveBeenCalled();
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();
      expect(textbox('收縮壓（mmHg）').value).toBe('80');
      expect(textbox('舒張壓（mmHg）').value).toBe('90');
    });

    const invalidSubmissions: { title: string; fillForm: () => void; message: string }[] = [
      { title: '收縮壓空白', fillForm: () => fill('舒張壓（mmHg）', '80'), message: '請輸入收縮壓' },
      { title: '收縮壓不是數字', fillForm: () => fillBloodPressure('12a', '80'), message: '收縮壓必須是數字' },
      {
        title: '日期被清空',
        fillForm: () => {
          fillBloodPressure('120', '80');
          fireEvent.change(dateInput(), { target: { value: '' } });
        },
        message: '請選擇日期',
      },
      {
        title: '日期晚於今天',
        fillForm: () => {
          fillBloodPressure('120', '80');
          fireEvent.change(dateInput(), { target: { value: '2026-11-01' } });
        },
        message: '日期不能晚於今天',
      },
    ];

    it.each(invalidSubmissions)('$title → 顯示錯誤且不新增', ({ fillForm, message }) => {
      const onUpdate = vi.fn();
      renderMeasurements({ onUpdate });
      fillForm();
      fireEvent.click(submitButton());
      expect(screen.getByRole('alert').textContent).toBe(message);
      expect(onUpdate).not.toHaveBeenCalled();
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();
    });

    it('update 失敗時保留所有輸入，也不新增紀錄', async () => {
      const onUpdate = vi.fn();
      renderMeasurements({ fail: true, onUpdate });
      fillBloodPressure('125', '80');
      fill('備註（選填）', '保留我');
      fireEvent.click(submitButton());

      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(textbox('收縮壓（mmHg）').value).toBe('125');
      expect(textbox('舒張壓（mmHg）').value).toBe('80');
      expect(textbox('備註（選填）').value).toBe('保留我');
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();
    });

    it('血糖：未選情境時顯示錯誤，選擇空腹後新增成功並保留情境', async () => {
      renderMeasurements();
      fireEvent.click(screen.getByRole('button', { name: '血糖' }));
      expect(screen.getByRole('form', { name: '新增血糖紀錄' })).toBeTruthy();

      const context = screen.getByRole('combobox', { name: '情境' }) as HTMLSelectElement;
      const options = within(context).getAllByRole('option') as HTMLOptionElement[];
      expect(options.map(option => option.textContent)).toEqual(['請選擇情境', '空腹', '餐後', '隨機']);
      expect(options[0]?.disabled).toBe(true);
      expect(context.value).toBe('');

      fill('血糖值（mg/dL）', '95.5');
      fireEvent.click(submitButton());
      expect(screen.getByRole('alert').textContent).toBe('請選擇情境');

      fireEvent.change(context, { target: { value: 'fasting' } });
      expect(screen.queryByRole('alert')).toBeNull();
      fireEvent.click(submitButton());

      await screen.findByRole('list', { name: '血糖紀錄' });
      const row = onlyRow('血糖紀錄');
      expect(within(row).getByText('95.5')).toBeTruthy();
      expect(within(row).getByText('mg/dL')).toBeTruthy();
      expect(within(row).getByText('空腹')).toBeTruthy();

      await waitFor(() => expect(textbox('血糖值（mg/dL）').value).toBe(''));
      expect((screen.getByRole('combobox', { name: '情境' }) as HTMLSelectElement).value).toBe('fasting');
    });

    it('體重：新增後清單以 1 位小數顯示並附單位', async () => {
      renderMeasurements();
      fireEvent.click(screen.getByRole('button', { name: '體重' }));
      expect(screen.getByRole('form', { name: '新增體重紀錄' })).toBeTruthy();
      fill('體重（kg）', '70');
      fireEvent.click(submitButton());

      await screen.findByRole('list', { name: '體重紀錄' });
      const row = onlyRow('體重紀錄');
      expect(within(row).getByText('70.0')).toBeTruthy();
      expect(within(row).getByText('kg')).toBeTruthy();
      await waitFor(() => expect(textbox('體重（kg）').value).toBe(''));
    });

    it('寫入時以最新資料為基準，且只儲存有填寫的欄位', async () => {
      const remote = weight('remote', '2026-10-01', 60);
      const written = renderWithLatest(emptyPersonal(), withMeasurements([remote]));
      fillBloodPressure('120', '80');
      fireEvent.click(submitButton());

      await waitFor(() => expect(written).toHaveLength(1));
      const stored = written[0]?.measurements ?? [];
      expect(stored).toHaveLength(2);
      expect(stored[0]).toEqual(remote);
      const created = stored[1];
      expect(created).toMatchObject({ kind: 'bp', date: '2026-10-31', systolic: 120, diastolic: 80 });
      expect(Object.keys(created ?? {}).sort()).toEqual(['date', 'diastolic', 'id', 'kind', 'systolic']);
      expect(created?.id.length).toBeGreaterThan(0);
    });

    it('已達 20000 筆上限時顯示提示且不呼叫 update', () => {
      const onUpdate = vi.fn();
      const full = Array.from({ length: PERSONAL_LIMITS.measurements }, (_, index) => weight(`w${index}`, '2026-10-01', 60));
      renderMeasurements({ initial: withMeasurements(full), onUpdate });
      fillBloodPressure('120', '80');
      fireEvent.click(submitButton());
      expect(screen.getByRole('alert').textContent).toBe('量測紀錄已達上限（20000 筆）');
      expect(onUpdate).not.toHaveBeenCalled();
      expect(textbox('收縮壓（mmHg）').value).toBe('120');
    });

    it('尚有 1 筆額度時仍可新增', async () => {
      const onUpdate = vi.fn();
      const almostFull = Array.from({ length: PERSONAL_LIMITS.measurements - 1 }, (_, index) =>
        weight(`w${index}`, '2026-10-01', 60),
      );
      renderMeasurements({ initial: withMeasurements(almostFull), onUpdate });
      fillBloodPressure('120', '80');
      fireEvent.click(submitButton());
      await screen.findByRole('list', { name: '血壓紀錄' });
      expect(onUpdate).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('摘要與趨勢圖', () => {
    it('血壓摘要：最新一筆、7 日與 30 日平均、總筆數（含窗口邊界）', () => {
      renderMeasurements({
        initial: withMeasurements([
          bp('a', daysAgo(0), 120, 80),
          bp('b', daysAgo(2), 130, 90),
          bp('c', daysAgo(6), 140, 100),
          bp('d', daysAgo(7), 150, 110),
          bp('e', daysAgo(30), 160, 120),
        ]),
      });
      expect(within(summaryCell('最新一筆')).getByText('120/80')).toBeTruthy();
      expect(within(summaryCell('最新一筆')).getByText('2026-10-31')).toBeTruthy();
      expect(within(summaryCell('7 日平均')).getByText('130/90')).toBeTruthy();
      expect(within(summaryCell('30 日平均')).getByText('135/95')).toBeTruthy();
      expect(within(summaryCell('總筆數')).getByText('5')).toBeTruthy();
      expect(screen.queryByText(/正常|異常|偏高|偏低/)).toBeNull();
    });

    it('窗口內沒有讀值時，平均顯示「—」', () => {
      renderMeasurements({ initial: withMeasurements([bp('a', daysAgo(40), 118, 76)]) });
      expect(within(summaryCell('最新一筆')).getByText('118/76')).toBeTruthy();
      expect(within(summaryCell('7 日平均')).getByText(EMPTY_VALUE)).toBeTruthy();
      expect(within(summaryCell('30 日平均')).getByText(EMPTY_VALUE)).toBeTruthy();
    });

    it('血糖與體重摘要：血糖平均 0 位小數、體重 1 位小數', () => {
      renderMeasurements({
        initial: withMeasurements([
          glucose('g1', daysAgo(0), 95, 'fasting'),
          glucose('g2', daysAgo(1), 141, 'postMeal'),
          glucose('g3', daysAgo(21), 100, 'random'),
          weight('w1', daysAgo(0), 70),
          weight('w2', daysAgo(1), 71),
          weight('w3', daysAgo(11), 72.5),
        ]),
      });

      fireEvent.click(screen.getByRole('button', { name: '血糖' }));
      expect(within(summaryCell('最新一筆')).getByText('95')).toBeTruthy();
      expect(within(summaryCell('7 日平均')).getByText('118')).toBeTruthy();
      expect(within(summaryCell('30 日平均')).getByText('112')).toBeTruthy();
      expect(within(summaryCell('總筆數')).getByText('3')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '體重' }));
      expect(within(summaryCell('最新一筆')).getByText('70.0')).toBeTruthy();
      expect(within(summaryCell('7 日平均')).getByText('70.5')).toBeTruthy();
      expect(within(summaryCell('30 日平均')).getByText('71.2')).toBeTruthy();
      expect(within(summaryCell('總筆數')).getByText('3')).toBeTruthy();
    });

    it('沒有任何紀錄時顯示空狀態，不顯示摘要、圖表與清單', () => {
      renderMeasurements();
      expect(screen.getByText('尚無血壓紀錄，請使用上方表單新增第一筆。')).toBeTruthy();
      expect(screen.queryByText('最新一筆')).toBeNull();
      expect(screen.queryByRole('combobox', { name: '圖表範圍' })).toBeNull();
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '血糖' }));
      expect(screen.getByText('尚無血糖紀錄，請使用上方表單新增第一筆。')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '體重' }));
      expect(screen.getByText('尚無體重紀錄，請使用上方表單新增第一筆。')).toBeTruthy();
    });

    it('只有 1 筆時不畫圖，改顯示資料不足的說明', () => {
      renderMeasurements({ initial: withMeasurements([bp('a', '2026-10-31', 120, 80)]) });
      expect(screen.getByText('資料不足 2 筆，無法繪製趨勢圖。')).toBeTruthy();
      expect(screen.queryByRole('img', { name: '血壓趨勢圖' })).toBeNull();
      expect(screen.queryByTestId('trend-chart')).toBeNull();
    });

    it('2 筆以上時顯示有描述的趨勢圖，資料點依時間先後排列', () => {
      renderMeasurements({
        initial: withMeasurements([bp('b', '2026-10-31', 130, 85), bp('a', '2026-10-29', 120, 80)]),
      });
      expect(screen.getByRole('img', { name: '血壓趨勢圖' })).toBeTruthy();
      expect(screen.queryByText('資料不足 2 筆，無法繪製趨勢圖。')).toBeNull();
      expect(chartValues()).toEqual([120, 130]);
      expect(screen.getByText('共 2 筆')).toBeTruthy();
    });

    it('切換類型後，表單、趨勢圖與清單都只顯示該類型', () => {
      renderMeasurements({
        initial: withMeasurements([
          bp('b1', daysAgo(1), 120, 80),
          bp('b2', daysAgo(0), 122, 82),
          glucose('g1', daysAgo(1), 90, 'fasting'),
          glucose('g2', daysAgo(0), 100, 'random'),
          weight('w1', daysAgo(1), 60),
          weight('w2', daysAgo(0), 61),
        ]),
      });
      expect(screen.getByRole('img', { name: '血壓趨勢圖' })).toBeTruthy();
      expect(recordRows('血壓紀錄')).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: '血糖' }));
      expect(screen.getByRole('button', { name: '血糖' }).getAttribute('aria-pressed')).toBe('true');
      expect(screen.getByRole('button', { name: '血壓' }).getAttribute('aria-pressed')).toBe('false');
      expect(screen.getByRole('form', { name: '新增血糖紀錄' })).toBeTruthy();
      expect(screen.getByRole('img', { name: '血糖趨勢圖' })).toBeTruthy();
      expect(recordRows('血糖紀錄')).toHaveLength(2);
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();

      fireEvent.click(screen.getByRole('button', { name: '體重' }));
      expect(screen.getByRole('form', { name: '新增體重紀錄' })).toBeTruthy();
      expect(screen.getByRole('img', { name: '體重趨勢圖' })).toBeTruthy();
      expect(recordRows('體重紀錄')).toHaveLength(2);
      expect(screen.queryByRole('list', { name: '血糖紀錄' })).toBeNull();
    });

    it('圖表範圍只影響圖表，摘要仍以全部資料計算', () => {
      renderMeasurements({
        initial: withMeasurements([
          bp('a', daysAgo(400), 150, 95),
          bp('b', daysAgo(200), 140, 90),
          bp('c', daysAgo(60), 130, 85),
          bp('d', daysAgo(0), 120, 80),
        ]),
      });
      const range = screen.getByRole('combobox', { name: '圖表範圍' }) as HTMLSelectElement;
      expect(range.value).toBe('all');
      expect(within(range).getAllByRole('option').map(option => option.textContent)).toEqual([
        '近 30 天',
        '近 90 天',
        '近 1 年',
        '全部',
      ]);
      expect(chartValues()).toEqual([150, 140, 130, 120]);

      fireEvent.change(range, { target: { value: '365' } });
      expect(chartValues()).toEqual([140, 130, 120]);
      fireEvent.change(range, { target: { value: '90' } });
      expect(chartValues()).toEqual([130, 120]);
      fireEvent.change(range, { target: { value: '30' } });
      expect(screen.queryByTestId('trend-chart')).toBeNull();
      expect(screen.getByText('資料不足 2 筆，無法繪製趨勢圖。')).toBeTruthy();

      expect(within(summaryCell('總筆數')).getByText('4')).toBeTruthy();
      expect(recordRows('血壓紀錄')).toHaveLength(4);
    });
  });

  describe('紀錄清單', () => {
    it('依日期與時間由新到舊排列，未填時間者排在同日最後', () => {
      renderMeasurements({
        initial: withMeasurements([
          bp('a', '2026-10-29', 120, 80),
          bp('b', '2026-10-31', 125, 82),
          bp('c', '2026-10-31', 128, 84, { time: '08:00' }),
          bp('d', '2026-10-30', 122, 81),
        ]),
      });
      const moments = recordRows('血壓紀錄').map(row => row.firstElementChild?.textContent);
      expect(moments).toEqual(['2026-10-31 08:00', '2026-10-31', '2026-10-30', '2026-10-29']);
    });

    it('每列顯示脈搏、血糖情境與備註', () => {
      renderMeasurements({
        initial: withMeasurements([
          bp('a', '2026-10-31', 125, 80, { pulse: 66, note: '運動後' }),
          glucose('g', '2026-10-31', 101, 'postMeal', { note: '午餐後兩小時' }),
        ]),
      });
      const bpRow = onlyRow('血壓紀錄');
      expect(within(bpRow).getByText('66')).toBeTruthy();
      expect(within(bpRow).getByText('運動後')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '血糖' }));
      const glucoseRow = onlyRow('血糖紀錄');
      expect(within(glucoseRow).getByText('餐後')).toBeTruthy();
      expect(within(glucoseRow).getByText('午餐後兩小時')).toBeTruthy();
    });

    it('一次顯示 30 筆，按「顯示更多」每次再多 30 筆', () => {
      const records = Array.from({ length: 65 }, (_, index) => bp(`r${index}`, daysAgo(index), 120, 80));
      renderMeasurements({ initial: withMeasurements(records) });
      expect(recordRows('血壓紀錄')).toHaveLength(30);
      expect(screen.getByText('顯示 30 / 共 65 筆')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '顯示更多' }));
      expect(recordRows('血壓紀錄')).toHaveLength(60);
      expect(screen.getByText('顯示 60 / 共 65 筆')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: '顯示更多' }));
      expect(recordRows('血壓紀錄')).toHaveLength(65);
      expect(screen.queryByRole('button', { name: '顯示更多' })).toBeNull();
    });

    it('剛好 30 筆時不顯示「顯示更多」', () => {
      const records = Array.from({ length: 30 }, (_, index) => bp(`r${index}`, daysAgo(index), 120, 80));
      renderMeasurements({ initial: withMeasurements(records) });
      expect(recordRows('血壓紀錄')).toHaveLength(30);
      expect(screen.queryByRole('button', { name: '顯示更多' })).toBeNull();
    });

    it('兩段式刪除：取消不會刪除，確認才刪除', async () => {
      renderMeasurements({
        initial: withMeasurements([bp('a', '2026-10-30', 120, 80), bp('b', '2026-10-31', 130, 85)]),
      });
      const deleteButton = () => screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' });

      fireEvent.click(deleteButton());
      expect(screen.getByText('確定刪除？')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      expect(screen.queryByText('確定刪除？')).toBeNull();
      expect(recordRows('血壓紀錄')).toHaveLength(2);

      fireEvent.click(deleteButton());
      fireEvent.click(screen.getByRole('button', { name: '確認' }));
      await waitFor(() => expect(recordRows('血壓紀錄')).toHaveLength(1));
      expect(screen.queryByText('130/85')).toBeNull();
      expect(screen.queryByText('確定刪除？')).toBeNull();
    });

    it('刪除失敗時維持確認狀態且紀錄仍在', async () => {
      const onUpdate = vi.fn();
      renderMeasurements({ fail: true, onUpdate, initial: withMeasurements([bp('a', '2026-10-31', 120, 80)]) });
      fireEvent.click(screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' }));
      fireEvent.click(screen.getByRole('button', { name: '確認' }));
      await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
      expect(screen.getByText('確定刪除？')).toBeTruthy();
      expect(recordRows('血壓紀錄')).toHaveLength(1);
    });

    it('刪除最後一筆後回到空狀態', async () => {
      renderMeasurements({ initial: withMeasurements([bp('a', '2026-10-31', 120, 80)]) });
      fireEvent.click(screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' }));
      fireEvent.click(screen.getByRole('button', { name: '確認' }));
      await screen.findByText('尚無血壓紀錄，請使用上方表單新增第一筆。');
      expect(screen.queryByRole('list', { name: '血壓紀錄' })).toBeNull();
    });

    it('刪除時以最新資料為基準，只移除指定的紀錄', async () => {
      const target = bp('target', '2026-10-31', 120, 80);
      const remote = weight('remote', '2026-10-01', 60);
      const written = renderWithLatest(withMeasurements([target]), withMeasurements([target, remote]));
      fireEvent.click(screen.getByRole('button', { name: '刪除 2026-10-31 的血壓紀錄' }));
      fireEvent.click(screen.getByRole('button', { name: '確認' }));
      await waitFor(() => expect(written).toHaveLength(1));
      expect(written[0]?.measurements.map(item => item.id)).toEqual(['remote']);
    });
  });
});
