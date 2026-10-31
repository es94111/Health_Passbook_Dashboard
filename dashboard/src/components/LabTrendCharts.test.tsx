import type { PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabResult, Visit } from '../parsers/types';
import { clinicalDate } from '../lib/clinicalRecords';
import LabTrendCharts from './LabTrendCharts';

const store = vi.hoisted(() => ({
  preferences: { pinnedLabItems: [] as string[], pinnedMedications: [] as string[] },
  toggleLabPin: vi.fn(),
}));

vi.mock('../UserStore', () => ({ useUserStore: () => store }));

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  LineChart: ({ children, data }: PropsWithChildren<{ data: { value: number }[] }>) => (
    <div data-testid="numeric-chart" data-values={JSON.stringify(data.map(point => point.value))}>{children}</div>
  ),
  ReferenceArea: () => <span data-testid="reference-band" />,
  ReferenceLine: ({ stroke, y, x, ifOverflow }: { stroke?: string; y?: number; x?: string; ifOverflow?: string }) => (
    <span data-testid="reference-line" data-stroke={stroke} data-y={y} data-x={x} data-overflow={ifOverflow} />
  ),
  CartesianGrid: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
}));

beforeEach(() => {
  vi.clearAllMocks();
  store.preferences.pinnedLabItems = [];
});

afterEach(cleanup);

const BLUE = '#3b82f6';

const at = (month: number, day: number, year = 2025): Date => new Date(year, month - 1, day);

const reading = (overrides: Partial<LabResult> = {}): LabResult => ({
  date: at(1, 1), hospital: '甲醫院', testGroup: '生化', subItem: '血糖', value: 100,
  refLow: 70, refHigh: 110, code: 'loinc|2345-7', unit: 'mg/dL', source: 'FHIR', ...overrides,
});

// 兩個系列的檢驗日期錯開，才能分辨標記是依各系列自己的期間計算。
const GLUCOSE = [at(1, 1), at(2, 1), at(3, 1)].map((date, index) => reading({ date, value: 90 + index }));
const CREATININE = [at(1, 10), at(2, 10), at(3, 10)].map((date, index) =>
  reading({ date, subItem: '肌酸酐', code: 'loinc|2160-0', value: [0.8, 0.9, 1][index], refLow: 0.6, refHigh: 1.2 }));
const LABS = [...GLUCOSE, ...CREATININE];

const visit = (date: Date, codes: string[] = ['AB123']): Visit => ({
  date, hospital: '甲醫院', diagnoses: [],
  procedures: codes.map(code => ({ code, name: `藥品${code}`, qty: 1 })),
});

const renderCharts = (visits?: Visit[]) => render(<LabTrendCharts labResults={LABS} visits={visits} />);

const blueLinesIn = (root: HTMLElement): string[] =>
  within(root).queryAllByTestId('reference-line')
    .filter(line => line.getAttribute('data-stroke') === BLUE)
    .map(line => line.getAttribute('data-x') ?? '');

const allBlueLines = (): string[] => blueLinesIn(document.body);
const card = (name: RegExp): HTMLElement => screen.getByRole('article', { name });
const noteOf = (name: RegExp): string => within(card(name)).getByText(/用藥時間點：/).textContent ?? '';
const notes = (): HTMLElement[] => screen.queryAllByText(/用藥時間點：/);
const overlaySelect = (): HTMLSelectElement => screen.getByLabelText('疊加用藥時間點') as HTMLSelectElement;
const choose = (value: string): void => { fireEvent.change(overlaySelect(), { target: { value } }); };

