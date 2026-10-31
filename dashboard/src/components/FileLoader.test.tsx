import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileLoader from './FileLoader';
import {
  commitLargeImport, commitPreparedJsonImport, migrateHealthData, prepareJsonImport, prepareLargeImport, unlockHealthData,
} from '../importHealthData';
import type { ImportPreview } from '../importPreview';
import { PatientConfirmationRequired } from '../recordImport';

vi.mock('../importHealthData', () => ({
  prepareJsonImport: vi.fn(), commitPreparedJsonImport: vi.fn(), prepareLargeImport: vi.fn(), commitLargeImport: vi.fn(),
  unlockHealthData: vi.fn(), migrateHealthData: vi.fn(),
}));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const props = () => ({ storedEnvelope: null, needsClientEncryptionMigration: false, onEnvelopeSaved: vi.fn(), onLoad: vi.fn() });
function selectFile(container: HTMLElement, json = '{"r1":[{}]}') {
  const file = new File([json], 'synthetic.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => json });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}
function selectOversizedFile(container: HTMLElement) {
  const file = new File(['{}'], 'synthetic-large.json', { type: 'application/json' });
  Object.defineProperty(file, 'size', { value: 2 * 1024 * 1024 * 1024 });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}
const previewOf = (overrides: Partial<ImportPreview> = {}): ImportPreview => ({
  fileName: 'synthetic.json', fileSize: 1234, format: 'NHI', estimated: false, needsConfirmation: false,
  from: '2020-01-01', to: '2024-12-31', counts: { incoming: 3, added: 2, updated: 1, skipped: 0 },
  existingTotal: 10, totalAfter: 13,
  rows: [{ key: 'r1', label: '就醫紀錄', incoming: 3, added: 2, updated: 1, skipped: 0 }],
  resourceTypes: [],
  attachments: { reports: 1, imagingReports: 1, total: 2, previewable: 2, external: 0, references: 0, unsupported: [] },
  warnings: [], ...overrides,
});
const preparedJson = (needsConfirmation = false) => ({ preview: previewOf({ needsConfirmation }), needsConfirmation } as never);
const largePreview = (needsConfirmation: boolean) => ({
  file: new File(['{}'], 'synthetic-large.json'), existing: {} as never, previous: null,
  format: 'FHIR' as const, needsConfirmation,
  preview: previewOf({
    fileName: 'synthetic-large.json', format: 'FHIR', estimated: true, needsConfirmation,
    totalAfter: null, counts: { incoming: 5 },
  }),
});
const loaded = () => ({ data: { importHistory: [] }, envelope: { revision: 'synthetic' }, result: { message: 'ok', stats: {} } });
function enterPassword() { fireEvent.change(screen.getByLabelText('資料加密密碼'), { target: { value: 'synthetic-passphrase' } }); }

describe('pre-import preview gate', () => {
  it('shows the date range, record counts and attachments before anything is written', async () => {
    const callbacks = props();
    vi.mocked(prepareJsonImport).mockResolvedValue(preparedJson());
    vi.mocked(commitPreparedJsonImport).mockResolvedValue(loaded() as never);
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectFile(container);
    await screen.findByRole('button', { name: '確認匯入' });
    expect(screen.getByText(/2020-01-01/)).toBeTruthy();
    expect(screen.getByText('就醫紀錄')).toBeTruthy();
    expect(screen.getByText(/含影像／附件的報告：1 份/)).toBeTruthy();
    expect(commitPreparedJsonImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '確認匯入' }));
    await waitFor(() => expect(callbacks.onLoad).toHaveBeenCalled());
    expect(commitPreparedJsonImport).toHaveBeenCalledWith(
      expect.objectContaining({ preview: expect.objectContaining({ fileName: 'synthetic.json' }) }),
      'synthetic-passphrase', false, expect.any(AbortSignal),
    );
    expect(callbacks.onEnvelopeSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 'synthetic' }));
  });

  it('requires an unchecked same-patient checkbox before committing', async () => {
    const callbacks = props();
    vi.mocked(prepareJsonImport).mockResolvedValue(preparedJson(true));
    vi.mocked(commitPreparedJsonImport).mockResolvedValue(loaded() as never);
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectFile(container);
    const confirm = await screen.findByRole('button', { name: '確認匯入' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(confirm);
    await waitFor(() => expect(commitPreparedJsonImport).toHaveBeenCalledWith(
      expect.any(Object), 'synthetic-passphrase', true, expect.any(AbortSignal),
    ));
  });

  it('clears consent for each replacement file and cancels without saving', async () => {
    const callbacks = props();
    vi.mocked(prepareJsonImport).mockResolvedValue(preparedJson(true));
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectFile(container);
    fireEvent.click(await screen.findByRole('checkbox'));
    selectFile(container, '{"r1":[{"synthetic":true}]}');
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '取消匯入' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(prepareJsonImport).toHaveBeenCalledTimes(2);
    expect(commitPreparedJsonImport).not.toHaveBeenCalled();
    expect(callbacks.onLoad).not.toHaveBeenCalled();
  });

  it('returns to the preview when the server still requires patient confirmation', async () => {
    vi.mocked(prepareJsonImport).mockResolvedValue(preparedJson());
    vi.mocked(commitPreparedJsonImport).mockRejectedValue(new PatientConfirmationRequired());
    const { container } = render(<FileLoader {...props()} />);
    enterPassword();
    selectFile(container);
    fireEvent.click(await screen.findByRole('button', { name: '確認匯入' }));
    await screen.findByText('病人身分仍需確認，請勾選確認後再匯入');
    expect(screen.getByRole('button', { name: '確認匯入' })).toBeTruthy();
  });

  it('aborts pending preparation and never loads data after unmount', async () => {
    const callbacks = props();
    const { container, unmount } = render(<FileLoader {...callbacks} />);
    enterPassword();
    vi.mocked(prepareJsonImport).mockImplementation(() => new Promise(() => {}));
    selectFile(container);
    await waitFor(() => expect(prepareJsonImport).toHaveBeenCalledOnce());
    const signal = vi.mocked(prepareJsonImport).mock.calls[0][3]!;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(callbacks.onLoad).not.toHaveBeenCalled();
  });

  it('does not expose JSON parser input fragments or call a service for malformed data', async () => {
    const { container } = render(<FileLoader {...props()} />);
    enterPassword();
    selectFile(container, 'synthetic-invalid-json');
    await screen.findByText('JSON 格式無法解析，請重新匯出原始檔案');
    expect(prepareJsonImport).not.toHaveBeenCalled();
    expect(unlockHealthData).not.toHaveBeenCalled();
    expect(migrateHealthData).not.toHaveBeenCalled();
    expect(screen.queryByText(/synthetic-invalid-json/)).toBeNull();
  });
});

