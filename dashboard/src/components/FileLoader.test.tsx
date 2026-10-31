import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileLoader from './FileLoader';
import { commitLargeImport, importHealthData, migrateHealthData, prepareLargeImport, unlockHealthData } from '../importHealthData';
import { PatientConfirmationRequired } from '../recordImport';

vi.mock('../importHealthData', () => ({ importHealthData: vi.fn(), unlockHealthData: vi.fn(), migrateHealthData: vi.fn(), prepareLargeImport: vi.fn(), commitLargeImport: vi.fn() }));
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
const largePreview = (needsConfirmation: boolean) => ({
  file: new File(['{}'], 'synthetic-large.json'), existing: {} as never, previous: null,
  format: 'FHIR' as const, needsConfirmation,
});
const loaded = () => ({ data: { importHistory: [] }, envelope: { revision: 'synthetic' }, result: { message: 'ok', stats: {} } });
function enterPassword() { fireEvent.change(screen.getByLabelText('資料加密密碼'), { target: { value: 'synthetic-passphrase' } }); }

describe('explicit same-patient confirmation flow', () => {
  it('requires an unchecked consent checkbox and reruns validation after confirmation', async () => {
    const callbacks = props();
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    vi.mocked(importHealthData).mockRejectedValueOnce(new PatientConfirmationRequired()).mockRejectedValueOnce(new Error('不同的病人，無法合併'));
    selectFile(container);
    const confirm = await screen.findByRole('button', { name: '確認並匯入' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const checkbox = screen.getByRole('checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
    fireEvent.click(checkbox);
    fireEvent.click(confirm);
    await screen.findByText('不同的病人，無法合併');
    expect(importHealthData).toHaveBeenNthCalledWith(1, expect.any(Object), 'synthetic-passphrase', false, expect.any(AbortSignal));
    expect(importHealthData).toHaveBeenNthCalledWith(2, expect.any(Object), 'synthetic-passphrase', true, expect.any(AbortSignal));
    expect(callbacks.onLoad).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });
  it('clears consent for each replacement file and permits cancellation without saving', async () => {
    const { container } = render(<FileLoader {...props()} />);
    enterPassword();
    vi.mocked(importHealthData).mockRejectedValue(new PatientConfirmationRequired());
    selectFile(container);
    fireEvent.click(await screen.findByRole('checkbox'));
    selectFile(container, '{"r1":[{"synthetic":true}]}');
    await waitFor(() => expect((screen.getByRole('checkbox') as HTMLInputElement).checked).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: '取消匯入' }));
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(importHealthData).toHaveBeenCalledTimes(2);
  });
  it('aborts pending operations and cannot reload old-patient data after unmount', async () => {
    const callbacks = props();
    const { container, unmount } = render(<FileLoader {...callbacks} />);
    enterPassword();
    vi.mocked(importHealthData).mockImplementation(() => new Promise(() => {}));
    selectFile(container);
    await waitFor(() => expect(importHealthData).toHaveBeenCalledOnce());
    const signal = vi.mocked(importHealthData).mock.calls[0][3]!;
    unmount();
    expect(signal.aborted).toBe(true);
    expect(callbacks.onLoad).not.toHaveBeenCalled();
  });
  it('does not expose JSON parser input fragments or call a service for malformed data', async () => {
    const { container } = render(<FileLoader {...props()} />);
    enterPassword();
    selectFile(container, 'synthetic-invalid-json');
    await screen.findByText('JSON 格式無法解析，請重新匯出原始檔案');
    expect(importHealthData).not.toHaveBeenCalled();
    expect(unlockHealthData).not.toHaveBeenCalled();
    expect(migrateHealthData).not.toHaveBeenCalled();
    expect(screen.queryByText(/synthetic-invalid-json/)).toBeNull();
  });
});

describe('streaming import of oversized files', () => {
  it('streams files above the inline limit instead of reading them into memory', async () => {
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
    await waitFor(() => expect(callbacks.onLoad).toHaveBeenCalled());
    expect(prepareLargeImport).toHaveBeenCalledWith(expect.objectContaining({ name: 'synthetic-large.json' }), 'synthetic-passphrase', expect.any(AbortSignal), expect.any(Function));
    expect(commitLargeImport).toHaveBeenCalledWith(preview, 'synthetic-passphrase', false, expect.any(AbortSignal), expect.any(Function));
    expect(importHealthData).not.toHaveBeenCalled();
    expect(callbacks.onEnvelopeSaved).toHaveBeenCalledWith(expect.objectContaining({ revision: 'synthetic' }));
  });
  it('asks for patient consent before streaming an unverifiable oversized file', async () => {
    const callbacks = props();
    const preview = largePreview(true);
    vi.mocked(prepareLargeImport).mockResolvedValue(preview);
    vi.mocked(commitLargeImport).mockResolvedValueOnce(loaded() as never).mockRejectedValueOnce(new PatientConfirmationRequired());
    const { container } = render(<FileLoader {...callbacks} />);
    enterPassword();
    selectOversizedFile(container);
    const confirm = await screen.findByRole('button', { name: '確認並匯入' });
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
