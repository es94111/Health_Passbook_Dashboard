import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { labSeriesKey } from '../lib/clinicalLabSeries';
import type { Hospitalization, LabResult, NHIData, Visit } from '../parsers/types';
import { EMPTY_PERSONAL, PersonalContext, type PersonalContextValue } from '../personalContext';
import type { Allergy, Condition, Measurement, PersonalData, PersonalNote, RefillPlan } from '../personalData';
import VisitSummary from './VisitSummary';

const NOW = new Date(2026, 9, 31, 12);
const daysAgo = (days: number): Date => new Date(2026, 9, 31 - days);

const proc = (code: string, name: string, qty = 1) => ({ code, name, qty });

const visit = (date: Date, overrides: Partial<Visit> = {}): Visit => ({
  date, hospital: '甲醫院', diagnoses: [], procedures: [], ...overrides,
});

const stay = (admitDate: Date, dischargeDate: Date, overrides: Partial<Hospitalization> = {}): Hospitalization => ({
  admitDate, dischargeDate, hospital: '甲醫院', diagnoses: [], ...overrides,
});

const lab = (name: string, daysOld: number, value: number, overrides: Partial<LabResult> = {}): LabResult => ({
  date: daysAgo(daysOld), hospital: '甲醫院', testGroup: '生化', subItem: name, value,
  refLow: 70, refHigh: 110, unit: 'mg/dL', code: `code-${name}`, source: 'FHIR', ...overrides,
});

const plan = (id: string, drugName: string, prescribedDate: string, overrides: Partial<RefillPlan> = {}): RefillPlan => ({
  id, drugName, prescribedDate, daysPerFill: 28, fills: 3, taken: 1, ...overrides,
});
const OPEN = plan('open-1', 'Metformin', '2026-10-10');
const OVERDUE = plan('overdue-1', 'Amlodipine', '2026-09-01', { hospital: '乙診所' });
const NOT_YET = plan('later-1', 'Statin', '2026-10-25');
const FINISHED = plan('done-1', 'Aspirin', '2026-08-01', { taken: 3 });

const QUESTION: PersonalNote = { id: 'q1', date: '2026-10-20', kind: 'question', text: '要不要調整降血壓藥？' };

const BP: Measurement = { id: 'bp-1', kind: 'bp', date: '2026-10-30', systolic: 120, diastolic: 80 };
const GLUCOSE: Measurement = { id: 'g-1', kind: 'glucose', date: '2026-10-30', value: 95, context: 'fasting' };
const WEIGHT: Measurement = { id: 'w-1', kind: 'weight', date: '2026-10-30', value: 70 };

const data = (overrides: Partial<NHIData> = {}): NHIData => ({
  visits: [], hospitalizations: [], vaccinations: [], labResults: [], checkupReports: [], dentalVisits: [],
  medicalReports: [], medications: [], textLabResults: [], importHistory: [], duplicateCandidateCount: 0,
  ...overrides,
});

const value = (overrides: Partial<PersonalContextValue> = {}): PersonalContextValue => ({
  personal: EMPTY_PERSONAL, canEdit: true, saving: false, error: null, clearError: () => {}, update: async () => true,
  ...overrides,
});

const personalWith = (personal: Partial<PersonalData>): PersonalData => ({ ...EMPTY_PERSONAL, ...personal });

const renderSummary = (d: NHIData = data(), personal: Partial<PersonalData> = {}) =>
  render(
    <PersonalContext.Provider value={value({ personal: personalWith(personal) })}>
      <VisitSummary data={d} now={NOW} />
    </PersonalContext.Provider>,
  );

