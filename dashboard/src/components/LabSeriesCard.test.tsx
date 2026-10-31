import { useState, type PropsWithChildren, type ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabResult } from '../parsers/types';
import { buildLabSeries, type LabSeries } from '../lib/clinicalLabSeries';
import { clinicalDate } from '../lib/clinicalRecords';
import type { MedicationOverlay } from '../lib/medicationMarkers';
import { PersonalContext, type PersonalContextValue } from '../personalContext';
import { emptyPersonal, type LabTarget, type PersonalData } from '../personalData';
import LabSeriesCard from './LabSeriesCard';

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

const AMBER = '#d97706';
const GREEN = '#059669';

const reading = (overrides: Partial<LabResult> = {}): LabResult => ({
  date: new Date('2025-01-01'), hospital: '甲醫院', testGroup: '生化', subItem: '血糖', value: 100,
  refLow: 70, refHigh: 110, code: 'loinc|2345-7', unit: 'mg/dL', source: 'FHIR', ...overrides,
});

const GLUCOSE = [
  reading({ date: new Date('2025-01-01'), value: 80 }),
  reading({ date: new Date('2025-02-01'), value: 95 }),
  reading({ date: new Date('2025-03-01'), value: 100 }),
];

const seriesOf = (readings: LabResult[] = GLUCOSE): LabSeries => buildLabSeries(readings)[0];

const withTargets = (targets: Record<string, LabTarget>): PersonalData => ({ ...emptyPersonal(), targets });

function valueOf(overrides: Partial<PersonalContextValue> = {}): PersonalContextValue {
  return {
    personal: emptyPersonal(), canEdit: true, saving: false, error: null, clearError: () => {},
    update: async () => true, ...overrides,
  };
}

const renderCard = (series: LabSeries, overrides: Partial<PersonalContextValue> = {}) =>
  render(
    <PersonalContext.Provider value={valueOf(overrides)}>
      <LabSeriesCard series={series} />
    </PersonalContext.Provider>,
  );

