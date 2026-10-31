import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ImportPreview from './ImportPreview';
import { formatBytes } from '../lib/bytes';
import type { ImportPreview as Preview } from '../importPreview';

afterEach(cleanup);

function preview(overrides: Partial<Preview> = {}): Preview {
  return {
    fileName: 'synthetic.json', fileSize: 2048, format: 'FHIR', estimated: false, needsConfirmation: false,
    from: '2024-01-02', to: '2025-05-06',
    counts: { incoming: 3, added: 2, updated: 0, skipped: 1 },
    existingTotal: 4, totalAfter: 6,
    rows: [{ key: 'fhir', label: 'FHIR 資源', incoming: 3, added: 2, updated: 0, skipped: 1 }],
    resourceTypes: [{ type: 'Observation', label: '檢驗檢查', count: 2 }],
    attachments: { reports: 1, imagingReports: 1, total: 2, previewable: 1, external: 1, references: 0, unsupported: ['application/dicom'] },
    warnings: ['略過 1 筆重複資料'],
    ...overrides,
  };
}

function renderPreview(overrides: Partial<Preview> = {}, props: Partial<Parameters<typeof ImportPreview>[0]> = {}) {
  const handlers = { onIdentityConfirmed: vi.fn(), onConfirm: vi.fn(), onCancel: vi.fn() };
  const view = render(
    <ImportPreview
      preview={preview(overrides)}
      identityConfirmed={false}
      blocked={false}
      {...handlers}
      {...props}
    />,
  );
  return { ...view, ...handlers };
}

describe('ImportPreview', () => {
  it('shows the file, date range, record counts and attachment summary', () => {
    renderPreview();
    expect(screen.getByText(/synthetic\.json/)).toBeTruthy();
    expect(screen.getByText('2.0 KB', { exact: false })).toBeTruthy();
    expect(screen.getByText('2024-01-02 ～ 2025-05-06')).toBeTruthy();
    expect(screen.getByText('3 筆')).toBeTruthy();
    expect(screen.getByText('4 筆')).toBeTruthy();
    expect(screen.getByText('6 筆')).toBeTruthy();
    expect(screen.getByText('新增 2')).toBeTruthy();
    expect(screen.getByText('更新 0')).toBeTruthy();
    expect(screen.getByText('略過（已存在） 1')).toBeTruthy();
    expect(screen.getByText('含影像／附件的報告：1 份')).toBeTruthy();
    expect(screen.getByText('影像類報告：1 份')).toBeTruthy();
    expect(screen.getByText('內嵌附件：2 個（可預覽 1 個）')).toBeTruthy();
    expect(screen.getByText('外部連結附件（不下載內容）：1 個')).toBeTruthy();
    expect(screen.getByText('瀏覽器無法預覽的格式：application/dicom')).toBeTruthy();
    expect(screen.getByText('・略過 1 筆重複資料')).toBeTruthy();
    expect(screen.getByText('檢驗檢查 2')).toBeTruthy();
    expect(screen.getByText('FHIR R4 Bundle・精確統計')).toBeTruthy();
  });

  it('hides added and skipped counts when only a streaming estimate is available', () => {
    renderPreview({
      estimated: true, totalAfter: null, counts: { incoming: 3 },
      rows: [{ key: 'Observation', label: '檢驗檢查', incoming: 3 }],
      attachments: { reports: 0, imagingReports: 0, total: 0, previewable: 0, external: 0, references: 0, unsupported: [] },
      warnings: [],
    });
    expect(screen.getByText('FHIR R4 Bundle・大型檔案串流估算')).toBeTruthy();
    expect(screen.getByText('匯入後計算')).toBeTruthy();
    expect(screen.getByText('以串流掃描估算，實際以匯入結果為準')).toBeTruthy();
    expect(screen.queryByText(/^新增 /)).toBeNull();
    expect(screen.queryByText(/^略過/)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: '新增' })).toBeNull();
    expect(screen.getByText('這份檔案沒有內嵌影像或附件。')).toBeTruthy();
  });

  it('requires the identity checkbox before confirming a file that cannot be verified', () => {
    const { onConfirm, onIdentityConfirmed } = renderPreview({ needsConfirmation: true });
    const confirm = screen.getByRole('button', { name: '確認匯入' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: /我已核對/ }));
    expect(onIdentityConfirmed).toHaveBeenCalledWith(true);
    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('confirms immediately when the file needs no identity confirmation', () => {
    const { onConfirm } = renderPreview();
    const confirm = screen.getByRole('button', { name: '確認匯入' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('keeps confirm disabled but still allows cancelling while the passphrase is too short', () => {
    const { onCancel } = renderPreview({}, { blocked: true });
    expect((screen.getByRole('button', { name: '確認匯入' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('請先輸入符合長度要求的資料加密密碼。')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消匯入' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('describes files without any recognisable date', () => {
    renderPreview({ from: null, to: null });
    expect(screen.getByText('檔案沒有可辨識的日期')).toBeTruthy();
  });
});

describe('formatBytes', () => {
  it('formats each size range', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 ** 2)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB');
  });
});