const block = (name: string) => screen.getByRole('region', { name });

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('VisitSummary', () => {
  describe('header and structure', () => {
    it('works without a personal provider', () => {
      render(<VisitSummary data={data()} now={NOW} />);
      expect(screen.getByRole('heading', { name: '看診摘要' })).toBeTruthy();
      expect(screen.getByText('尚無自我量測紀錄')).toBeTruthy();
    });

    it('always renders every block with its own empty state', () => {
      renderSummary();
      expect(within(block('待問問題')).getByText(/沒有待問的問題/)).toBeTruthy();
      const profile = within(block('過敏與病史'));
      expect(profile.getByText(/未記錄不代表沒有過敏/)).toBeTruthy();
      expect(profile.getByText('尚未記錄病史')).toBeTruthy();
      expect(within(block('目前用藥（推估）')).getByText('近 90 天沒有健保處方紀錄')).toBeTruthy();
      expect(within(block('領藥進度')).getByText('沒有連續處方的領藥計畫')).toBeTruthy();
      expect(within(block('異常檢驗')).getByText('尚無檢驗資料')).toBeTruthy();
      expect(within(block('自我量測')).getByText('尚無自我量測紀錄')).toBeTruthy();
      expect(within(block('主要診斷')).getByText('尚無門診診斷紀錄')).toBeTruthy();
      expect(within(block('近期門診')).getByText('尚無門診紀錄')).toBeTruthy();
      expect(within(block('近期住院')).getByText('尚無住院紀錄')).toBeTruthy();
      expect(screen.getByText(/僅供看診參考/)).toBeTruthy();
    });

    it('shows the generation date from the clock', () => {
      renderSummary();
      expect(screen.getByText(/產生日期/).textContent).toBe('產生日期：2026-10-31');
    });

    it('shows the date of the latest record without a stale warning', () => {
      renderSummary(data({ visits: [visit(daysAgo(3))] }));
      expect(screen.getByText(/資料最新紀錄/).textContent).toBe('資料最新紀錄：2026-10-28');
      expect(screen.queryByText(/內容可能不是最新/)).toBeNull();
    });

    it('warns when the latest record is old', () => {
      renderSummary(data({ visits: [visit(daysAgo(120))] }));
      expect(screen.getByText(/資料最新紀錄/).textContent).toBe('資料最新紀錄：2026-07-03');
      expect(screen.getByText('最新紀錄距今 120 天，內容可能不是最新')).toBeTruthy();
    });

    it('says so when there is no health insurance record', () => {
      renderSummary();
      expect(screen.getByText('尚無健保資料紀錄')).toBeTruthy();
      expect(screen.queryByText(/資料最新紀錄/)).toBeNull();
      expect(screen.queryByText(/內容可能不是最新/)).toBeNull();
    });

    it('opens the print dialog from the print button', () => {
      const print = vi.spyOn(window, 'print').mockImplementation(() => {});
      renderSummary();
      const button = screen.getByRole('button', { name: '列印' });
      expect(button.className).toContain('print:hidden');
      fireEvent.click(button);
      expect(print).toHaveBeenCalledTimes(1);
    });

    it('marks the summary as the printable sheet', () => {
      renderSummary();
      expect(screen.getByRole('region', { name: '看診摘要' }).className).toContain('print-sheet');
    });

    it('is read-only: the print button is the only control', () => {
      renderSummary(data(), { notes: [QUESTION], refills: [OPEN] });
      expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual(['列印']);
      expect(screen.queryAllByRole('textbox')).toHaveLength(0);
    });

    it('updates when the personal data changes', () => {
      const { rerender } = renderSummary();
      expect(screen.queryByText(QUESTION.text)).toBeNull();
      rerender(
        <PersonalContext.Provider value={value({ personal: personalWith({ notes: [QUESTION] }) })}>
          <VisitSummary data={data()} now={NOW} />
        </PersonalContext.Provider>,
      );
      expect(screen.getByText(QUESTION.text)).toBeTruthy();
    });
  });

  describe('待問問題', () => {
    it('lists only open questions, oldest first', () => {
      renderSummary(data(), {
        notes: [
          { id: 'q-b', date: '2026-10-22', kind: 'question', text: 'Second question' },
          { id: 'q-a', date: '2026-10-20', kind: 'question', text: 'First question' },
          { id: 'q-done', date: '2026-10-21', kind: 'question', text: 'Answered question', done: true },
          { id: 'n-1', date: '2026-10-23', kind: 'note', text: 'Plain note' },
        ],
      });
      const blk = block('待問問題');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain('2026-10-20');
      expect(items[0].textContent).toContain('First question');
      expect(items[1].textContent).toContain('Second question');
      expect(within(blk).queryByText('Answered question')).toBeNull();
      expect(within(blk).queryByText('Plain note')).toBeNull();
      expect(within(blk).queryByText(/沒有待問的問題/)).toBeNull();
    });
  });

  describe('過敏與病史', () => {
    const allergies: Allergy[] = [
      { id: 'a1', name: 'Aspirin', severity: 'mild' },
      { id: 'a2', name: 'Penicillin', severity: 'severe', reaction: 'Anaphylaxis' },
      { id: 'a3', name: 'Latex' },
      { id: 'a4', name: 'Codeine', severity: 'moderate' },
    ];

    it('lists allergies from most to least severe with a text label', () => {
      renderSummary(data(), { profile: { allergies, conditions: [] } });
      const blk = block('過敏與病史');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(4);
      expect(items[0].textContent).toContain('Penicillin');
      expect(within(items[0]).getByText('嚴重')).toBeTruthy();
      expect(within(items[0]).getByText('Anaphylaxis')).toBeTruthy();
      expect(items[1].textContent).toContain('Codeine');
      expect(within(items[1]).getByText('中度')).toBeTruthy();
      expect(items[2].textContent).toContain('Aspirin');
      expect(within(items[2]).getByText('輕微')).toBeTruthy();
      expect(items[3].textContent).toContain('Latex');
      expect(within(items[3]).queryByText(/嚴重|中度|輕微/)).toBeNull();
      expect(within(blk).queryByText(/未記錄不代表沒有過敏/)).toBeNull();
    });

    it('breaks severity ties by name', () => {
      renderSummary(data(), {
        profile: {
          allergies: [
            { id: 'a1', name: 'Zinc', severity: 'mild' },
            { id: 'a2', name: 'Almond', severity: 'mild' },
          ],
          conditions: [],
        },
      });
      const items = within(block('過敏與病史')).getAllByRole('listitem');
      expect(items[0].textContent).toContain('Almond');
      expect(items[1].textContent).toContain('Zinc');
    });

    it('lists conditions with the year they started', () => {
      const conditions: Condition[] = [
        { id: 'c1', name: 'Hypertension', sinceYear: 2018 },
        { id: 'c2', name: 'Asthma' },
      ];
      renderSummary(data(), { profile: { allergies: [], conditions } });
      const blk = block('過敏與病史');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain('Hypertension');
      expect(within(items[0]).getByText('自 2018 年')).toBeTruthy();
      expect(items[1].textContent).toBe('Asthma');
      expect(within(blk).queryByText('尚未記錄病史')).toBeNull();
      expect(within(blk).getByText(/未記錄不代表沒有過敏/)).toBeTruthy();
    });
  });

  describe('目前用藥（推估）', () => {
    it('lists drugs prescribed recently, not old or non-drug orders', () => {
      renderSummary(data({
        visits: [
          visit(daysAgo(11), { procedures: [proc('AA01', 'Metformin 500mg'), proc('01012B', '診察費')] }),
          visit(daysAgo(40), { procedures: [proc('AA01', 'Metformin 500mg')] }),
          visit(daysAgo(300), { procedures: [proc('BB02', 'Retired drug')] }),
        ],
      }));
      const blk = block('目前用藥（推估）');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(1);
      expect(within(blk).getByText('Metformin 500mg')).toBeTruthy();
      expect(within(blk).getByText('AA01')).toBeTruthy();
      expect(within(blk).getByText('2026-10-20')).toBeTruthy();
      expect(within(blk).getByText('近 90 天 2 次')).toBeTruthy();
      expect(within(blk).queryByText('Retired drug')).toBeNull();
      expect(within(blk).queryByText('診察費')).toBeNull();
      expect(within(blk).getByText(/依健保處方推估/)).toBeTruthy();
      expect(within(blk).getByText(/與醫師、藥師確認/)).toBeTruthy();
    });

    it('does not repeat the code when the drug has no separate name', () => {
      renderSummary(data({ visits: [visit(daysAgo(2), { procedures: [proc('AA09', 'AA09')] })] }));
      const item = within(block('目前用藥（推估）')).getByRole('listitem');
      expect(item.querySelectorAll('.font-mono')).toHaveLength(1);
      expect(within(item).getByText('AA09')).toBeTruthy();
    });

    it('caps the list and says how many were left out', () => {
      const drugs = Array.from({ length: 25 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0');
        return proc(`AA${number}`, `Drug ${number}`);
      });
      renderSummary(data({ visits: [visit(daysAgo(5), { procedures: drugs })] }));
      const blk = block('目前用藥（推估）');
      expect(within(blk).getAllByRole('listitem')).toHaveLength(20);
      expect(within(blk).getByText('Drug 01')).toBeTruthy();
      expect(within(blk).getByText('Drug 20')).toBeTruthy();
      expect(within(blk).queryByText('Drug 21')).toBeNull();
      expect(within(blk).getByText('另有 5 項未列出')).toBeTruthy();
    });

    it('shows no "more" note when everything fits', () => {
      renderSummary(data({ visits: [visit(daysAgo(5), { procedures: [proc('AA01', 'Drug 01')] })] }));
      expect(within(block('目前用藥（推估）')).queryByText(/項未列出/)).toBeNull();
    });
  });

  describe('領藥進度', () => {
    it('lists plans by urgency with a status label and progress', () => {
      renderSummary(data(), { refills: [FINISHED, NOT_YET, OPEN, OVERDUE] });
      const blk = block('領藥進度');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(4);

      expect(items[0].textContent).toContain('Amlodipine');
      expect(within(items[0]).getByText('藥量可能已用完')).toBeTruthy();
      expect(items[0].textContent).toContain('乙診所 · 預估已用完 32 天 · 已領 1/3 次');

      expect(items[1].textContent).toContain('Metformin');
      expect(within(items[1]).getByText('可領藥')).toBeTruthy();
      expect(items[1].textContent).toContain('預估 7 天後用完 · 已領 1/3 次');

      expect(items[2].textContent).toContain('Statin');
      expect(within(items[2]).getByText('尚未到期')).toBeTruthy();
      expect(items[2].textContent).toContain('12 天後開始可領 · 已領 1/3 次');

      expect(items[3].textContent).toContain('Aspirin');
      expect(within(items[3]).getByText('連續處方已領完，需回診開立新處方')).toBeTruthy();
      expect(items[3].textContent).toContain('已領 3/3 次');
    });

    it('states that the schedule is an estimate, not medical advice', () => {
      renderSummary(data(), { refills: [OPEN] });
      const note = within(block('領藥進度')).getByText(/僅供提醒，非醫囑/);
      expect(note.textContent).toContain('實際規定以健保署與藥局為準');
    });

    it('omits the estimate note when there are no plans', () => {
      renderSummary();
      expect(within(block('領藥進度')).queryByText(/非醫囑/)).toBeNull();
    });

    it('caps the list and says how many were left out', () => {
      const plans = Array.from({ length: 12 }, (_, index) => plan(`p-${index}`, `Drug ${index}`, '2026-10-10'));
      renderSummary(data(), { refills: plans });
      const blk = block('領藥進度');
      expect(within(blk).getAllByRole('listitem')).toHaveLength(10);
      expect(within(blk).getByText('另有 2 項未列出')).toBeTruthy();
    });
  });

  describe('異常檢驗', () => {
    const labs = [
      lab('Glucose', 40, 130),
      lab('Glucose', 5, 150),
      lab('Creatinine', 40, 0.4, { refLow: 0.7, refHigh: 1.3 }),
      lab('Creatinine', 3, 0.5, { refLow: 0.7, refHigh: 1.3 }),
      lab('Uric acid', 8, 9, { refLow: 3.5, refHigh: 7 }),
      lab('HbA1c', 6, 5.5, { refLow: 4, refHigh: 6, unit: '%' }),
    ];

    it('lists only high and low items, worsening first, each with a text status', () => {
      renderSummary(data({ labResults: labs }));
      const blk = block('異常檢驗');
      const table = within(blk).getByRole('table', { name: '最新一次檢驗偏高或偏低的項目' });
      const rows = within(table).getAllByRole('row');
      expect(rows).toHaveLength(4);
      expect(within(rows[1]).getByRole('rowheader').textContent).toBe('Glucose');
      expect(within(rows[2]).getByRole('rowheader').textContent).toBe('Creatinine');
      expect(within(rows[3]).getByRole('rowheader').textContent).toBe('Uric acid');
      expect(within(blk).queryByText('HbA1c')).toBeNull();
      expect(within(blk).getAllByText('偏高')).toHaveLength(2);
      expect(within(blk).getAllByText('偏低')).toHaveLength(1);
    });

    it('shows the latest value, previous value, reference and date', () => {
      renderSummary(data({ labResults: labs }));
      const blk = block('異常檢驗');

      const glucose = within(blk).getByRole('row', { name: /Glucose/ });
      expect(glucose.textContent).toContain('150');
      expect(glucose.textContent).toContain('mg/dL');
      expect(glucose.textContent).toContain('130');
      expect(glucose.textContent).toContain('70–110');
      expect(glucose.textContent).toContain('2026-10-26');
      expect(glucose.textContent).toContain('較上次惡化');

      const creatinine = within(blk).getByRole('row', { name: /Creatinine/ });
      expect(creatinine.textContent).toContain('0.50');
      expect(creatinine.textContent).toContain('0.40');
      expect(creatinine.textContent).toContain('0.7–1.3');
      expect(creatinine.textContent).not.toContain('較上次惡化');

      expect(within(blk).getAllByText('較上次惡化')).toHaveLength(1);
    });

    it('shows a dash when there is no previous reading', () => {
      renderSummary(data({ labResults: [lab('Uric acid', 8, 9, { refLow: 3.5, refHigh: 7 })] }));
      const row = within(block('異常檢驗')).getByRole('row', { name: /Uric acid/ });
      const cells = within(row).getAllByRole('cell');
      expect(cells[1].textContent).toBe('—');
    });

    it('applies and labels a personal target', () => {
      const reading = lab('Glucose', 2, 100);
      renderSummary(data({ labResults: [reading] }), { targets: { [labSeriesKey(reading)]: { high: 90 } } });
      const blk = block('異常檢驗');
      const row = within(blk).getByRole('row', { name: /Glucose/ });
      expect(within(row).getByText('偏高')).toBeTruthy();
      expect(row.textContent).toContain('≤ 90（個人目標）');
    });

    it('says when nothing is abnormal', () => {
      renderSummary(data({ labResults: [lab('Glucose', 2, 100)] }));
      const blk = block('異常檢驗');
      expect(within(blk).getByText('最新一次檢驗沒有偏高或偏低的項目')).toBeTruthy();
      expect(within(blk).queryByText('尚無檢驗資料')).toBeNull();
      expect(within(blk).queryByRole('table')).toBeNull();
    });

    it('caps the table and says how many were left out', () => {
      const many = Array.from({ length: 14 }, (_, index) => lab(`Lab ${String(index + 1).padStart(2, '0')}`, 2, 200));
      renderSummary(data({ labResults: many }));
      const blk = block('異常檢驗');
      expect(within(blk).getAllByRole('row')).toHaveLength(13);
      expect(within(blk).getByText('另有 2 項未列出')).toBeTruthy();
    });
  });

  describe('自我量測', () => {
    it('summarises only the kinds that have readings', () => {
      renderSummary(data(), { measurements: [BP, GLUCOSE, WEIGHT] });
      const blk = block('自我量測');
      const table = within(blk).getByRole('table', { name: '自我量測摘要' });
      expect(within(table).getAllByRole('row')).toHaveLength(4);

      const bpRow = within(blk).getByRole('row', { name: /血壓/ });
      expect(within(bpRow).getByRole('rowheader').textContent).toBe('血壓（mmHg）');
      expect(within(bpRow).getAllByText('120/80')).toHaveLength(3);

      const glucoseRow = within(blk).getByRole('row', { name: /血糖/ });
      expect(within(glucoseRow).getByRole('rowheader').textContent).toBe('血糖（mg/dL）');
      expect(within(glucoseRow).getAllByText('95')).toHaveLength(3);

      const weightRow = within(blk).getByRole('row', { name: /體重/ });
      expect(within(weightRow).getByRole('rowheader').textContent).toBe('體重（kg）');
      expect(within(weightRow).getAllByText('70.0')).toHaveLength(3);
    });

    it('leaves out kinds without readings', () => {
      renderSummary(data(), { measurements: [BP] });
      const blk = block('自我量測');
      expect(within(blk).getAllByRole('row')).toHaveLength(2);
      expect(within(blk).queryByText('血糖（mg/dL）')).toBeNull();
      expect(within(blk).queryByText('體重（kg）')).toBeNull();
    });

    it('shows when the latest reading was taken', () => {
      renderSummary(data(), { measurements: [{ ...BP, time: '07:30' }] });
      expect(within(block('自我量測')).getByText('2026-10-30 07:30')).toBeTruthy();
    });

    it('shows dashes for averages when readings are too old', () => {
      renderSummary(data(), { measurements: [{ ...WEIGHT, date: '2026-08-01' }] });
      const row = within(block('自我量測')).getByRole('row', { name: /體重/ });
      const cells = within(row).getAllByRole('cell');
      expect(cells[0].textContent).toContain('70.0');
      expect(cells[1].textContent).toBe('—');
      expect(cells[2].textContent).toBe('—');
    });
  });

  describe('主要診斷', () => {
    const roots = [
      ['A01', 'Alpha'], ['B02', 'Bravo'], ['C03', 'Charlie'], ['D04', 'Delta'], ['E05', 'Echo'], ['F06', 'Foxtrot'],
    ] as const;
    const visits = roots.flatMap(([code, name], index) =>
      Array.from({ length: roots.length - index }, (_, repeat) =>
        visit(daysAgo(1 + index * 7 + repeat), { diagnoses: [{ code, name }] })));

    it('ranks diagnoses by visit count and shows the top five', () => {
      renderSummary(data({ visits }));
      const blk = block('主要診斷');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(5);
      expect(items.map(item => item.textContent)).toEqual([
        expect.stringContaining('Alpha'),
        expect.stringContaining('Bravo'),
        expect.stringContaining('Charlie'),
        expect.stringContaining('Delta'),
        expect.stringContaining('Echo'),
      ]);
      expect(within(items[0]).getByText('A01')).toBeTruthy();
      expect(within(items[0]).getByText('6 次就診')).toBeTruthy();
      expect(within(items[0]).getByText('2026-10-30')).toBeTruthy();
      expect(within(items[4]).getByText('2 次就診')).toBeTruthy();
      expect(within(blk).queryByText('Foxtrot')).toBeNull();
      expect(within(blk).getByText('另有 1 項未列出')).toBeTruthy();
    });
  });

  describe('近期門診', () => {
    it('lists the newest visits first and caps the list', () => {
      const visits = Array.from({ length: 7 }, (_, index) => visit(daysAgo(index + 1), { hospital: `Hosp ${index + 1}` }));
      renderSummary(data({ visits: [...visits].reverse() }));
      const blk = block('近期門診');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(6);
      expect(items[0].textContent).toContain('2026-10-30');
      expect(items[0].textContent).toContain('Hosp 1');
      expect(items[5].textContent).toContain('Hosp 6');
      expect(within(blk).queryByText('Hosp 7')).toBeNull();
      expect(within(blk).getByText('另有 1 項未列出')).toBeTruthy();
    });

    it('falls back when the hospital or diagnosis is missing', () => {
      renderSummary(data({ visits: [visit(daysAgo(2), { hospital: '' })] }));
      const item = within(block('近期門診')).getByRole('listitem');
      expect(within(item).getByText('院所未提供')).toBeTruthy();
      expect(within(item).getByText('診斷未提供')).toBeTruthy();
    });

    it('shows each distinct diagnosis once, at most three', () => {
      renderSummary(data({
        visits: [visit(daysAgo(2), {
          diagnoses: [
            { code: 'I10', name: '高血壓' },
            { code: 'I10', name: '高血壓' },
            { code: 'E11', name: '糖尿病' },
            { code: 'J45', name: '氣喘' },
            { code: 'K29', name: '胃炎' },
          ],
        })],
      }));
      const blk = block('近期門診');
      expect(within(blk).getByText('高血壓、糖尿病、氣喘')).toBeTruthy();
      expect(within(blk).queryByText(/胃炎/)).toBeNull();
    });

    it('uses the code when a diagnosis has no name', () => {
      renderSummary(data({ visits: [visit(daysAgo(2), { diagnoses: [{ code: 'I10', name: '' }] })] }));
      expect(within(block('近期門診')).getByText('I10')).toBeTruthy();
    });

    it('ignores visits whose date cannot be read', () => {
      renderSummary(data({ visits: [visit(new Date(NaN))] }));
      expect(within(block('近期門診')).getByText('尚無門診紀錄')).toBeTruthy();
    });
  });

  describe('近期住院', () => {
    it('lists the three most recent stays with their date range', () => {
      renderSummary(data({
        hospitalizations: [
          stay(new Date(2026, 5, 1), new Date(2026, 5, 4), { hospital: 'Hosp A' }),
          stay(new Date(2026, 8, 1), new Date(2026, 8, 5), { hospital: 'Hosp D', diagnoses: [{ code: 'I10', name: '高血壓' }] }),
          stay(new Date(2026, 6, 1), new Date(2026, 6, 4), { hospital: 'Hosp B' }),
          stay(new Date(2026, 7, 1), new Date(2026, 7, 4), { hospital: 'Hosp C' }),
        ],
      }));
      const blk = block('近期住院');
      const items = within(blk).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(items[0].textContent).toContain('2026-09-01 ~ 2026-09-05');
      expect(items[0].textContent).toContain('Hosp D');
      expect(items[0].textContent).toContain('高血壓');
      expect(items[1].textContent).toContain('Hosp C');
      expect(items[1].textContent).toContain('診斷未提供');
      expect(items[2].textContent).toContain('Hosp B');
      expect(within(blk).queryByText('Hosp A')).toBeNull();
      expect(within(blk).getByText('另有 1 項未列出')).toBeTruthy();
    });

    it('shows a dash when the discharge date cannot be read', () => {
      renderSummary(data({ hospitalizations: [stay(new Date(2026, 9, 1), new Date(NaN), { hospital: '' })] }));
      const item = within(block('近期住院')).getByRole('listitem');
      expect(item.textContent).toContain('2026-10-01 ~ —');
      expect(within(item).getByText('院所未提供')).toBeTruthy();
    });

    it('ignores stays whose admission date cannot be read', () => {
      renderSummary(data({ hospitalizations: [stay(new Date(NaN), new Date(NaN))] }));
      expect(within(block('近期住院')).getByText('尚無住院紀錄')).toBeTruthy();
    });
  });
});