describe('streaming import of oversized files', () => {
  it('previews the scanned summary and only streams after confirmation', async () => {
    const callbacks = props();
    const preview = largePreview(false);
    vi.mocked(prepareLargeImport).mockResolvedValue(preview);
    vi.mocked(commitLargeImport).mockImplementation(async (_preview, _passphrase, _confirmed, _signal, onProgress) => {
      onProgress!(0.5);
      return loaded() as never;
    });
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectOversizedFile(container);
    fireEvent.click(await screen.findByRole('button', { name: '確認匯入' }));
    await waitFor(() => expect(callbacks.onLoad).toHaveBeenCalled());
    expect(prepareLargeImport).toHaveBeenCalledWith(expect.objectContaining({ name: 'synthetic-large.json' }), 'synthetic-passphrase', expect.any(AbortSignal), expect.any(Function));
    expect(commitLargeImport).toHaveBeenCalledWith(preview, 'synthetic-passphrase', false, expect.any(AbortSignal), expect.any(Function));
    expect(commitPreparedJsonImport).not.toHaveBeenCalled();
    expect(callbacks.onEnvelopeSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 'synthetic' }));
  });

  it('asks for patient consent before streaming an unverifiable oversized file', async () => {
    const callbacks = props();
    const preview = largePreview(true);
    vi.mocked(prepareLargeImport).mockResolvedValue(preview);
    vi.mocked(commitLargeImport).mockResolvedValue(loaded() as never);
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectOversizedFile(container);
    const confirm = await screen.findByRole('button', { name: '確認匯入' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(commitLargeImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(confirm);
    await waitFor(() => expect(commitLargeImport).toHaveBeenCalledWith(preview, 'synthetic-passphrase', true, expect.any(AbortSignal), expect.any(Function)));
    await waitFor(() => expect(callbacks.onLoad).toHaveBeenCalled());
  });

  it('shows a streaming error without saving anything', async () => {
    const callbacks = props();
    vi.mocked(prepareLargeImport).mockRejectedValue(new Error('病歷文字內容超過 8 GiB 上限'));
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectOversizedFile(container);
    await screen.findByText('病歷文字內容超過 8 GiB 上限');
    expect(commitLargeImport).not.toHaveBeenCalled();
    expect(callbacks.onLoad).not.toHaveBeenCalled();
  });
});
