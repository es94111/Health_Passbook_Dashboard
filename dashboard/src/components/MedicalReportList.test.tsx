import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MedicalAttachment, MedicalReport } from '../parsers/types';
import MedicalReportList from './MedicalReportList';
import type { AttachmentLoader } from './MedicalAttachmentItem';

const report = (overrides: Partial<MedicalReport> = {}): MedicalReport => ({
  id: 'report-1', date: null, hospital: '甲醫院', title: '胸部報告', text: '未見明顯異常',
  attachments: [{ id: 'attachment-1', title: '胸部影像', contentType: 'image/jpeg' }],
  relatedResources: ['Observation/o1', 'ImagingStudy/i1'], externalAttachmentCount: 0,
  kind: 'general',
  rawResource: { resourceType: 'DiagnosticReport', id: 'report-1' },
  origins: [{ format: 'FHIR', resourceType: 'DiagnosticReport', id: 'report-1', source: 'import-a' }], ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

const NativeURL = URL;
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
const network = vi.fn();
const downloads: { href: string; filename: string }[] = [];

beforeEach(() => {
  createObjectURL.mockReset().mockImplementation(() => `blob:medical-${createObjectURL.mock.calls.length}`);
  revokeObjectURL.mockReset();
  network.mockReset();
  downloads.length = 0;
  vi.stubGlobal('fetch', network);
  vi.stubGlobal('URL', class extends NativeURL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ href: this.href, filename: this.download });
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MedicalReportList attachments', () => {
  it('reads stored images only after a preview click and revokes the URL on hide', async () => {
    const pending = deferred<Blob>();
    const loader = vi.fn<AttachmentLoader>().mockReturnValue(pending.promise);
    const item = report();
    render(<MedicalReportList reports={[item]} loadAttachment={loader} />);
    expect(loader).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    expect(loader).toHaveBeenCalledWith(item.attachments[0]);
    expect(screen.getByRole('button', { name: '胸部影像：圖片載入中…' }).getAttribute('aria-busy')).toBe('true');
    expect(screen.getByRole('button', { name: '胸部影像：下載圖片' }).hasAttribute('disabled')).toBe(false);
    await act(async () => pending.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })));
    expect(screen.getByRole('img', { name: '胸部影像' }).getAttribute('src')).toBe('blob:medical-1');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：隱藏預覽' }));
    expect(screen.queryByRole('img')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    expect(network).not.toHaveBeenCalled();
  });

  it.each(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp'] as const)('supports on-demand legacy inline %s previews', async contentType => {
    const loader = vi.fn<AttachmentLoader>();
    render(<MedicalReportList reports={[report({ attachments: [{ title: '本機影像', contentType, data: btoa('image-bytes') }] })]} loadAttachment={loader} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '本機影像：預覽圖片' }));
    await screen.findByRole('img', { name: '本機影像' });
    expect(createObjectURL.mock.calls[0][0]).toMatchObject({ type: contentType, size: 11 });
    expect(loader).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('offers PDF download only and cleans up pending download URLs on unmount', async () => {
    const loader = vi.fn<AttachmentLoader>().mockResolvedValue(new Blob(['%PDF-'], { type: 'application/pdf' }));
    const { container, unmount } = render(<MedicalReportList reports={[report({ attachments: [{ id: 'pdf-1', title: '報告 PDF', contentType: 'application/pdf' }] })]} loadAttachment={loader} />);
    expect(loader).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /預覽圖片/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '報告 PDF：下載 PDF' }));
    await waitFor(() => expect(downloads).toEqual([{ href: 'blob:medical-1', filename: 'medical-attachment.pdf' }]));
    expect(container.querySelector('iframe, object, embed, img')).toBeNull();
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    expect(network).not.toHaveBeenCalled();
  });

  it('releases completed download URLs without needing unmount', async () => {
    vi.useFakeTimers();
    const loader = vi.fn<AttachmentLoader>().mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
    const { unmount } = render(<MedicalReportList reports={[report({ attachments: [{ id: 'png-1', title: '影像', contentType: 'image/png' }] })]} loadAttachment={loader} />);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '影像：下載圖片' })));
    expect(downloads[0].filename).toBe('medical-attachment.png');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1000));
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not load unsupported attachments or external URLs and renders raw resources as text', () => {
    const loader = vi.fn<AttachmentLoader>();
    const unsupported = { id: 'svg', title: '不支援', contentType: 'image/svg+xml' } as unknown as MedicalAttachment;
    const { container } = render(<MedicalReportList reports={[report({ attachments: [unsupported], externalAttachmentCount: 2,
      relatedResources: ['https://external.example/Observation/o1'],
      rawResource: { url: 'https://external.example/report.pdf', text: '<script>not executable</script>' },
    })]} loadAttachment={loader} />);
    expect(screen.getByText(/另有 2 個外部附件/)).toBeTruthy();
    expect(screen.getByText(/不支援此附件格式/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    fireEvent.click(screen.getByText('原始資源與來源'));
    expect(screen.getByText('https://external.example/Observation/o1')).toBeTruthy();
    expect(container.querySelector('pre')?.textContent).toContain('<script>not executable</script>');
    expect(container.querySelector('a, iframe, object, embed, img, script')).toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('shows generic independent errors and allows preview retry after a successful download', async () => {
    const loader = vi.fn<AttachmentLoader>()
      .mockRejectedValueOnce(new Error('private patient detail https://secret.example'))
      .mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    expect((await screen.findByRole('alert')).textContent).toContain('無法預覽此附件');
    expect(screen.queryByText(/private patient detail/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：下載圖片' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(screen.getByRole('alert').textContent).toContain('無法預覽此附件');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：重試預覽' }));
    await screen.findByRole('img');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it.each(['text/html', 'application/pdf', 'image/png'])('rejects a returned %s Blob for a declared JPEG', async contentType => {
    const loader = vi.fn<AttachmentLoader>().mockResolvedValue(new Blob(['mismatched'], { type: contentType }));
    render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('img')).toBeNull();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('keeps an existing preview visible while a failed download is retried independently', async () => {
    const image = new Blob(['jpeg'], { type: 'image/jpeg' });
    const loader = vi.fn<AttachmentLoader>().mockResolvedValueOnce(image)
      .mockRejectedValueOnce(new Error('private download detail')).mockResolvedValue(image);
    render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：下載圖片' }));
    expect((await screen.findByRole('alert')).textContent).toContain('無法下載此附件');
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:medical-1');
    expect(screen.queryByText(/private download detail/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：重試下載' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('img').getAttribute('src')).toBe('blob:medical-1');
  });

  it('cleans up failed image previews and the retried preview on unmount', async () => {
    const loader = vi.fn<AttachmentLoader>().mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
    const { unmount } = render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    fireEvent.error(await screen.findByRole('img'));
    expect(screen.queryByRole('img')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：重試預覽' }));
    await screen.findByRole('img');
    unmount();
    expect(revokeObjectURL.mock.calls).toEqual([['blob:medical-1'], ['blob:medical-2']]);
    expect(network).not.toHaveBeenCalled();
  });

  it('clears a preview and cancels an in-flight download when the loader changes', async () => {
    const pending = deferred<Blob>();
    const previousLoader = vi.fn<AttachmentLoader>().mockResolvedValueOnce(new Blob(['old'], { type: 'image/jpeg' }))
      .mockReturnValue(pending.promise);
    const nextLoader = vi.fn<AttachmentLoader>();
    const reports = [report()];
    const { rerender } = render(<MedicalReportList reports={reports} loadAttachment={previousLoader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    await screen.findByRole('img');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：下載圖片' }));
    rerender(<MedicalReportList reports={reports} loadAttachment={nextLoader} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    await act(async () => pending.resolve(new Blob(['stale'], { type: 'image/jpeg' })));
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(downloads).toEqual([]);
    expect(nextLoader).not.toHaveBeenCalled();
  });

  it('removes an old preview immediately when attachment props change and ignores stale requests', async () => {
    const pending = deferred<Blob>();
    const loader = vi.fn<AttachmentLoader>().mockResolvedValueOnce(new Blob(['old'], { type: 'image/jpeg' })).mockReturnValue(pending.promise);
    const { rerender, unmount } = render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    await screen.findByRole('img');
    rerender(<MedicalReportList reports={[report({ text: '新來源內容' })]} loadAttachment={loader} />);
    expect(screen.queryByRole('img')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:medical-1');
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    rerender(<MedicalReportList reports={[report({ id: 'another-patient' })]} loadAttachment={loader} />);
    await act(async () => pending.resolve(new Blob(['stale'], { type: 'image/jpeg' })));
    expect(screen.queryByRole('img')).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('does not create preview or download URLs for requests finishing after unmount', async () => {
    const pending = deferred<Blob>();
    const loader = vi.fn<AttachmentLoader>().mockReturnValue(pending.promise);
    const { unmount } = render(<MedicalReportList reports={[report()]} loadAttachment={loader} />);
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：預覽圖片' }));
    fireEvent.click(screen.getByRole('button', { name: '胸部影像：下載圖片' }));
    expect(loader).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => pending.resolve(new Blob(['jpeg'], { type: 'image/jpeg' })));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
  });

  it('keeps unknown dates and report/source relationships searchable without remote links', () => {
    render(<MedicalReportList reports={[report({ attachments: [] }), report({ id: 'report-2', title: '其他報告', date: new Date('2025-01-01'), attachments: [] })]} />);
    expect(screen.getByText(/日期未提供/)).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: '搜尋醫療報告' }), { target: { value: 'ImagingStudy/i1' } });
    const article = screen.getByRole('article', { name: '胸部報告' });
    fireEvent.click(within(article).getByText('原始資源與來源'));
    expect(within(article).getByText('ImagingStudy/i1')).toBeTruthy();
    expect(within(article).getByText(/import-a/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });
});
