import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './medicalAttachments';
import { decryptRecords, decryptVaultBytes, deriveVaultKey, encryptRecords, encryptWithVaultKey, validateEnvelope } from './cryptoVault';
import { mergeNHIJson } from './recordImport';
import { emptyRecords, normalizeStoredRecords, sourceChunkIds } from './recordStore';
import { SYNTHETIC_PNG, syntheticBundle } from './test/fixtures';
import { canonicalJson, sha256 } from './parsers/fhir-common';

const passphrase = 'synthetic-passphrase-only';
describe('browser encrypted manifests and independent binary attachments', () => {
  it('roundtrips original sources and history across serialized backup/relogin data', async () => {
    const { records } = await mergeNHIJson(emptyRecords(), syntheticBundle([{ resourceType: 'DiagnosticReport', id: 'report', presentedForm: [{ contentType: 'image/png', data: SYNTHETIC_PNG }] }]));
    const encrypted = await encryptRecords(records, passphrase);
    expect(JSON.stringify(encrypted)).not.toContain('synthetic-patient');
    expect(encrypted.attachmentIds).toEqual(Object.keys(records.attachments));
    expect(await decryptRecords(JSON.parse(JSON.stringify(encrypted)), passphrase)).toEqual(records);
    const reencrypted = await encryptRecords(records, passphrase, encrypted);
    expect(reencrypted.salt).toBe(encrypted.salt);
    expect(reencrypted.iv).not.toBe(encrypted.iv);
    expect(reencrypted.revision).not.toBe(encrypted.revision);
  });
  it('rejects wrong passwords, changed ciphertext, and a changed visible attachment manifest', async () => {
    const envelope = await encryptRecords(emptyRecords(), passphrase);
    await expect(decryptRecords(envelope, 'incorrect-passphrase')).rejects.toThrow();
    const bytes = base64ToBytes(envelope.data);
    bytes[0] ^= 1;
    await expect(decryptRecords({ ...envelope, data: bytesToBase64(bytes) }, passphrase)).rejects.toThrow();
    await expect(decryptRecords({ ...envelope, attachmentIds: [crypto.randomUUID()] }, passphrase)).rejects.toThrow('清單');
  });
  it('encrypts attachment bytes with an independent fresh IV using the same vault key', async () => {
    const envelope = await encryptRecords(emptyRecords(), passphrase);
    const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
    const bytes = base64ToBytes(SYNTHETIC_PNG);
    const attachment = await encryptWithVaultKey(bytes, key, envelope);
    expect(attachment.iv).not.toBe(envelope.iv);
    expect(attachment.data).not.toBe(SYNTHETIC_PNG);
    expect(await decryptVaultBytes(attachment, key)).toEqual(bytes);
  });
  it('lists encrypted source chunks in the visible manifest and roundtrips them without re-uploading', async () => {
    const chunkId = crypto.randomUUID();
    const sourceId = await sha256(canonicalJson({ format: 'FHIR', chunks: [{ id: chunkId, digest: 'a'.repeat(64), size: 1024 }] }));
    const records = normalizeStoredRecords({ ...emptyRecords(), sources: { [sourceId]: { format: 'FHIR', chunks: [{ id: chunkId, digest: 'a'.repeat(64), size: 1024 }] } } });
    expect(sourceChunkIds(records)).toEqual([chunkId]);
    const encrypted = await encryptRecords(records, passphrase);
    expect(encrypted.attachmentIds).toEqual([chunkId]);
    expect(await decryptRecords(JSON.parse(JSON.stringify(encrypted)), passphrase)).toEqual(records);
    const bytes = base64ToBytes(SYNTHETIC_PNG);
    const key = await deriveVaultKey(passphrase, base64ToBytes(encrypted.salt), encrypted.iterations);
    expect(await decryptVaultBytes(await encryptWithVaultKey(bytes, key, encrypted), key)).toEqual(bytes);
  });
  it('rejects source archives that mix or omit the stored representation', async () => {
    const sourceId = await sha256('synthetic-source');
    const chunk = { id: crypto.randomUUID(), digest: 'a'.repeat(64), size: 1024 };
    for (const archive of [
      { format: 'FHIR' },
      { format: 'FHIR', data: syntheticBundle(), chunks: [chunk] },
      { format: 'NHI', chunks: [] },
      { format: 'NHI', chunks: [{ ...chunk, size: 0 }] },
      { format: 'NHI', chunks: [chunk, chunk] },
    ]) expect(() => normalizeStoredRecords({ ...emptyRecords(), sources: { [sourceId]: archive } })).toThrow('加密來源索引已損壞');
  });
  it('supports legacy maps without new metadata and rejects malformed record maps', async () => {
    const legacy = normalizeStoredRecords({ r1: { old: { 'r1.4': 'synthetic' } } });
    expect(legacy.importHistory).toEqual([]);
    expect(await decryptRecords(await encryptRecords(legacy, passphrase), passphrase)).toEqual(legacy);
    expect(() => normalizeStoredRecords({ r1: [] })).toThrow();
    expect(() => normalizeStoredRecords({ r1: { bad: 'not a record' } })).toThrow();
  });
  it('bounds untrusted encryption/KDF parameters before deriving a key', async () => {
    const envelope = await encryptRecords(emptyRecords(), passphrase);
    expect(() => validateEnvelope({ ...envelope, iterations: 1e12 })).toThrow();
    expect(() => validateEnvelope({ ...envelope, attachmentIds: ['../other-user'] })).toThrow();
    await expect(encryptRecords(emptyRecords(), 'short')).rejects.toThrow('12');
  });
});
