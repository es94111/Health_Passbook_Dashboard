import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchEncryptedAttachment, fetchHealthData, fetchLegacyHealthData, uploadEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import { decryptRecords, encryptRecords } from './cryptoVault';
import { importHealthData, migrateHealthData, unlockHealthData } from './importHealthData';
import { base64ToBytes } from './medicalAttachments';
import { emptyRecords } from './recordStore';
import { SYNTHETIC_PNG, syntheticBundle, syntheticNhi } from './test/fixtures';

vi.mock('./api', () => ({ fetchHealthData: vi.fn(), fetchLegacyHealthData: vi.fn(), uploadEncryptedAttachment: vi.fn(), uploadEncryptedHealthData: vi.fn(), fetchEncryptedAttachment: vi.fn() }));
const passphrase = 'synthetic-vault-passphrase';
const withImage = () => syntheticBundle([{ resourceType: 'DiagnosticReport', id: 'report', presentedForm: [{ contentType: 'image/png', data: SYNTHETIC_PNG }] }]);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchHealthData).mockResolvedValue({ envelope: null, needsClientEncryptionMigration: false });
  vi.mocked(uploadEncryptedHealthData).mockResolvedValue({ message: 'ok', stats: {} });
  vi.mocked(uploadEncryptedAttachment).mockResolvedValue({ ok: true });
});

describe('encrypted import transaction orchestration', () => {
  it('does not upload anything for invalid input, missing consent or incorrect existing password', async () => {
    await expect(importHealthData({ invalid: true }, passphrase)).rejects.toThrow();
    await expect(importHealthData(syntheticNhi, passphrase)).rejects.toThrow('確認');
    const previous = await encryptRecords(emptyRecords(), passphrase);
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: previous, needsClientEncryptionMigration: false });
    await expect(importHealthData(syntheticBundle(), 'wrong-long-password')).rejects.toThrow();
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
    expect(uploadEncryptedAttachment).not.toHaveBeenCalled();
  });
  it('stages encrypted bytes before committing the manifest, then unlocks attachments on a fresh session', async () => {
    let attachment: ClientEncryptedRecords | undefined;
    vi.mocked(uploadEncryptedAttachment).mockImplementation(async (_id, envelope) => { attachment = envelope; return { ok: true }; });
    const imported = await importHealthData(withImage(), passphrase);
    expect(uploadEncryptedAttachment).toHaveBeenCalledOnce();
    expect(vi.mocked(uploadEncryptedAttachment).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadEncryptedHealthData).mock.invocationCallOrder[0]);
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(imported.envelope, expect.any(Object), null, undefined);
    const stored = await decryptRecords(imported.envelope, passphrase);
    expect(JSON.stringify(stored)).not.toContain(SYNTHETIC_PNG);
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: imported.envelope, needsClientEncryptionMigration: false });
    vi.mocked(fetchEncryptedAttachment).mockResolvedValue({ envelope: attachment! });
    const unlocked = await unlockHealthData(passphrase);
    const descriptor = unlocked.data.medicalReports[0].attachments[0];
    expect(descriptor.data).toBeUndefined();
    const blob = await unlocked.data.loadAttachment!(descriptor);
    expect(blob.type).toBe('image/png');
    expect(blob.size).toBe(base64ToBytes(SYNTHETIC_PNG).length);
    const duplicate = await importHealthData(withImage(), passphrase);
    expect(uploadEncryptedAttachment).toHaveBeenCalledOnce();
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(duplicate.envelope, expect.any(Object), imported.envelope.revision, undefined);
  });
  it('does not commit if an attachment upload fails', async () => {
    vi.mocked(uploadEncryptedAttachment).mockRejectedValue(new Error('synthetic storage unavailable'));
    await expect(importHealthData(withImage(), passphrase)).rejects.toThrow('unavailable');
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
  });
  it('aborts before committing or uploading with a changed session', async () => {
    const controller = new AbortController();
    vi.mocked(uploadEncryptedAttachment).mockImplementation(async () => { controller.abort(); return { ok: true }; });
    await expect(importHealthData(withImage(), passphrase, false, controller.signal)).rejects.toThrow();
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
    controller.abort();
    vi.mocked(fetchHealthData).mockClear();
    await expect(importHealthData(syntheticBundle(), passphrase, false, controller.signal)).rejects.toThrow();
    expect(fetchHealthData).not.toHaveBeenCalled();
  });
  it('propagates revision conflicts without retrying an overwrite', async () => {
    const previous = await encryptRecords(emptyRecords(), passphrase);
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: previous, needsClientEncryptionMigration: false });
    vi.mocked(uploadEncryptedHealthData).mockRejectedValue(new Error('409 newer revision'));
    await expect(importHealthData(syntheticBundle(), passphrase)).rejects.toThrow('409');
    expect(uploadEncryptedHealthData).toHaveBeenCalledOnce();
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), previous.revision, undefined);
  });
  it('migrates original NHI maps without dropping legacy records or creating source claims', async () => {
    const records = { ...emptyRecords(), r1: { existing: { 'r1.4': 'synthetic hospital', 'r1.5': '20261001', 'r1.7': 'synthetic code', r1_1: [] } } };
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: null, needsClientEncryptionMigration: true });
    vi.mocked(fetchLegacyHealthData).mockResolvedValue({ records });
    const migrated = await migrateHealthData(passphrase);
    expect(await decryptRecords(migrated.envelope, passphrase)).toEqual(records);
    expect(migrated.data.importHistory).toEqual([]);
    expect(uploadEncryptedHealthData).toHaveBeenCalledOnce();
  });
});