describe('LabTrendCharts 用藥時間點疊加', () => {
  it('沒有就診資料時不顯示疊加選單', () => {
    renderCharts();

    expect(screen.queryByLabelText('疊加用藥時間點')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(2);
    expect(allBlueLines()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it('就診紀錄中沒有藥品代碼時不顯示疊加選單', () => {
    renderCharts([visit(at(1, 20), ['01001C'])]);

    expect(screen.queryByLabelText('疊加用藥時間點')).toBeNull();
  });

  it('列出有處方的藥品與處方次數，預設不疊加', () => {
    renderCharts([visit(at(1, 20), ['AB123']), visit(at(3, 5), ['AB123', 'CD456'])]);

    const select = overlaySelect();
    expect(Array.from(select.options).map(option => option.textContent)).toEqual([
      '不疊加', '藥品AB123（2 次）', '藥品CD456（1 次）',
    ]);
    expect(select.value).toBe('');
    expect(allBlueLines()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it('選擇藥品後，每張圖卡把標記放在處方後的第一次檢驗', () => {
    renderCharts([visit(at(1, 20))]);

    choose('AB123');

    expect(blueLinesIn(card(/血糖/))).toEqual([clinicalDate(at(2, 1))]);
    expect(blueLinesIn(card(/肌酸酐/))).toEqual([clinicalDate(at(2, 10))]);
  });

  it('每張圖卡都有說明文字，寫明藥名、處方日期與次數', () => {
    renderCharts([visit(at(1, 20))]);

    choose('AB123');

    expect(notes()).toHaveLength(2);
    const expected = '用藥時間點：藥品AB123 · 期間內 1 次處方（2025-01-20），藍色虛線標在處方後的第一次檢驗';
    expect(noteOf(/血糖/)).toBe(expected);
    expect(noteOf(/肌酸酐/)).toBe(expected);
  });

  it('切回「不疊加」後移除標記與說明', () => {
    renderCharts([visit(at(1, 20))]);
    choose('AB123');
    expect(allBlueLines()).toHaveLength(2);

    choose('');

    expect(allBlueLines()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
    expect(overlaySelect().value).toBe('');
  });

  it('處方全在檢驗期間之外時不畫線，但說明文字仍交代', () => {
    renderCharts([visit(at(6, 1, 2024))]);

    choose('AB123');

    expect(allBlueLines()).toHaveLength(0);
    for (const name of [/血糖/, /肌酸酐/]) {
      const note = noteOf(name);
      expect(note).toContain('此系列的檢驗期間內沒有處方');
      expect(note).toContain('另有 1 次處方在此系列的檢驗期間之外');
    }
  });

  it('各系列依自己的檢驗期間，分別計算期間內與期間外的處方', () => {
    renderCharts([visit(at(1, 5))]);

    choose('AB123');

    const glucose = noteOf(/血糖/);
    expect(glucose).toContain('期間內 1 次處方（2025-01-05）');
    expect(glucose).not.toContain('另有');
    expect(blueLinesIn(card(/血糖/))).toEqual([clinicalDate(at(2, 1))]);

    const creatinine = noteOf(/肌酸酐/);
    expect(creatinine).toContain('此系列的檢驗期間內沒有處方');
    expect(creatinine).toContain('另有 1 次處方在此系列的檢驗期間之外');
    expect(blueLinesIn(card(/肌酸酐/))).toEqual([]);
  });

  it('搜尋篩選後，已選的疊加仍套用在留下的圖卡', () => {
    renderCharts([visit(at(1, 20))]);
    choose('AB123');

    fireEvent.change(screen.getByLabelText('搜尋檢驗結果'), { target: { value: '血糖' } });

    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(notes()).toHaveLength(1);
    expect(allBlueLines()).toEqual([clinicalDate(at(2, 1))]);
    expect(overlaySelect().value).toBe('AB123');
  });

  it('選取的藥品不再出現在就診紀錄時，選單回到「不疊加」且不畫線', () => {
    const { rerender } = renderCharts([visit(at(1, 20), ['AB123'])]);
    choose('AB123');
    expect(allBlueLines()).toHaveLength(2);

    rerender(<LabTrendCharts labResults={LABS} visits={[visit(at(1, 20), ['CD456'])]} />);

    expect(overlaySelect().value).toBe('');
    expect(allBlueLines()).toHaveLength(0);
    expect(notes()).toHaveLength(0);
  });

  it('疊加選單不增加額外的核取方塊或圖卡', () => {
    renderCharts([visit(at(1, 20))]);

    choose('AB123');

    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });
});
