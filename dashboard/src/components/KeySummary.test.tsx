import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { labSeriesKey } from '../lib/clinicalLabSeries';
import { REFILL_DISCLAIMER } from '../lib/refills';
import type { LabResult, NHIData } from '../parsers/types';
import { EMPTY_PERSONAL, PersonalContext, type PersonalContextValue } from '../personalContext';
import type { PersonalData, RefillPlan } from '../personalData';
import KeySummary from './KeySummary';

const store = vi.hoisted(() => ({
  preferences: { pinnedLabItems: [] as string[], pinnedMedications: [] as string[] },
  toggleLabPin: vi.fn(),
  toggleMedicationPin: vi.fn(),
  isMedicationPinned: vi.fn(() => false),
  isAlertAcknowledged: vi.fn(() => false),
  acknowledgeAlert: vi.fn(),
}));

vi.mock('../UserStore', () => ({ useUserStore: () => store }));

const NOW = new Date(2026, 9, 31, 12);

const lab = (name: string, daysOld: number, value: number, overrides: Partial<LabResult> = {}): LabResult => ({
  date: new Date(2026, 9, 31 - daysOld),
  hospital: '甲醫院',
  testGroup: '生化',
  subItem: name,
  value,
  refLow: 70,
  refHigh: 110,
  unit: 'mg/dL',
  code: `code-${name}`,
  source: 'FHIR',
  ...overrides,
});

const plan = (id: string, drugName: string, prescribedDate: string, overrides: Partial<RefillPlan> = {}): RefillPlan => ({
  id,
  drugName,
  prescribedDate,
  daysPerFill: 28,
  fills: 3,
  taken: 1,
  ...overrides,
});

const OPEN = plan('open-1', 'Metformin', '2026-10-10');
const OVERDUE = plan('overdue-1', 'Amlodipine', '2026-09-01', { hospital: '乙診所' });
const NOT_YET = plan('later-1', 'Statin', '2026-10-25');
const FINISHED = plan('done-1', 'Aspirin', '2026-08-01', { taken: 3 });

const data = (labResults: LabResult[]): NHIData => ({
  labResults,
  visits: [],
  hospitalizations: [],
  vaccinations: [],
  checkupReports: [],
  dentalVisits: [],
  medicalReports: [],
  medications: [],
  textLabResults: [],
  importHistory: [],
  duplicateCandidateCount: 0,
});

const value = (overrides: Partial<PersonalContextValue> = {}): PersonalContextValue => ({
  personal: EMPTY_PERSONAL,
  canEdit: true,
  saving: false,
  error: null,
  clearError: () => {},
  update: async () => true,
  ...overrides,
});

const renderSummary = (d: NHIData, personal: Partial<PersonalData> = {}) =>
  render(
    <PersonalContext.Provider value={value({ personal: { ...EMPTY_PERSONAL, ...personal } })}>
      <KeySummary data={d} now={NOW} />
    </PersonalContext.Provider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  store.preferences.pinnedLabItems = [];
  store.preferences.pinnedMedications = [];
});

afterEach(cleanup);

describe('KeySummary data freshness', () => {
  it('shows how recent the newest record is', () => {
    renderSummary(data([lab('血糖', 11, 100)]));

    expect(screen.getByText('2026-10-20').closest('p')?.textContent).toBe('資料最新到 2026-10-20（距今 11 天）');
    expect(screen.queryByText(/已超過 90 天沒有新資料/)).toBeNull();
  });

  it('warns when the newest record is more than 90 days old', () => {
    renderSummary(data([lab('血糖', 120, 100)]));

    expect(screen.getByText(/距今 120 天/)).toBeTruthy();
    expect(screen.getByText(/已超過 90 天沒有新資料/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: '建議複驗' })).toBeNull();
  });

  it('shows no freshness line when there are no records', () => {
    renderSummary(data([]));

    expect(screen.queryByText(/資料最新到/)).toBeNull();
  });
});

