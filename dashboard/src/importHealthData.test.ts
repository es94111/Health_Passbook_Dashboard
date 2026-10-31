import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchEncryptedAttachment, fetchHealthData, fetchLegacyHealthData, uploadEncryptedAttachment, uploadEncryptedHealthData, type ClientEncryptedRecords } from './api';
import { decryptRecords, decryptVaultBytes, deriveVaultKey, encryptRecords } from './cryptoVault';
import { commitLargeImport, importHealthData, migrateHealthData, prepareLargeImport, unlockHealthData } from './importHealthData';
import { base64ToBytes, SOURCE_CHUNK_BYTES } from './medicalAttachments';
import { emptyPersonal, newPersonalId, type PersonalData } from './personalData';
import type { SourceChunk } from './recordStore';
import { sha256 } from './parsers/fhir-common';
import { emptyRecords } from './recordStore';
import { SYNTHETIC_PNG, syntheticBundle, syntheticNhi } from './test/fixtures';

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  fetchHealthData: vi.fn(), fetchLegacyHealthData: vi.fn(), uploadEncryptedAttachment: vi.fn(), uploadEncryptedHealthData: vi.fn(), fetchEncryptedAttachment: vi.fn(),
}));
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
    expect(migrated.data.personal).toEqual(emptyPersonal());
  });
  it('keeps encrypted personal data through save, unlock and a later import', async () => {
    const imported = await importHealthData(syntheticBundle(), passphrase);
    const personal: PersonalData = { ...emptyPersonal(), notes: [{ id: newPersonalId(), date: '2026-10-01', kind: 'question', text: '下次回診詢問血壓目標' }] };
    const saved = await imported.data.savePersonal!(personal);
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(saved.envelope, {}, imported.envelope.revision, undefined);
    expect(JSON.stringify(saved.envelope)).not.toContain('血壓目標');
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: saved.envelope, needsClientEncryptionMigration: false });
    const unlocked = await unlockHealthData(passphrase);
    expect(unlocked.data.personal).toEqual(saved.data.personal);
    expect(unlocked.data.personal?.notes).toHaveLength(1);
    const reimported = await importHealthData(syntheticBundle(), passphrase);
    expect(reimported.data.personal).toEqual(saved.data.personal);
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(reimported.envelope, expect.any(Object), saved.envelope.revision, undefined);
  });
});

function jsonFile(value: unknown): File {
  return new File([JSON.stringify(value)], 'synthetic.json', { type: 'application/json' });
}