function Harness({ initial = emptyPersonal(), children }: { initial?: PersonalData; children: ReactNode }) {
  const [personal, setPersonal] = useState(initial);
  const value: PersonalContextValue = {
    personal, canEdit: true, saving: false, error: null, clearError: () => {},
    update: async mutator => {
      setPersonal(current => mutator(current));
      return true;
    },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

const linesOf = (stroke: string) =>
  screen.queryAllByTestId('reference-line').filter(line => line.getAttribute('data-stroke') === stroke);
const yValues = (lines: HTMLElement[]) => lines.map(line => line.getAttribute('data-y'));
const targetText = () => screen.getByText(/個人目標：/).textContent;

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const enter = (label: string, value: string) => { fireEvent.change(field(label), { target: { value } }); };
const click = async (element: HTMLElement) => { await act(async () => { fireEvent.click(element); }); };
const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const submitForm = async () => {
  await act(async () => { fireEvent.submit(screen.getByRole('form', { name: '血糖 個人目標' })); });
};

describe('LabSeriesCard', () => {
  describe('未設定個人目標', () => {
    it('不畫橘色目標線也不顯示目標說明，檢驗室參考帶與參考線維持不變', () => {
      renderCard(seriesOf());
      expect(linesOf(AMBER)).toHaveLength(0);
      expect(screen.queryByText(/個人目標：/)).toBeNull();
      expect(linesOf(GREEN)).toHaveLength(2);
      expect(screen.getAllByTestId('reference-band')).toHaveLength(1);
    });

    it('沒有 provider（預設唯讀）時照常顯示，且沒有任何編輯入口', () => {
      render(<LabSeriesCard series={seriesOf()} />);
      expect(screen.getByRole('article')).toBeTruthy();
      expect(screen.queryByRole('button', { name: /個人目標/ })).toBeNull();
      expect(linesOf(AMBER)).toHaveLength(0);
    });

    it('其他系列（不同院所）的目標不會套用到這張卡片', () => {
      const hospitalA = seriesOf();
      const hospitalB = seriesOf(GLUCOSE.map(item => ({ ...item, hospital: '乙醫院' })));
      expect(hospitalA.key).not.toBe(hospitalB.key);
      const personal = withTargets({ [hospitalA.key]: { high: 90 } });

      const { unmount } = renderCard(hospitalB, { personal });
      expect(linesOf(AMBER)).toHaveLength(0);
      expect(screen.queryByText(/個人目標：/)).toBeNull();
      unmount();

      renderCard(hospitalA, { personal });
      expect(yValues(linesOf(AMBER))).toEqual(['90']);
    });
  });

  describe('已設定個人目標', () => {
    it('只有上限：畫一條橘色虛線並可延伸座標軸，說明文字含超出筆數', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      const lines = linesOf(AMBER);
      expect(yValues(lines)).toEqual(['90']);
      expect(lines[0].getAttribute('data-overflow')).toBe('extendDomain');
      expect(targetText()).toBe('個人目標：≤ 90 mg/dL · 2 / 3 筆超出');
    });

    it('只有下限：畫一條橘色虛線', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { low: 90 } }) });
      expect(yValues(linesOf(AMBER))).toEqual(['90']);
      expect(targetText()).toBe('個人目標：≥ 90 mg/dL · 1 / 3 筆超出');
    });

    it('上下限皆有：畫兩條橘色虛線並以區間顯示', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { low: 85, high: 99 } }) });
      expect(yValues(linesOf(AMBER)).sort()).toEqual(['85', '99']);
      expect(targetText()).toBe('個人目標：85–99 mg/dL · 2 / 3 筆超出');
    });

    it('全部在目標內時顯示 0 筆超出', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { high: 200 } }) });
      expect(targetText()).toBe('個人目標：≤ 200 mg/dL · 0 / 3 筆超出');
    });

    it('沒有單位時不顯示單位', () => {
      const series = seriesOf(GLUCOSE.map(item => ({ ...item, unit: undefined })));
      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(targetText()).toBe('個人目標：≤ 90 · 2 / 3 筆超出');
    });

    it('橘色目標線與檢驗室參考線並存，且兩者可由顏色區分', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(linesOf(AMBER)).toHaveLength(1);
      expect(linesOf(GREEN)).toHaveLength(2);
      expect(screen.getAllByTestId('reference-band')).toHaveLength(1);
    });

    it('個人目標不會改變圖表資料', () => {
      const series = seriesOf();
      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(screen.getByTestId('numeric-chart').getAttribute('data-values')).toBe('[80,95,100]');
    });

    it('參考區間曾變更時不畫共用參考帶，但個人目標線仍會畫出', () => {
      const series = seriesOf([
        reading({ date: new Date('2025-01-01'), value: 80, refHigh: 110 }),
        reading({ date: new Date('2025-02-01'), value: 95, refHigh: 100 }),
        reading({ date: new Date('2025-03-01'), value: 100, refHigh: 100 }),
      ]);
      expect(series.consistentReference).toBe(false);
      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(screen.getByText(/參考區間曾變更/)).toBeTruthy();
      expect(screen.queryByTestId('reference-band')).toBeNull();
      expect(linesOf(GREEN)).toHaveLength(0);
      expect(yValues(linesOf(AMBER))).toEqual(['90']);
    });
  });

  describe('嵌入的目標編輯器', () => {
    it('可編輯時顯示「設定個人目標」，已有目標時改為「編輯個人目標」', () => {
      const series = seriesOf();
      const { unmount } = renderCard(series);
      expect(button('設定個人目標：血糖').getAttribute('aria-expanded')).toBe('false');
      unmount();

      renderCard(series, { personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(button('編輯個人目標：血糖')).toBeTruthy();
      expect(screen.queryByRole('button', { name: '設定個人目標：血糖' })).toBeNull();
    });

    it('唯讀時不顯示編輯入口，但已存在的目標仍會畫出', () => {
      const series = seriesOf();
      renderCard(series, { canEdit: false, personal: withTargets({ [series.key]: { high: 90 } }) });
      expect(screen.queryByRole('button', { name: /個人目標/ })).toBeNull();
      expect(yValues(linesOf(AMBER))).toEqual(['90']);
      expect(targetText()).toBe('個人目標：≤ 90 mg/dL · 2 / 3 筆超出');
    });

    it('展開前不出現提示與表單，避免每張卡片都多出狀態訊息', () => {
      renderCard(seriesOf());
      expect(screen.queryByRole('form')).toBeNull();
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('儲存後立即在卡片上畫出目標線與說明', async () => {
      render(<Harness><LabSeriesCard series={seriesOf()} /></Harness>);
      expect(linesOf(AMBER)).toHaveLength(0);

      await click(button('設定個人目標：血糖'));
      enter('上限（≤）', '90');
      await submitForm();

      expect(yValues(linesOf(AMBER))).toEqual(['90']);
      expect(targetText()).toBe('個人目標：≤ 90 mg/dL · 2 / 3 筆超出');
      expect(screen.queryByRole('form')).toBeNull();
      expect(button('編輯個人目標：血糖')).toBeTruthy();
    });

    it('清除目標後移除目標線與說明', async () => {
      const series = seriesOf();
      render(<Harness initial={withTargets({ [series.key]: { high: 90 } })}><LabSeriesCard series={series} /></Harness>);
      expect(linesOf(AMBER)).toHaveLength(1);

      await click(button('編輯個人目標：血糖'));
      await click(button('清除目標'));

      expect(linesOf(AMBER)).toHaveLength(0);
      expect(screen.queryByText(/個人目標：/)).toBeNull();
      expect(button('設定個人目標：血糖')).toBeTruthy();
    });

    it('儲存失敗時不畫出目標線，表單保持開啟', async () => {
      renderCard(seriesOf(), { update: async () => false });

      await click(button('設定個人目標：血糖'));
      enter('上限（≤）', '90');
      await submitForm();

      expect(screen.getByRole('form', { name: '血糖 個人目標' })).toBeTruthy();
      expect(linesOf(AMBER)).toHaveLength(0);
      expect(screen.queryByText(/個人目標：/)).toBeNull();
    });
  });

  describe('既有行為', () => {
    it('卡片與釘選按鈕的名稱維持不變', () => {
      renderCard(seriesOf());
      expect(screen.getByRole('article', { name: '血糖（mg/dL · 甲醫院 · FHIR · loinc|2345-7）' })).toBeTruthy();
      const pin = button('釘選 血糖（mg/dL · 甲醫院 · FHIR）');
      expect(pin.getAttribute('aria-pressed')).toBe('false');
    });

    it('按下釘選會以系列識別碼呼叫 toggleLabPin', () => {
      const series = seriesOf();
      renderCard(series);
      fireEvent.click(button('釘選 血糖（mg/dL · 甲醫院 · FHIR）'));
      expect(store.toggleLabPin).toHaveBeenCalledTimes(1);
      expect(store.toggleLabPin).toHaveBeenCalledWith(series.key);
    });

    it('已釘選時按鈕顯示取消釘選且 aria-pressed 為 true', () => {
      const series = seriesOf();
      store.preferences.pinnedLabItems = [series.key];
      renderCard(series);
      expect(button('取消釘選 血糖（mg/dL · 甲醫院 · FHIR）').getAttribute('aria-pressed')).toBe('true');
    });

    it('標題顯示超出參考區間的次數，全部正常時不顯示', () => {
      const { unmount } = renderCard(seriesOf());
      expect(screen.queryByText(/次超出參考/)).toBeNull();
      unmount();

      renderCard(seriesOf([...GLUCOSE, reading({ date: new Date('2025-04-01'), value: 120 })]));
      expect(screen.getByText('1 次超出參考')).toBeTruthy();
    });

    it('逐筆檢驗數值的筆數與圖表資料一致', () => {
      renderCard(seriesOf());
      expect(screen.getByText('逐筆檢驗數值（3 筆）')).toBeTruthy();
      expect(screen.getByTestId('numeric-chart').getAttribute('data-values')).toBe('[80,95,100]');
    });
  });

  describe('用藥時間點', () => {
    const BLUE = '#3b82f6';
    const LOCAL_GLUCOSE = [
      reading({ date: new Date(2025, 0, 1), value: 80 }),
      reading({ date: new Date(2025, 1, 1), value: 95 }),
      reading({ date: new Date(2025, 2, 1), value: 100 }),
    ];
    const JAN = clinicalDate(new Date(2025, 0, 1));
    const FEB = clinicalDate(new Date(2025, 1, 1));
    const MAR = clinicalDate(new Date(2025, 2, 1));

    const overlayOf = (...days: string[]): MedicationOverlay => ({ name: 'Metformin', days });
    const xValues = (lines: HTMLElement[]) => lines.map(line => line.getAttribute('data-x'));
    const note = () => screen.queryByText(/^用藥時間點：/);

    function renderWithOverlay(
      overlay?: MedicationOverlay,
      overrides: Partial<PersonalContextValue> = {},
      readings: LabResult[] = LOCAL_GLUCOSE,
    ) {
      return render(
        <PersonalContext.Provider value={valueOf(overrides)}>
          <LabSeriesCard series={seriesOf(readings)} overlay={overlay} />
        </PersonalContext.Provider>,
      );
    }

    it('未傳入 overlay 時不畫標記也不顯示說明', () => {
      renderWithOverlay();
      expect(linesOf(BLUE)).toHaveLength(0);
      expect(note()).toBeNull();
    });

    it('在處方日之後的第一次檢驗畫一條藍色標記線，並說明標記方式', () => {
      renderWithOverlay(overlayOf('2025-01-20'));
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
      expect(note()?.textContent).toBe(
        '用藥時間點：Metformin · 期間內 1 次處方（2025-01-20），藍色虛線標在處方後的第一次檢驗',
      );
    });

    it('處方日當天剛好有檢驗時標在當天，不順延', () => {
      renderWithOverlay(overlayOf('2025-02-01'));
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
    });

    it('多次處方對應同一次檢驗時只畫一條線，說明列出處方日期範圍', () => {
      renderWithOverlay(overlayOf('2025-01-25', '2025-01-20'));
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
      expect(note()?.textContent).toContain('期間內 2 次處方（2025-01-20 至 2025-01-25）');
    });

    it('處方對應不同檢驗時依處方日順序畫出多條線', () => {
      renderWithOverlay(overlayOf('2025-01-01', '2025-02-15'));
      expect(xValues(linesOf(BLUE))).toEqual([JAN, MAR]);
      expect(note()?.textContent).toContain('期間內 2 次處方（2025-01-01 至 2025-02-15）');
    });

    it('同一天有多筆檢驗時仍只畫一條線', () => {
      renderWithOverlay(overlayOf('2025-01-20'), {}, [
        ...LOCAL_GLUCOSE,
        reading({ date: new Date(2025, 1, 1), value: 97 }),
      ]);
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
    });

    it('日期無法辨識的檢驗不會被當成標記位置', () => {
      renderWithOverlay(overlayOf('2025-01-20'), {}, [
        reading({ date: new Date(NaN), value: 70 }),
        ...LOCAL_GLUCOSE,
      ]);
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
    });

    it('檢驗期間之外的處方不畫線，只在說明中計數', () => {
      renderWithOverlay(overlayOf('2024-06-01'));
      expect(linesOf(BLUE)).toHaveLength(0);
      expect(note()?.textContent).toBe(
        '用藥時間點：Metformin · 此系列的檢驗期間內沒有處方；另有 1 次處方在此系列的檢驗期間之外',
      );
    });

    it('最後一次檢驗之後的處方算期間之外，最後一次檢驗當天則算期間內', () => {
      const { unmount } = renderWithOverlay(overlayOf('2025-03-02'));
      expect(linesOf(BLUE)).toHaveLength(0);
      expect(note()?.textContent).toContain('另有 1 次處方在此系列的檢驗期間之外');
      unmount();

      renderWithOverlay(overlayOf('2025-03-01'));
      expect(xValues(linesOf(BLUE))).toEqual([MAR]);
    });

    it('部分處方在檢驗期間之外時，期間內的畫線並同時說明期間外的次數', () => {
      renderWithOverlay(overlayOf('2024-06-01', '2025-01-20'));
      expect(xValues(linesOf(BLUE))).toEqual([FEB]);
      expect(note()?.textContent).toBe(
        '用藥時間點：Metformin · 期間內 1 次處方（2025-01-20），藍色虛線標在處方後的第一次檢驗；另有 1 次處方在此系列的檢驗期間之外',
      );
    });

    it('沒有任何處方時只說明檢驗期間內沒有處方', () => {
      renderWithOverlay(overlayOf());
      expect(linesOf(BLUE)).toHaveLength(0);
      expect(note()?.textContent).toBe('用藥時間點：Metformin · 此系列的檢驗期間內沒有處方');
    });

    it('不改變卡片名稱與釘選按鈕', () => {
      renderWithOverlay(overlayOf('2025-01-20'));
      expect(screen.getByRole('article', { name: '血糖（mg/dL · 甲醫院 · FHIR · loinc|2345-7）' })).toBeTruthy();
      expect(button('釘選 血糖（mg/dL · 甲醫院 · FHIR）')).toBeTruthy();
    });

    it('與個人目標線並存，互不影響', () => {
      const personal = withTargets({ [seriesOf(LOCAL_GLUCOSE).key]: { low: 85, high: 99 } });
      const { unmount } = renderWithOverlay(undefined, { personal });
      const amber = linesOf(AMBER).length;
      const green = linesOf(GREEN).length;
      expect(amber).toBe(2);
      unmount();

      renderWithOverlay(overlayOf('2025-01-20'), { personal });
      expect(linesOf(AMBER)).toHaveLength(amber);
      expect(linesOf(GREEN)).toHaveLength(green);
      expect(linesOf(BLUE)).toHaveLength(1);
    });
  });
});
