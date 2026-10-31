import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FileLoader from './FileLoader';
import { importHealthData, unlockHealthData, migrateHealthData } from '../importHealthData';
import { PatientConfirmationRequired } from '../recordImport';

vi.mock('../importHealthData', () => ({ importHealthData: vi.fn(), unlockHealthData: vi.fn(), migrateHealthData: vi.fn() }));
afterEach(cleanup);
beforeEach(() => vi.resetAllMocks());
const props = () => ({ storedEnvelope: null, needsClientEncryptionMigration: false, onEnvelopeSaved: vi.fn(), onLoad: vi.fn() });
function selectFile(container: HTMLElement, json = '{"r1":[{}]}') {
  const file = new File([json], 'synthetic.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => json });
  fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
}
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