describe('KeySummary abnormal overview', () => {
  it('lists unpinned abnormal series and leaves pinned ones to their cards', () => {
    const glucose = lab('血糖', 5, 150);
    store.preferences.pinnedLabItems = [labSeriesKey(glucose)];
    renderSummary(
      data([
        glucose,
        lab('LDL', 5, 160, { refLow: 0, refHigh: 130 }),
        lab('肌酸酐', 5, 0.9, { refLow: 0.5, refHigh: 1.2 }),
      ]),
    );

    const overview = screen.getByRole('region', { name: '異常檢驗總覽' });
    expect(within(overview).getByText('LDL')).toBeTruthy();
    expect(within(overview).getByText('共 1 項')).toBeTruthy();
    expect(within(overview).queryByText('血糖')).toBeNull();
    expect(within(overview).queryByText('肌酸酐')).toBeNull();
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article', { name: /血糖/ })).toBeTruthy();
  });

  it('adds no extra sections when every unpinned result is in range', () => {
    renderSummary(data([lab('血糖', 5, 100), lab('肌酸酐', 5, 0.9, { refLow: 0.5, refHigh: 1.2 })]));

    expect(screen.queryByRole('region', { name: '異常檢驗總覽' })).toBeNull();
    expect(screen.queryByRole('region', { name: '建議複驗' })).toBeNull();
    expect(screen.queryByRole('region', { name: '領藥提醒' })).toBeNull();
  });

  it('lets a personal target decide which series count as abnormal', () => {
    const reading = lab('血糖', 5, 100);
    const first = renderSummary(data([reading]));
    expect(screen.queryByRole('region', { name: '異常檢驗總覽' })).toBeNull();
    first.unmount();

    renderSummary(data([reading]), { targets: { [labSeriesKey(reading)]: { high: 90 } } });

    const overview = screen.getByRole('region', { name: '異常檢驗總覽' });
    expect(within(overview).getByText('血糖')).toBeTruthy();
    expect(within(overview).getByText('偏高')).toBeTruthy();
    expect(within(overview).getByText('依個人目標')).toBeTruthy();
  });

  it('labels a pinned card with the personal target it was judged against', () => {
    const reading = lab('血糖', 5, 100);
    store.preferences.pinnedLabItems = [labSeriesKey(reading)];

    renderSummary(data([reading]), { targets: { [labSeriesKey(reading)]: { high: 90 } } });
    const withTarget = screen.getByRole('article', { name: /血糖/ });
    expect(within(withTarget).getByText('個人目標 ≤ 90')).toBeTruthy();
    expect(within(withTarget).getByText('偏高')).toBeTruthy();
    cleanup();

    renderSummary(data([reading]));
    const withoutTarget = screen.getByRole('article', { name: /血糖/ });
    expect(within(withoutTarget).getByText(/本次參考/)).toBeTruthy();
    expect(within(withoutTarget).queryByText(/個人目標/)).toBeNull();
  });
});

describe('KeySummary reminders', () => {
  it('lists due and overdue refills together with the disclaimer', () => {
    renderSummary(data([]), { refills: [OPEN, OVERDUE, NOT_YET, FINISHED] });

    const region = screen.getByRole('region', { name: '領藥提醒' });
    expect(within(region).getByText('Metformin')).toBeTruthy();
    expect(within(region).getByText('Amlodipine')).toBeTruthy();
    expect(within(region).queryByText('Statin')).toBeNull();
    expect(within(region).queryByText('Aspirin')).toBeNull();
    expect(within(region).getByText(new RegExp(REFILL_DISCLAIMER))).toBeTruthy();
    expect(screen.queryByRole('region', { name: '異常檢驗總覽' })).toBeNull();
  });

  it('suggests rechecking old abnormal results and pinned items without new values', () => {
    const glucose = lab('血糖', 400, 100);
    const creatinine = lab('肌酸酐', 100, 90);
    store.preferences.pinnedLabItems = [labSeriesKey(glucose), labSeriesKey(creatinine)];
    renderSummary(data([lab('A1C', 200, 150), lab('LDL', 10, 200), glucose, creatinine]));

    const region = screen.getByRole('region', { name: '建議複驗' });
    expect(within(region).getByText('共 2 項')).toBeTruthy();

    const a1c = within(region).getByText('A1C').closest('li') as HTMLElement;
    expect(within(a1c).getByText('上次偏高')).toBeTruthy();
    expect(within(a1c).getByText(/200 天前/)).toBeTruthy();

    const routine = within(region).getByText('血糖').closest('li') as HTMLElement;
    expect(within(routine).getByText('例行追蹤')).toBeTruthy();

    expect(within(region).queryByText('LDL')).toBeNull();
    expect(within(region).queryByText('肌酸酐')).toBeNull();
  });
});

describe('KeySummary without a personal provider', () => {
  it('falls back to the read-only empty personal data', () => {
    render(<KeySummary data={data([lab('血糖', 5, 100)])} now={NOW} />);

    expect(screen.getByText('我的重點摘要')).toBeTruthy();
    expect(screen.getByText('尚未釘選任何追蹤項目')).toBeTruthy();
    expect(screen.queryByRole('region', { name: '領藥提醒' })).toBeNull();
  });
});
