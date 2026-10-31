import type { PropsWithChildren } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LabResult, NHIData, TextLabResult } from '../parsers/types';
import { labSeriesKey } from '../lib/clinicalLabSeries';
import LabTrendCharts from './LabTrendCharts';
import KeySummary from './KeySummary';

const store = vi.hoisted(() => ({
  preferences: { pinnedLabItems: [] as string[], pinnedMedications: [] as string[] },
  toggleLabPin: vi.fn(), toggleMedicationPin: vi.fn(), isMedicationPinned: vi.fn(() => false),
  isAlertAcknowledged: vi.fn(() => false), acknowledgeAlert: vi.fn(),
}));
vi.mock('../UserStore', () => ({ useUserStore: () => store }));
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: PropsWithChildren) => <div>{children}</div>,
  LineChart: ({ children, data }: PropsWithChildren<{ data: { value: number }[] }>) => <div data-testid="numeric-chart" data-values={JSON.stringify(data.map(point => point.value))}>{children}</div>,
  ReferenceArea: () => <span data-testid="reference-band" />,
  ReferenceLine: () => <span data-testid="reference-line" />,
  CartesianGrid: () => null, Line: () => null, XAxis: () => null, YAxis: () => null, Tooltip: () => null,
}));

const reading = (overrides: Partial<LabResult> = {}): LabResult => ({
  date: new Date('2025-01-01'), hospital: '甲醫院', testGroup: '生化', subItem: '血糖', value: 100,
  refLow: 70, refHigh: 110, code: 'loinc|2345-7', unit: 'mg/dL', source: 'FHIR', ...overrides,
});
const textReading = (overrides: Partial<TextLabResult> = {}): TextLabResult => ({
  date: null, hospital: '乙醫院', testGroup: '病毒學', subItem: '病毒抗體', text: '陽性 / Positive',
  refText: '陰性', source: 'FHIR text source', origins: [{ format: 'FHIR', resourceType: 'Observation', id: 'text-1', source: 'export-a' }], ...overrides,
});
const data = (labResults: LabResult[]): NHIData => ({
  labResults, visits: [], hospitalizations: [], vaccinations: [], checkupReports: [], dentalVisits: [],
  medicalReports: [], medications: [], textLabResults: [], importHistory: [], duplicateCandidateCount: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.preferences.pinnedLabItems = [];
  store.preferences.pinnedMedications = [];
});
afterEach(cleanup);

