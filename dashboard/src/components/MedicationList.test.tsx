import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { MedicationRecord } from '../parsers/types';
import MedicationList from './MedicationList';

const medication = (overrides: Partial<MedicationRecord> = {}): MedicationRecord => ({
  id: 'rx-1', date: null, hospital: '甲醫院', name: '藥品 A', dosage: '每日一次', status: 'active',
  source: 'MedicationRequest', category: '處方', rawResource: { resourceType: 'MedicationRequest', id: 'rx-1' },
  origins: [{ format: 'FHIR', resourceType: 'MedicationRequest', id: 'rx-1', source: '匯入來源 A' }], ...overrides,
});
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
