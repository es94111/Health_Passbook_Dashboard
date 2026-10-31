import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEncryptedAttachment, type ClientEncryptedRecords } from './api';
import { deriveVaultKey, encryptRecords, encryptWithVaultKey } from './cryptoVault';
import { base64ToBytes } from './medicalAttachments';
import { mergeNHIJson } from './recordImport';
import { emptyRecords } from './recordStore';
import { SYNTHETIC_PNG, syntheticBundle } from './test/fixtures';
import { createVaultSession } from './vaultSession';

vi.mock('./api', () => ({ fetchEncryptedAttachment: vi.fn() }));
const originalURL = globalThis.URL;
const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() => 'blob:synthetic-download');
const revokeObjectURL = vi.fn();
class DownloadURL extends originalURL {
  static createObjectURL = createObjectURL;
  static revokeObjectURL = revokeObjectURL;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('URL', DownloadURL);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  if (vi.isFakeTimers()) vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.stubGlobal('URL', originalURL);
});
async function fixture() {
  const input = syntheticBundle([{ resourceType: 'DiagnosticReport', id: 'synthetic-report', presentedForm: [
    { contentType: 'image/png', data: SYNTHETIC_PNG },
    { contentType: 'image/png', data: SYNTHETIC_PNG, size: base64ToBytes(SYNTHETIC_PNG).length },
  ] }]);
  const { records, pendingAttachments } = await mergeNHIJson(emptyRecords(), input);
  const passphrase = 'synthetic-vault-passphrase';
  const envelope = await encryptRecords(records, passphrase);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const encrypted = new Map<string, ClientEncryptedRecords>();
  for (const attachment of pendingAttachments) encrypted.set(attachment.id, await encryptWithVaultKey(base64ToBytes(attachment.data), key, envelope));
  vi.mocked(fetchEncryptedAttachment).mockImplementation(async id => {
    const attachment = encrypted.get(id);
    if (!attachment) throw new Error('synthetic attachment missing');
    return { envelope: attachment };
  });
  return { input, records, envelope, key, encrypted, session: createVaultSession(records, envelope, key) };
}
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('vault source reconstruction and integrity', () => {
  it('reconstructs original attachment data and size fields, reads duplicate bytes once, and revokes its download URL', async () => {
    const { input, records, session } = await fixture();
    vi.useFakeTimers();
    await session.downloadSource!(Object.keys(records.sources)[0]);
    expect(fetchEncryptedAttachment).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    const result = blobText(blob);
    await vi.runAllTimersAsync();
    expect(JSON.parse(await result)).toEqual(input);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-download');
    expect(document.querySelector('a[download]')).toBeNull();
  });
  it('refuses a modified archived source instead of downloading unverifiable content', async () => {
    const { records, envelope, key } = await fixture();
    const sourceId = Object.keys(records.sources)[0];
    records.sources[sourceId].data.timestamp = '2026-10-31T08:00:00Z';
    await expect(createVaultSession(records, envelope, key).downloadSource!(sourceId)).rejects.toThrow('來源檔完整性');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('does not produce a partial download when an encrypted attachment is missing', async () => {
    const { records, session } = await fixture();
    vi.mocked(fetchEncryptedAttachment).mockRejectedValue(new Error('synthetic attachment missing'));
    await expect(session.downloadSource!(Object.keys(records.sources)[0])).rejects.toThrow('missing');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects attachment parameter substitution and mismatched encrypted hashes', async () => {
    const { records, envelope, key, encrypted, session } = await fixture();
    const descriptor = session.medicalReports[0].attachments[0];
    const attachment = [...encrypted.values()][0];
    vi.mocked(fetchEncryptedAttachment).mockResolvedValue({ envelope: { ...attachment, salt: envelope.salt + 'AAAA' } });
    await expect(session.loadAttachment!(descriptor)).rejects.toThrow('參數');
    vi.mocked(fetchEncryptedAttachment).mockResolvedValue({ envelope: attachment });
    records.attachments[descriptor.id!].digest = '0'.repeat(64);
    await expect(createVaultSession(records, envelope, key).loadAttachment!(descriptor)).rejects.toThrow('完整性');
    expect(createObjectURL).not.toHaveBeenCalled();
  });
  it('rejects an attachment descriptor not matching the encrypted index', async () => {
    const { session } = await fixture();
    await expect(session.loadAttachment!({ ...session.medicalReports[0].attachments[0], contentType: 'application/pdf' })).rejects.toThrow('類型');
    expect(fetchEncryptedAttachment).not.toHaveBeenCalled();
  });
});
