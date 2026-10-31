import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { computeAllLabSeriesSummaries, labSeriesKey } from '../lib/clinicalLabSeries';
import type { LabResult } from '../parsers/types';
import type { LabTarget } from '../personalData';
import AbnormalOverview from './AbnormalOverview';

afterEach(cleanup);

const reading = (name: string, value: number, overrides: Partial<LabResult> = {}): LabResult => ({
  date: new Date(2026, 9, 20),
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

const summariesOf = (readings: LabResult[], targets: Record<string, LabTarget> = {}) =>
  computeAllLabSeriesSummaries(readings, targets);

const rowOf = (name: string) => screen.getByText(name).closest('li') as HTMLElement;

describe('AbnormalOverview', () => {
  it('renders nothing without summaries', () => {
    const { container } = render(<AbnormalOverview summaries={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when every series is within range', () => {
    const { container } = render(<AbnormalOverview summaries={summariesOf([reading('Alpha', 100)])} />);
    expect(container.firstChild).toBeNull();
  });

  it('lists only abnormal series with value, unit, status and date', () => {
    render(
      <AbnormalOverview
        summaries={summariesOf([reading('Alpha', 150), reading('Beta', 50), reading('Gamma', 100)])}
      />,
    );

    expect(screen.getByRole('region', { name: '異常檢驗總覽' })).toBeTruthy();
    expect(screen.getByText('共 2 項')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.queryByText('Gamma')).toBeNull();

    const alpha = within(rowOf('Alpha'));
    expect(alpha.getByText('150')).toBeTruthy();
    expect(alpha.getByText('mg/dL')).toBeTruthy();
    expect(alpha.getByText('偏高')).toBeTruthy();
    expect(alpha.getByText('2026-10-20')).toBeTruthy();
    expect(within(rowOf('Beta')).getByText('偏低')).toBeTruthy();
  });

  it('formats fractional values with two decimals', () => {
    render(
      <AbnormalOverview
        summaries={summariesOf([reading('Delta', 5.5, { unit: 'mmol/L', refLow: 3.9, refHigh: 5 })])}
      />,
    );
    expect(within(rowOf('Delta')).getByText('5.50')).toBeTruthy();
  });

  it('shows the series description so same-named series stay distinguishable', () => {
    render(<AbnormalOverview summaries={summariesOf([reading('Alpha', 150)])} />);
    expect(within(rowOf('Alpha')).getByText('mg/dL · 甲醫院 · FHIR')).toBeTruthy();
  });

  it('marks a series that got worse since the previous reading', () => {
    render(
      <AbnormalOverview
        summaries={summariesOf([reading('Alpha', 120, { date: new Date(2026, 8, 1) }), reading('Alpha', 150)])}
      />,
    );
    expect(within(rowOf('Alpha')).getByText('較上次惡化')).toBeTruthy();
  });

  it('does not mark a series that is improving', () => {
    render(
      <AbnormalOverview
        summaries={summariesOf([reading('Alpha', 160, { date: new Date(2026, 8, 1) }), reading('Alpha', 150)])}
      />,
    );
    expect(within(rowOf('Alpha')).queryByText('較上次惡化')).toBeNull();
  });

  it('flags results judged against a personal target', () => {
    const alpha = reading('Alpha', 100);
    render(<AbnormalOverview summaries={summariesOf([alpha], { [labSeriesKey(alpha)]: { high: 90 } })} />);

    const row = within(rowOf('Alpha'));
    expect(row.getByText('偏高')).toBeTruthy();
    expect(row.getByText('依個人目標')).toBeTruthy();
  });

  it('does not flag the personal target when the reference range was used', () => {
    render(<AbnormalOverview summaries={summariesOf([reading('Alpha', 150)])} />);
    expect(within(rowOf('Alpha')).queryByText('依個人目標')).toBeNull();
  });

  it('uses list items rather than cards, so it never collides with pinned series cards', () => {
    render(<AbnormalOverview summaries={summariesOf([reading('Alpha', 150)])} />);
    expect(screen.queryAllByRole('article')).toHaveLength(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  describe('long lists', () => {
    const many = (count: number) =>
      summariesOf(Array.from({ length: count }, (_, index) => reading(`Item${index}`, 150)));

    it('collapses beyond the limit and expands on demand', () => {
      const { container } = render(<AbnormalOverview summaries={many(3)} limit={2} />);

      expect(screen.getAllByRole('listitem')).toHaveLength(2);
      const toggle = screen.getByRole('button', { name: '顯示全部 3 項' });
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
      expect(toggle.getAttribute('aria-controls')).toBe(container.querySelector('ul')?.id);

      fireEvent.click(toggle);
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
      const collapse = screen.getByRole('button', { name: '收合' });
      expect(collapse.getAttribute('aria-expanded')).toBe('true');

      fireEvent.click(collapse);
      expect(screen.getAllByRole('listitem')).toHaveLength(2);
    });

    it('has no toggle when everything fits', () => {
      render(<AbnormalOverview summaries={many(2)} limit={2} />);
      expect(screen.queryByRole('button')).toBeNull();
    });

    it('shows eight rows by default', () => {
      render(<AbnormalOverview summaries={many(9)} />);
      expect(screen.getAllByRole('listitem')).toHaveLength(8);
      expect(screen.getByRole('button', { name: '顯示全部 9 項' })).toBeTruthy();
    });
  });
});
