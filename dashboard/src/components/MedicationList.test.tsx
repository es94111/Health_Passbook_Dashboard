import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MedicationRecord, Visit } from '../parsers/types';
import MedicationList from './MedicationList';

const medication = (overrides: Partial<MedicationRecord> = {}): MedicationRecord => ({
  id: 'rx-1', date: null, hospital: '甲醫院', name: '藥品 A', dosage: '每日一次', status: 'active',
  source: 'MedicationRequest', category: '處方', rawResource: { resourceType: 'MedicationRequest', id: 'rx-1' },
  origins: [{ format: 'FHIR', resourceType: 'MedicationRequest', id: 'rx-1', source: '匯入來源 A' }], ...overrides,
});
const proc = (code: string, name: string, qty = 1) => ({ code, name, qty });
const visit = (date: Date, procedures: Visit['procedures']): Visit => ({ date, hospital: '甲醫院', diagnoses: [], procedures });
afterEach(cleanup);

describe('MedicationList', () => {
  it('distinguishes prescription, dispense, and medication history without claiming current use', () => {
    render(<MedicationList medications={[
      medication(), medication({ id: 'dispense-1', name: '藥品 B', source: 'MedicationDispense', category: '領藥', date: new Date('2025-01-01') }),
      medication({ id: 'statement-1', name: '藥品 C', source: 'MedicationStatement', category: '用藥紀錄', status: 'stopped' }),
    ]} />);
    expect(screen.getByText(/不等同目前實際服藥清單/)).toBeTruthy();
    expect(within(screen.getByRole('article', { name: '藥品 A' })).getByText('處方')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: '藥品 B' })).getByText('領藥')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: '藥品 C' })).getByText('用藥紀錄')).toBeTruthy();
    expect(screen.getAllByText(/日期未提供/)).toHaveLength(2);
    expect(screen.getByRole('article', { name: '藥品 A' }).textContent).toContain('原始狀態：active');
    expect(screen.getAllByRole('article')[0].getAttribute('aria-label')).toBe('藥品 B');
    fireEvent.change(screen.getByRole('combobox', { name: '用藥紀錄類型' }), { target: { value: '領藥' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.getByRole('article', { name: '藥品 B' })).toBeTruthy();
  });

  it('searches medication details and shows raw IDs and source text without remote links', () => {
    const { container } = render(<MedicationList medications={[medication({ rawResource: { text: '<img src="https://external.example">' } }), medication({ id: 'rx-2', name: '藥品 B', dosage: '每日兩次', origins: [] })]} />);
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋用藥紀錄' }), { target: { value: '匯入來源 A' } });
    expect(screen.getAllByRole('article')).toHaveLength(1);
    fireEvent.click(screen.getByText('原始資源與來源'));
    expect(screen.getByText(/FHIR · MedicationRequest\/rx-1 · 來源：匯入來源 A/)).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toContain('<img src=');
    expect(container.querySelector('img, a, iframe')).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋用藥紀錄' }), { target: { value: '不存在的藥品' } });
    expect(screen.getByText('沒有符合條件的用藥紀錄')).toBeTruthy();
  });
});

const NHI_REGION = '健保醫令用藥（推估）';

