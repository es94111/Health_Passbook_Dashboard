import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseNHIJson } from '../parsers/nhi-parser';
import type { ImportSummary, NHIData } from '../parsers/types';
import ImportHistory from './ImportHistory';

afterEach(cleanup);
const history: ImportSummary = { id: 'synthetic-history', sourceId: 'a'.repeat(64), format: 'FHIR', importedAt: '2026-10-30T08:00:00Z',
  added: 2, updated: 1, skipped: 3, identityConfirmed: true, warnings: ['synthetic import warning'] };
const data = (overrides: Partial<NHIData> = {}): NHIData => ({ ...parseNHIJson({}), importHistory: [history], ...overrides });

describe('source and import history presentation', () => {
  it('shows processing counts, patient-consent provenance, cross-format caveats and plaintext download warning', () => {
    render(<ImportHistory data={data({ duplicateCandidateCount: 2, downloadSource: vi.fn() })} onImport={vi.fn()} />);
    expect(screen.getByText('新增 2 · 更新 1 · 略過 3')).toBeTruthy();
    expect(screen.getByText('病人身分由使用者確認，非自動驗證')).toBeTruthy();
    expect(screen.getByText('synthetic import warning')).toBeTruthy();
    expect(screen.getByText(/偵測到 2 筆/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '下載原始來源 JSON（未加密）' })).toBeTruthy();
    expect(screen.getByText(/不提供外掛直接同步/)).toBeTruthy();
  });
  it('does not fabricate import history for old encrypted records', () => {
    render(<ImportHistory data={data({ importHistory: [] })} onImport={vi.fn()} />);
    expect(screen.getByText(/這批既有病歷尚無匯入歷程/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /下載原始來源/ })).toBeNull();
  });
  it('delegates a source download and displays a non-sensitive failure without changing records', async () => {
    const downloadSource = vi.fn().mockRejectedValue(new Error('synthetic-private-error'));
    render(<ImportHistory data={data({ downloadSource })} onImport={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /下載原始來源/ }));
    await waitFor(() => expect(downloadSource).toHaveBeenCalledWith(history.sourceId));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText(/synthetic-private-error/)).toBeNull();
    expect((screen.getByRole('button', { name: /下載原始來源/ }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('opens the existing import flow without introducing direct extension communication', () => {
    const onImport = vi.fn();
    render(<ImportHistory data={data()} onImport={onImport} />);
    fireEvent.click(screen.getByRole('button', { name: '匯入新資料' }));
    expect(onImport).toHaveBeenCalledOnce();
  });
});
