import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKUP_BYTES,
  importBackup,
  prepareBackup,
  readBackupHeader,
  startBackupDownload,
} from './api';

const header = '{"format":"health-passbook-backup","version":1,"exportedAt":"2026-10-31T00:00:00.000Z","data":';
const stats = { users: 1, settings: true, loginLogs: 2, recordsRestored: 3, orphanRecordsDeleted: 0, warnings: [] as string[] };

class FakeXhr {
  static last: FakeXhr | undefined;
  method = '';
  url = '';
  withCredentials = false;
  status = 0;
  responseText = '';
  headers: Record<string, string> = {};
  sent: Blob | null = null;
  aborted = false;
  upload: { onprogress: ((event: { loaded: number; lengthComputable: boolean; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;

  constructor() { FakeXhr.last = this; }
  open(method: string, url: string) { this.method = method; this.url = url; }
  setRequestHeader(name: string, value: string) { this.headers[name] = value; }
  send(body: Blob) { this.sent = body; }
  abort() { this.aborted = true; this.onabort?.(); }
  finish(status: number, payload: unknown) {
    this.status = status;
    this.responseText = JSON.stringify(payload);
    this.onload?.();
  }
}

function useFakeXhr() {
  const original = globalThis.XMLHttpRequest;
  (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = FakeXhr;
  return () => { (globalThis as unknown as { XMLHttpRequest: unknown }).XMLHttpRequest = original; };
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('streaming backup transfer', () => {
  it('raises the whole-backup ceiling to 20 GB', () => {
    expect(MAX_BACKUP_BYTES).toBe(20_000_000_000);
  });

  it('reads only the head of a huge backup when previewing it', async () => {
    const file = new Blob([header, 'x'.repeat(64 * 1024)], { type: 'application/json' });
    const slice = vi.spyOn(file, 'slice');
    expect(await readBackupHeader(file)).toEqual({
      format: 'health-passbook-backup',
      version: 1,
      exportedAt: '2026-10-31T00:00:00.000Z',
    });
    expect(slice).toHaveBeenCalledWith(0, 8192);
    expect(await readBackupHeader(new Blob(['\uFEFF{"format":"legacy"}']))).toEqual({
      format: 'legacy',
      version: null,
      exportedAt: null,
    });
  });

  it('asks the server to stage the export and surfaces its limit message', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ downloadUrl: '/api/admin/backup/download/tok', filename: 'backup.json', bytes: 12 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(prepareBackup('secret')).resolves.toEqual({
      downloadUrl: '/api/admin/backup/download/tok',
      filename: 'backup.json',
      bytes: 12,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/backup/export?prepare=true');

    const tooLarge = new Response(JSON.stringify({ error: '備份檔案超過 20 GB' }), { status: 413 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(tooLarge));
    await expect(prepareBackup('secret')).rejects.toThrow('備份檔案超過 20 GB');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed')));
    await expect(prepareBackup('secret')).rejects.toThrow('無法連線至伺服器');
  });

  it('uploads the original file and reports progress without buffering a copy', async () => {
    const restore = useFakeXhr();
    try {
      const progress = vi.fn();
      const file = new File([header], 'backup.json', { type: 'application/json' });
      const upload = importBackup(file, progress);
      const xhr = FakeXhr.last!;
      expect(xhr.method).toBe('POST');
      expect(xhr.url).toBe('/api/admin/backup/import?confirm=true');
      expect(xhr.withCredentials).toBe(true);
      expect(xhr.sent).toBe(file);

      xhr.upload.onprogress?.({ loaded: 1024, lengthComputable: false, total: 0 });
      expect(progress).toHaveBeenCalledWith(1024, file.size);

      xhr.status = 200;
      xhr.responseText = JSON.stringify({ message: '已還原', stats });
      xhr.onload?.();
      await expect(upload.promise).resolves.toEqual({ message: '已還原', stats });
    } finally {
      restore();
    }
  });

  it('reports a rejected restore with the server error instead of a generic failure', async () => {
    const restore = useFakeXhr();
    try {
      const upload = importBackup(new File([header], 'backup.json'));
      FakeXhr.last!.finish(400, { error: '備份 JSON 格式錯誤或檔案不完整' });
      await expect(upload.promise).rejects.toThrow('備份 JSON 格式錯誤或檔案不完整');
    } finally {
      restore();
    }
  });

  it('cancels an in-flight restore and tells the user nothing changed', async () => {
    const restore = useFakeXhr();
    try {
      const upload = importBackup(new File([header], 'backup.json'));
      upload.cancel();
      expect(FakeXhr.last?.aborted).toBe(true);
      await expect(upload.promise).rejects.toThrow('已取消還原，現有資料未被變更');
    } finally {
      restore();
    }
  });

  it('hands the prepared file to the browser as a native download', () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    startBackupDownload({ downloadUrl: '/api/admin/backup/download/tok', filename: 'backup.json', bytes: 1 });
    expect(click).toHaveBeenCalledTimes(1);
    expect(document.querySelector('a')).toBeNull();
  });
});
