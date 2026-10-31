import { describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64, MAX_ATTACHMENT_BYTES, normalizeMedicalAttachment, restoreAttachmentData, separateAttachments, validateAttachmentBytes } from './medicalAttachments';
import { SYNTHETIC_PNG, syntheticBundle } from './test/fixtures';
import { mergeNHIJson } from './recordImport';
import { emptyRecords, flattenRecords } from './recordStore';
import { parseNHIJson } from './parsers/nhi-parser';

const image = { contentType: 'image/png', title: 'synthetic image', data: SYNTHETIC_PNG };
describe('independent medical attachment validation and retention', () => {
  it('extracts supported bytes, deduplicates repeated images, and reconstructs an exact original', async () => {
    const original = { first: image, nested: [{ ...image, size: base64ToBytes(SYNTHETIC_PNG).length }] };
    const prepared = await separateAttachments(original, {});
    expect(prepared.pending).toHaveLength(1);
    expect(Object.keys(prepared.metadata)).toHaveLength(1);
    expect(JSON.stringify(prepared.json)).not.toContain(SYNTHETIC_PNG);
    expect(await restoreAttachmentData(prepared.json, async () => SYNTHETIC_PNG)).toEqual(original);
    const again = await separateAttachments(original, prepared.metadata);
    expect(again.pending).toHaveLength(0);
    expect(again.json).toEqual(prepared.json);
  });
  it('links DocumentReference attachments through a local Binary and never fetches external URLs', async () => {
    const bundle = syntheticBundle([
      { resourceType: 'Binary', id: 'image', contentType: 'image/png', data: SYNTHETIC_PNG, subject: undefined },
      { resourceType: 'DocumentReference', id: 'doc', content: [{ attachment: { title: 'synthetic image', contentType: 'image/png', url: 'urn:uuid:image' } },
        { attachment: { contentType: 'application/pdf', url: 'https://example.invalid/private.pdf' } }] },
    ]);
    const result = await mergeNHIJson(emptyRecords(), bundle);
    const parsed = parseNHIJson(flattenRecords(result.records));
    expect(result.pendingAttachments).toHaveLength(1);
    expect(parsed.medicalReports[0].attachments[0].id).toBe(result.pendingAttachments[0].id);
    expect(parsed.medicalReports[0].externalAttachmentCount).toBe(1);
    expect(result.records.importHistory[0].warnings.join()).toContain('未連線');
  });
  it.each(['!not-base64!', 'aGVsbG8', 'aGVsbG8===', 'aGVsbG9='])('rejects invalid or non-canonical Base64 %s', invalid => {
    expect(() => base64ToBytes(invalid)).toThrow();
  });
  it('rejects MIME mismatches, dishonest sizes, oversized data and reserved pointer keys', async () => {
    await expect(separateAttachments({ ...image, contentType: 'image/jpeg' }, {})).rejects.toThrow('類型');
    await expect(separateAttachments({ ...image, size: 1 }, {})).rejects.toThrow('size');
    await expect(separateAttachments({ ...image, size: '1' }, {})).rejects.toThrow('size');
    expect(() => validateAttachmentBytes(new Uint8Array(MAX_ATTACHMENT_BYTES + 1), 'image/png')).toThrow('12 MiB');
    await expect(separateAttachments({ ...image, __vaultAttachment: crypto.randomUUID() }, {})).rejects.toThrow('保留');
  });
  it('retains unsupported payloads only in raw encrypted sources and excludes active preview types', async () => {
    const original = { ...image, contentType: 'image/svg+xml' };
    const prepared = await separateAttachments(original, {});
    expect(prepared.json).toEqual(original);
    expect(prepared.pending).toHaveLength(0);
    expect(prepared.warnings).toHaveLength(1);
    expect(normalizeMedicalAttachment(original)).toBeNull();
    expect(normalizeMedicalAttachment({ ...image, data: bytesToBase64(new TextEncoder().encode('<svg/>')) })).toBeNull();
  });
  it.each([
    ['image/jpeg', [0xff, 0xd8, 0xff, 0]],
    ['image/webp', [82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]],
    ['image/gif', [71, 73, 70, 56, 57, 97]],
    ['image/bmp', [66, 77, 0, 0]],
    ['application/pdf', [37, 80, 68, 70, 45]],
  ] as const)('recognizes %s magic bytes without rendering it', (type, signature) => {
    expect(() => validateAttachmentBytes(new Uint8Array(signature), type)).not.toThrow();
  });
});