describe('streaming import of oversized source files', () => {
  it('stores the original bytes as encrypted chunks and only an index in the manifest', async () => {
    const file = jsonFile(withImage());
    const preview = await prepareLargeImport(file, passphrase);
    expect(preview).toMatchObject({ format: 'FHIR', needsConfirmation: false });
    expect(uploadEncryptedAttachment).not.toHaveBeenCalled();
    const staged = new Map<string, ClientEncryptedRecords>();
    vi.mocked(uploadEncryptedAttachment).mockImplementation(async (id, envelope) => { staged.set(id, envelope); return { ok: true }; });
    const imported = await commitLargeImport(preview, passphrase);
    expect(vi.mocked(uploadEncryptedAttachment).mock.invocationCallOrder.every(order =>
      order < vi.mocked(uploadEncryptedHealthData).mock.invocationCallOrder[0])).toBe(true);
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(imported.envelope, expect.any(Object), null, undefined);
    const records = await decryptRecords(imported.envelope, passphrase);
    const [sourceId] = Object.keys(records.sources);
    expect(records.sources[sourceId].data).toBeUndefined();
    const chunks = records.sources[sourceId].chunks as SourceChunk[];
    expect(chunks).toHaveLength(1);
    const key = await deriveVaultKey(passphrase, base64ToBytes(imported.envelope.salt), imported.envelope.iterations);
    const bytes = await decryptVaultBytes(staged.get(chunks[0].id)!, key);
    expect(bytes).toEqual(new Uint8Array(await file.arrayBuffer()));
    expect(chunks[0]).toEqual({ id: chunks[0].id, digest: await sha256(bytes), size: bytes.length });
    const [attachmentId] = Object.keys(records.attachments);
    expect(records.attachments[attachmentId]).toMatchObject({ contentType: 'image/png', size: base64ToBytes(SYNTHETIC_PNG).length });
    expect(await decryptVaultBytes(staged.get(attachmentId)!, key)).toEqual(base64ToBytes(SYNTHETIC_PNG));
    expect(JSON.stringify(records)).not.toContain(SYNTHETIC_PNG);
    expect(imported.data.importHistory).toHaveLength(1);
  });
  it('still requires explicit patient consent before the vault is replaced', async () => {
    const preview = await prepareLargeImport(jsonFile(syntheticNhi), passphrase);
    expect(preview).toMatchObject({ format: 'NHI', needsConfirmation: true });
    await expect(commitLargeImport(preview, passphrase)).rejects.toThrow('確認');
    expect(uploadEncryptedAttachment).not.toHaveBeenCalled();
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
    const confirmed = await commitLargeImport(preview, passphrase, true);
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(confirmed.envelope, expect.any(Object), null, undefined);
    expect(Object.keys((await decryptRecords(confirmed.envelope, passphrase)).r1)).toHaveLength(1);
  });
  it('keeps encrypted personal data when a streamed import merges into an existing vault', async () => {
    const first = await importHealthData(syntheticBundle(), passphrase);
    const saved = await first.data.savePersonal!({ ...emptyPersonal(), profile: { allergies: [{ id: newPersonalId(), name: '青黴素' }], conditions: [] } });
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: saved.envelope, needsClientEncryptionMigration: false });
    const preview = await prepareLargeImport(jsonFile(withImage()), passphrase);
    const merged = await commitLargeImport(preview, passphrase);
    expect(merged.data.personal).toEqual(saved.data.personal);
    expect((await decryptRecords(merged.envelope, passphrase)).personal.profile.allergies).toHaveLength(1);
    expect(uploadEncryptedHealthData).toHaveBeenLastCalledWith(merged.envelope, expect.any(Object), saved.envelope.revision, undefined);
  });
  it('does not commit the manifest when a chunk upload fails', async () => {
    const preview = await prepareLargeImport(jsonFile(withImage()), passphrase);
    vi.mocked(uploadEncryptedAttachment).mockRejectedValue(new Error('synthetic storage unavailable'));
    await expect(commitLargeImport(preview, passphrase)).rejects.toThrow('unavailable');
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
  });
  it('aborts a streaming import before any commit when cancelled', async () => {
    const preview = await prepareLargeImport(jsonFile(withImage()), passphrase);
    const controller = new AbortController();
    vi.mocked(uploadEncryptedAttachment).mockImplementation(async () => { controller.abort(); return { ok: true }; });
    await expect(commitLargeImport(preview, passphrase, false, controller.signal)).rejects.toThrow();
    expect(uploadEncryptedHealthData).not.toHaveBeenCalled();
  });
  it('stores a record index beyond 32 MiB as encrypted shards behind a tiny manifest', async () => {
    const valueString = 'x'.repeat(33 * 1024 * 1024);
    const preview = await prepareLargeImport(jsonFile(syntheticBundle([{ resourceType: 'Observation', id: 'huge', valueString }])), passphrase);
    const staged = new Map<string, ClientEncryptedRecords>();
    // Raw source chunks upload first, then the index shards; retried content-addressed shards
    // surface as 409 and must not abort the import.
    const chunkUploads = Math.ceil(preview.file.size / SOURCE_CHUNK_BYTES);
    vi.mocked(uploadEncryptedAttachment).mockImplementation(async (id, envelope) => {
      staged.set(id, envelope);
      if (staged.size > chunkUploads && staged.size % 2 === 0) throw new ApiError('伺服器已有相同內容的加密附件', 409);
      return { ok: true };
    });
    const imported = await commitLargeImport(preview, passphrase);
    expect(imported.envelope.data.length).toBeLessThan(64 * 1024);
    const ids = imported.envelope.attachmentIds ?? [];
    expect(ids.length).toBeGreaterThan(5);
    expect([...staged.keys()].sort()).toEqual(ids);
    expect(uploadEncryptedHealthData).toHaveBeenCalledWith(imported.envelope, expect.any(Object), null, undefined);
    vi.mocked(fetchHealthData).mockResolvedValue({ envelope: imported.envelope, needsClientEncryptionMigration: false });
    vi.mocked(fetchEncryptedAttachment).mockImplementation(async id => ({ envelope: staged.get(id)! }));
    const stored = await decryptRecords(imported.envelope, passphrase);
    expect(JSON.stringify(stored).length).toBeGreaterThan(valueString.length);
    const unlocked = await unlockHealthData(passphrase);
    expect(unlocked.envelope.revision).toBe(imported.envelope.revision);
  }, 180_000);
});
