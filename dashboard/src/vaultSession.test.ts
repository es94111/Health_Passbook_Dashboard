import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import { decryptRecords, deriveVaultKey, encryptRecords, encryptWithVaultKey } from './cryptoVault';
import { base64ToBytes } from './medicalAttachments';
import { emptyPersonal, newPersonalId, type PersonalData } from './personalData';
import { mergeNHIJson } from './recordImport';
import { emptyRecords } from './recordStore';
import { canonicalJson, sha256 } from './parsers/fhir-common';
import { SYNTHETIC_PNG, syntheticBundle } from './test/fixtures';
import { createVaultSession } from './vaultSession';

vi.mock('./api', async importOriginal => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchEncryptedAttachment: vi.fn(),
  uploadEncryptedAttachment: vi.fn(),
  uploadEncryptedHealthData: vi.fn(),
}));
const originalURL = globalThis.URL;
const createObjectURL = vi.fn<(blob: Blob | MediaSource) => string>(() => 'blob:synthetic-download');
const revokeObjectURL = vi.fn();
class DownloadURL extends originalURL {
  static createObjectURL = createObjectURL;
  static revokeObjectURL = revokeObjectURL;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(uploadEncryptedHealthData).mockResolvedValue({ message: 'ok', stats: {} });
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

async function chunkedFixture() {
  const passphrase = 'synthetic-vault-passphrase';
  const base = emptyRecords();
  const envelope = await encryptRecords(base, passphrase);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const bytes = new TextEncoder().encode(JSON.stringify(syntheticBundle()));
  const parts = [bytes.subarray(0, 40), bytes.subarray(40)];
  const encrypted = new Map<string, ClientEncryptedRecords>();
  const chunks = [];
  for (const part of parts) {
    const id = crypto.randomUUID();
    chunks.push({ id, digest: await sha256(part), size: part.length });
    encrypted.set(id, await encryptWithVaultKey(part, key, envelope));
  }
  const sourceId = await sha256(canonicalJson({ format: 'FHIR', chunks }));
  const records = { ...base, sources: { [sourceId]: { format: 'FHIR' as const, chunks } } };
  vi.mocked(fetchEncryptedAttachment).mockImplementation(async id => {
    const attachment = encrypted.get(id);
    if (!attachment) throw new Error('synthetic chunk missing');
    return { envelope: attachment };
  });
  return { bytes, chunks, sourceId, envelope, key, records, session: createVaultSession(records, envelope, key) };
}

describe('vault source reconstruction and integrity', () => {
  it('reassembles an oversized source from independently encrypted chunks', async () => {
    const { bytes, sourceId, session } = await chunkedFixture();
    vi.useFakeTimers();
    await session.downloadSource!(sourceId);
    expect(fetchEncryptedAttachment).toHaveBeenCalledTimes(2);
    const blob = createObjectURL.mock.calls[0][0] as unknown as Blob;
    expect(blob.size).toBe(bytes.length);
    const result = blobText(blob);
    await vi.runAllTimersAsync();
    expect(JSON.parse(await result)).toEqual(syntheticBundle());
    expect(createObjectURL).toHaveBeenCalledOnce();
  });
  it('refuses a chunked source whose index or chunk bytes were altered', async () => {
    const { chunks, sourceId, envelope, key, records, session } = await chunkedFixture();
    chunks[1].digest = '0'.repeat(64);
    await expect(createVaultSession(records, envelope, key).downloadSource!(sourceId)).rejects.toThrow('來源檔完整性');
    expect(createObjectURL).not.toHaveBeenCalled();
    chunks[1].digest = (await sha256('synthetic')).slice(0, 64);
    const tampered = await sha256(canonicalJson({ format: 'FHIR', chunks }));
    expect(tampered).not.toBe(sourceId);
    await expect(session.downloadSource!(tampered)).rejects.toThrow('找不到此加密來源檔');
  });
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
    records.sources[sourceId].data!.timestamp = '2026-10-31T08:00:00Z';
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

const personalPassphrase = 'synthetic-vault-passphrase';

async function personalFixture() {
  const records = emptyRecords();
  const envelope = await encryptRecords(records, personalPassphrase);
  const key = await deriveVaultKey(personalPassphrase, base64ToBytes(envelope.salt), envelope.iterations);
  return { records, envelope, key, session: createVaultSession(records, envelope, key) };
}

function noteOn(date: string, text: string): PersonalData['notes'][number] {
  return { id: newPersonalId(), date, kind: 'note', text };
}

describe('saving encrypted personal data', () => {
  it('exposes the stored personal data and a save function', async () => {
    const { session } = await personalFixture();
    expect(session.personal).toEqual(emptyPersonal());
    expect(session.savePersonal).toBeTypeOf('function');
  });
  it('encrypts the new data and uploads it against the current revision', async () => {
    const { records, envelope, session } = await personalFixture();
    const next = { ...emptyPersonal(), notes: [noteOn('2026-10-01', '下次看診要問的問題')] };
    const controller = new AbortController();
    const saved = await session.savePersonal!(next, controller.signal);
    expect(uploadEncryptedHealthData).toHaveBeenCalledOnce();
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(saved.envelope, {}, envelope.revision, controller.signal);
    expect(saved.envelope.revision).not.toBe(envelope.revision);
    expect(saved.data.personal).toEqual(next);
    expect(JSON.stringify(saved.envelope)).not.toContain('下次看診要問的問題');
    expect((await decryptRecords(saved.envelope, personalPassphrase)).personal).toEqual(next);
    expect(records.personal).toEqual(emptyPersonal());
  });
  it('normalizes what it stores', async () => {
    const { session } = await personalFixture();
    const saved = await session.savePersonal!({
      ...emptyPersonal(),
      notes: [noteOn('2026-10-02', '後'), noteOn('2026-10-01', '先')],
    });
    expect(saved.data.personal!.notes.map(note => note.text)).toEqual(['先', '後']);
  });
  it('chains a second save onto the revision of the first', async () => {
    const { session } = await personalFixture();
    const first = await session.savePersonal!({ ...emptyPersonal(), notes: [noteOn('2026-10-01', '第一筆')] });
    const second = await first.data.savePersonal!({
      ...first.data.personal!,
      notes: [...first.data.personal!.notes, noteOn('2026-10-02', '第二筆')],
    });
    expect(uploadEncryptedHealthData).toHaveBeenCalledTimes(2);
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(second.envelope, {}, first.envelope.revision, undefined);
    expect(second.data.personal!.notes.map(note => note.text)).toEqual(['第一筆', '第二筆']);
    expect(second.envelope.revision).not.toBe(first.envelope.revision);
  });
  it('leaves the unlocked session untouched when the upload is rejected', async () => {
    const { envelope, session } = await personalFixture();
    vi.mocked(uploadEncryptedHealthData).mockRejectedValue(new ApiError('conflict', 409));
    await expect(session.savePersonal!({ ...emptyPersonal(), notes: [noteOn('2026-10-01', '不應保存')] })).rejects.toMatchObject({ status: 409 });
    expect(session.personal).toEqual(emptyPersonal());
    vi.mocked(uploadEncryptedHealthData).mockResolvedValue({ message: 'ok', stats: {} });
    await session.savePersonal!({ ...emptyPersonal(), notes: [noteOn('2026-10-01', '重試')] });
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(expect.anything(), {}, envelope.revision, undefined);
  });
  it('rejects invalid personal data before any network call', async () => {
    const { session } = await personalFixture();
    const invalid = { ...emptyPersonal(), notes: [{ id: 'bad', date: '2026-02-30', kind: 'note', text: '無效日期' }] } as unknown as PersonalData;
    await expect(session.savePersonal!(invalid)).rejects.toThrow('加密個人資料已損壞');
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
  });
  it('keeps the parsed medical records and attachment access of the session', async () => {
    const { envelope, session } = await fixture();
    const saved = await session.savePersonal!({ ...emptyPersonal(), notes: [noteOn('2026-10-01', '保留診療資料')] });
    expect(saved.data.visits).toBe(session.visits);
    expect(saved.data.labResults).toBe(session.labResults);
    expect(saved.data.medicalReports).toBe(session.medicalReports);
    expect(saved.data.loadAttachment).toBeTypeOf('function');
    expect(saved.data.downloadSource).toBeTypeOf('function');
    const before = await decryptRecords(envelope, personalPassphrase);
    const after = await decryptRecords(saved.envelope, personalPassphrase);
    expect(after.fhir).toEqual(before.fhir);
    expect(after.fhirAliases).toEqual(before.fhirAliases);
    expect(after.attachments).toEqual(before.attachments);
    expect(after.personal.notes).toHaveLength(1);
  });
});
