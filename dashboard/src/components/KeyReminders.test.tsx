import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { computeAllLabSeriesSummaries, isLabSeriesPinned } from '../lib/clinicalLabSeries';
import { recheckCandidates } from '../lib/freshness';
import { REFILL_DISCLAIMER, refillReminders } from '../lib/refills';
import type { LabResult } from '../parsers/types';
import type { RefillPlan } from '../personalData';
import KeyReminders from './KeyReminders';

afterEach(cleanup);

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

const recheckOf = (readings: LabResult[], pinned: string[] = []) =>
  recheckCandidates(
    computeAllLabSeriesSummaries(readings),
    summary => isLabSeriesPinned(summary, pinned),
    NOW,
  );

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

const rowOf = (text: string) => screen.getByText(text).closest('li') as HTMLElement;

describe('KeyReminders', () => {
  it('renders nothing when there is nothing to remind', () => {
    const { container } = render(<KeyReminders recheck={[]} refills={[]} />);
    expect(container.firstChild).toBeNull();
  });

  describe('refill reminders', () => {
    const refills = refillReminders([OPEN, OVERDUE, NOT_YET, FINISHED], NOW);

    it('lists open and overdue plans, most urgent first', () => {
      render(<KeyReminders recheck={[]} refills={refills} />);

      expect(screen.getByRole('region', { name: '領藥提醒' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: '建議複驗' })).toBeNull();

      const rows = screen.getAllByRole('listitem');
      expect(rows).toHaveLength(2);
      expect(rows[0].textContent).toContain('Amlodipine');
      expect(rows[1].textContent).toContain('Metformin');
    });

    it('does not list plans that are not yet due or already finished', () => {
      render(<KeyReminders recheck={[]} refills={refills} />);
      expect(screen.queryByText('Statin')).toBeNull();
      expect(screen.queryByText('Aspirin')).toBeNull();
    });

    it('shows the state label, timing text and hospital', () => {
      render(<KeyReminders recheck={[]} refills={refills} />);

      const overdue = within(rowOf('Amlodipine'));
      expect(overdue.getByText('藥量可能已用完')).toBeTruthy();
      expect(overdue.getByText('預估已用完 32 天')).toBeTruthy();
      expect(overdue.getByText('乙診所')).toBeTruthy();

      const open = within(rowOf('Metformin'));
      expect(open.getByText('可領藥')).toBeTruthy();
      expect(open.getByText('預估 7 天後用完')).toBeTruthy();
    });

    it('colours overdue and open states differently', () => {
      render(<KeyReminders recheck={[]} refills={refills} />);
      expect(within(rowOf('Amlodipine')).getByText('藥量可能已用完').className).toContain('text-red-700');
      expect(within(rowOf('Metformin')).getByText('可領藥').className).toContain('text-amber-800');
    });

    it('states that the estimate relies on the user-entered prescription and carries the disclaimer', () => {
      render(<KeyReminders recheck={[]} refills={refills} />);
      const region = screen.getByRole('region', { name: '領藥提醒' });
      expect(region.textContent).toContain('依您填寫的處方資料推估，僅供提醒');
      expect(region.textContent).toContain(REFILL_DISCLAIMER);
    });
  });

  describe('recheck suggestions', () => {
    const candidates = recheckOf(
      [lab('Alpha', 120, 150), lab('Beta', 200, 50), lab('Gamma', 400, 100), lab('Delta', 5, 150)],
      ['Gamma'],
    );

    it('lists stale abnormal results and long-untouched pinned items', () => {
      render(<KeyReminders recheck={candidates} refills={[]} />);

      expect(screen.getByRole('region', { name: '建議複驗' })).toBeTruthy();
      expect(screen.queryByRole('region', { name: '領藥提醒' })).toBeNull();
      expect(screen.getByText('共 3 項')).toBeTruthy();
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
      expect(screen.queryByText('Delta')).toBeNull();
    });

    it('explains why each item is listed', () => {
      render(<KeyReminders recheck={candidates} refills={[]} />);

      expect(within(rowOf('Alpha')).getByText('上次偏高')).toBeTruthy();
      expect(within(rowOf('Beta')).getByText('上次偏低')).toBeTruthy();
      expect(within(rowOf('Gamma')).getByText('例行追蹤')).toBeTruthy();
    });

    it('shows the latest date, age and series description', () => {
      render(<KeyReminders recheck={candidates} refills={[]} />);

      const alpha = within(rowOf('Alpha'));
      expect(alpha.getByText('2026-07-03 · 120 天前')).toBeTruthy();
      expect(alpha.getByText('mg/dL · 甲醫院 · FHIR')).toBeTruthy();
    });

    it('collapses beyond the limit and expands on demand', () => {
      const { container } = render(<KeyReminders recheck={candidates} refills={[]} limit={2} />);

      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      const toggle = screen.getByRole('button', { name: '顯示全部 3 項' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBe(container.querySelector('ul')?.id);

      fireEvent.click(toggle);
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
      expect(screen.getByRole('button', { name: '收合' }).getAttribute('aria-expanded')).toBe('true');
    });

    it('has no toggle when everything fits', () => {
      render(<KeyReminders recheck={candidates} refills={[]} limit={3} />);
      expect(screen.queryByRole('button')).toBeNull();
    });
  });

  it('shows refill reminders before recheck suggestions when both exist', () => {
    const recheck = recheckOf([lab('Alpha', 120, 150)]);
    render(<KeyReminders recheck={recheck} refills={refillReminders([OPEN], NOW)} />);

    const regions = screen.getAllByRole('region');
    expect(regions).toHaveLength(2);
    expect(regions[0].textContent).toContain('領藥提醒');
    expect(regions[1].textContent).toContain('建議複驗');
  });

  it('uses list items rather than cards', () => {
    const recheck = recheckOf([lab('Alpha', 120, 150)]);
    render(<KeyReminders recheck={recheck} refills={refillReminders([OPEN], NOW)} />);
    expect(screen.queryAllByRole('article')).toHaveLength(0);
  });
});