describe('LabTrendCharts clinical presentation', () => {
  it('shows singleton numeric series by default and never joins different units, sources, hospitals, or codes', () => {
    render(<LabTrendCharts labResults={[
      reading(), reading({ unit: 'mmol/L', value: 5.5 }), reading({ source: 'NHI', value: 200 }),
      reading({ hospital: '乙醫院', value: 300 }), reading({ code: 'local|glucose', value: 400 }),
    ]} />);
    expect(screen.getByRole<HTMLInputElement>('checkbox').checked).toBe(true);
    expect(screen.getAllByRole('article')).toHaveLength(5);
    expect(screen.getAllByTestId('numeric-chart').map(chart => chart.getAttribute('data-values')).sort())
      .toEqual(['[100]', '[200]', '[300]', '[400]', '[5.5]']);
    expect(screen.getAllByRole('table')).toHaveLength(5);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('retains comparator, qualitative, unknown-date, reference, and origin text outside numeric charts', () => {
    render(<LabTrendCharts labResults={[reading()]} textLabResults={[
      textReading(), textReading({ subItem: '低於定量值', text: '<5', unit: 'IU/mL', refText: '未檢出' }),
    ]} />);
    const table = screen.getByRole('table', { name: '文字與定性檢驗逐筆紀錄' });
    expect(within(table).getByText('陽性 / Positive')).toBeTruthy();
    expect(within(table).getByText('<5')).toBeTruthy();
    expect(within(table).getAllByText('日期未提供')).toHaveLength(2);
    expect(within(table).getByText('IU/mL')).toBeTruthy();
    expect(within(table).getByText('未檢出')).toBeTruthy();
    expect(within(table).getAllByText(/Observation\/text-1/)).toHaveLength(2);
    expect(screen.getByTestId('numeric-chart').getAttribute('data-values')).toBe('[100]');
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('table', { name: '文字與定性檢驗逐筆紀錄' })).toBeTruthy();
  });

  it('searches sources and text and offers classification filters for text-only data', () => {
    render(<LabTrendCharts labResults={[]} textLabResults={[textReading(), textReading({ testGroup: '生化', subItem: '比較結果', text: '>=10' })]} />);
    fireEvent.click(screen.getByRole('button', { name: '病毒學' }));
    expect(screen.getByText('陽性 / Positive')).toBeTruthy();
    expect(screen.queryByText('>=10')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '清除篩選' }));
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋檢驗結果' }), { target: { value: '>=10' } });
    expect(screen.getByText('>=10')).toBeTruthy();
    expect(screen.queryByText('陽性 / Positive')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋檢驗結果' }), { target: { value: 'export-a' } });
    expect(screen.getByText('陽性 / Positive')).toBeTruthy();
  });

  it('omits shared reference bands after range changes and exposes each reading range and source', () => {
    render(<LabTrendCharts labResults={[reading({ refLow: 10, refHigh: 20 }), reading({ date: new Date('2025-02-01'), refLow: 30, refHigh: 40 })]} />);
    expect(screen.queryByTestId('reference-band')).toBeNull();
    expect(screen.queryByTestId('reference-line')).toBeNull();
    expect(screen.getByText(/參考區間曾變更/)).toBeTruthy();
    fireEvent.click(screen.getByText('逐筆檢驗數值（2 筆）'));
    const table = screen.getByRole('table');
    expect(within(table).getByText('10–20')).toBeTruthy();
    expect(within(table).getByText('30–40')).toBeTruthy();
    expect(within(table).getAllByText('甲醫院 · FHIR')).toHaveLength(2);
  });

  it('pins new series independently while showing legacy name pins as selected', () => {
    const first = reading();
    const second = reading({ source: 'NHI' });
    const { rerender } = render(<LabTrendCharts labResults={[first, second]} />);
    fireEvent.click(screen.getByRole('button', { name: '釘選 血糖（mg/dL · 甲醫院 · FHIR）' }));
    expect(store.toggleLabPin).toHaveBeenCalledExactlyOnceWith(labSeriesKey(first));
    store.preferences.pinnedLabItems = ['血糖'];
    rerender(<LabTrendCharts labResults={[first, second]} />);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(2);
  });
});

describe('KeySummary separated lab series', () => {
  it('renders each legacy-pinned unit/source as its own current-value and trend card', () => {
    store.preferences.pinnedLabItems = ['血糖'];
    render(<KeySummary data={data([
      reading({ value: 90 }), reading({ date: new Date('2025-02-01'), value: 100 }),
      reading({ unit: 'mmol/L', value: 5, refLow: 3, refHigh: 6 }),
      reading({ unit: 'mmol/L', value: 5.5, refLow: 3, refHigh: 6, date: new Date('2025-02-01') }),
      reading({ source: 'NHI', value: 80 }),
    ])} />);
    expect(screen.getAllByRole('article')).toHaveLength(3);
    const mg = screen.getByRole('article', { name: /mg\/dL · 甲醫院 · FHIR/ });
    expect(within(mg).getByText('100')).toBeTruthy();
    expect(within(mg).getByText('▲ 10')).toBeTruthy();
    const mmol = screen.getByRole('article', { name: /mmol\/L/ });
    expect(within(mmol).getByText('5.50')).toBeTruthy();
    expect(within(mmol).getByText('▲ 0.50')).toBeTruthy();
    const nhi = screen.getByRole('article', { name: /NHI/ });
    expect(within(nhi).getByText('首次紀錄')).toBeTruthy();
    expect(within(nhi).getByText('80')).toBeTruthy();
  });

  it('uses the latest reading range rather than an obsolete reference and offers source-specific picker entries', () => {
    store.preferences.pinnedLabItems = ['血糖'];
    render(<KeySummary data={data([reading(), reading({ refLow: null, refHigh: null, value: 200, date: new Date('2025-02-01') }), reading({ source: 'NHI' })])} />);
    const card = screen.getByRole('article', { name: /FHIR/ });
    expect(within(card).getByText('無參考值')).toBeTruthy();
    expect(within(card).getByText('本次參考 未提供')).toBeTruthy();
    expect(within(card).queryByText('變差')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '編輯追蹤項目' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('button', { pressed: true })).toHaveLength(2);
    expect(within(dialog).getByText(/mg\/dL · 甲醫院 · NHI/)).toBeTruthy();
  });
});