describe('MedicationList · 健保醫令用藥', () => {
  const visits = [
    visit(new Date(2025, 0, 5), [proc('AA1', '舊藥甲'), proc('BB2', '常用藥乙')]),
    visit(new Date(2025, 5, 20), [proc('BB2', '常用藥乙'), proc('CC3', '新藥丙'), proc('01001C', '診察費')]),
    visit(new Date(2025, 5, 30), [proc('CC3', '新藥丙')]),
  ];
  const nhiRegion = () => screen.getByRole('region', { name: NHI_REGION });

  it('summarizes drug orders from visits and leaves out non-drug orders', () => {
    render(<MedicationList medications={[]} visits={visits} />);
    const region = nhiRegion();
    expect(within(region).getByText(/僅代表曾被開立/)).toBeTruthy();
    const table = within(region).getByRole('table', { name: '健保醫令用藥彙整' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map(row => within(row).getByRole('rowheader').textContent)).toEqual(['新藥丙CC3', '常用藥乙BB2', '舊藥甲AA1']);
    expect(within(region).getByRole('status').textContent).toBe('顯示 3 / 3 種藥品');
    expect(screen.queryByText('診察費')).toBeNull();
    expect(screen.queryByText('01001C')).toBeNull();
  });

  it('shows the last prescribed date, total count and recent count of each drug', () => {
    render(<MedicationList medications={[]} visits={visits} />);
    const cells = (name: string) => within(screen.getByRole('row', { name: new RegExp(name) })).getAllByRole('cell').map(cell => cell.textContent);
    expect(cells('新藥丙')).toEqual(['2025-06-30', '2', '2']);
    expect(cells('常用藥乙')).toEqual(['2025-06-20', '2', '1']);
    expect(cells('舊藥甲')).toEqual(['2025-01-05', '1', '0']);
  });

  it('filters by drug name or code, ignoring case', () => {
    render(<MedicationList medications={[]} visits={visits} />);
    const search = screen.getByRole('textbox', { name: '搜尋健保醫令用藥' });
    fireEvent.change(search, { target: { value: '新藥' } });
    expect(within(nhiRegion()).getAllByRole('row')).toHaveLength(2);
    expect(within(nhiRegion()).getByRole('status').textContent).toBe('顯示 1 / 3 種藥品');
    fireEvent.change(search, { target: { value: 'bb2' } });
    expect(within(nhiRegion()).getAllByRole('row')).toHaveLength(2);
    expect(within(nhiRegion()).getByRole('rowheader', { name: /常用藥乙/ })).toBeTruthy();
    fireEvent.change(search, { target: { value: '不存在' } });
    expect(within(nhiRegion()).getByText('沒有符合條件的藥品')).toBeTruthy();
    expect(within(nhiRegion()).queryByRole('table')).toBeNull();
  });

  it('can limit the list to drugs prescribed within 90 days of the latest visit', () => {
    render(<MedicationList medications={[]} visits={visits} />);
    const toggle = screen.getByRole('checkbox', { name: /近 90 天/ });
    fireEvent.click(toggle);
    const region = nhiRegion();
    expect(within(region).getByRole('status').textContent).toBe('顯示 2 / 3 種藥品');
    expect(within(region).queryByRole('rowheader', { name: /舊藥甲/ })).toBeNull();
    expect(within(region).getByRole('rowheader', { name: /常用藥乙/ })).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋健保醫令用藥' }), { target: { value: '舊藥' } });
    expect(within(region).getByText('沒有符合條件的藥品')).toBeTruthy();
    fireEvent.click(toggle);
    expect(within(region).getByRole('rowheader', { name: /舊藥甲/ })).toBeTruthy();
  });

  it('is hidden without visits or drug orders and keeps the original empty state', () => {
    const { rerender } = render(<MedicationList medications={[]} />);
    expect(screen.queryByRole('region', { name: NHI_REGION })).toBeNull();
    expect(screen.getByText('尚無用藥資料')).toBeTruthy();
    rerender(<MedicationList medications={[]} visits={[visit(new Date(2025, 0, 1), [proc('01001C', '診察費')])]} />);
    expect(screen.queryByRole('region', { name: NHI_REGION })).toBeNull();
    expect(screen.getByText('尚無用藥資料')).toBeTruthy();
  });

  it('shows only the NHI section when there are no FHIR medications', () => {
    render(<MedicationList medications={[]} visits={visits} />);
    expect(screen.queryByRole('region', { name: '用藥紀錄' })).toBeNull();
    expect(screen.queryByText('尚無用藥資料')).toBeNull();
  });

  it('shows both sources, with the not-a-current-list notice only on the FHIR records', () => {
    render(<MedicationList medications={[medication()]} visits={visits} />);
    expect(screen.getAllByRole('region').map(region => region.getAttribute('aria-label'))).toEqual([NHI_REGION, '用藥紀錄']);
    expect(screen.getAllByText(/不等同目前實際服藥清單/)).toHaveLength(1);
  });

  it('renders drug names as plain text without links, images or frames', () => {
    const name = '<img src="https://external.example">';
    const { container } = render(<MedicationList medications={[]} visits={[visit(new Date(2025, 0, 1), [proc('AA1', name)])]} />);
    expect(screen.getByText(name)).toBeTruthy();
    expect(container.querySelector('img, a, iframe')).toBeNull();
  });
});
