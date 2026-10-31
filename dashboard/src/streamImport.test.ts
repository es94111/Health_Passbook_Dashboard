import { describe, expect, it } from 'vitest';
import { canonicalJson, sha256 } from './parsers/fhir-common';
import { emptyRecords } from './recordStore';
import { extractImportFile, scanImportFile, type LargeImportSink, type SourceChunkUpload } from './streamImport';
import { SYNTHETIC_PNG, syntheticBundle, syntheticNhi } from './test/fixtures';
import { base64ToBytes, type PendingAttachment } from './medicalAttachments';

function jsonFile(value: unknown, name = 'synthetic.json'): File {
  return new File([JSON.stringify(value)], name, { type: 'application/json' });
}

function textFile(text: string): File {
  return new File([text], 'synthetic.json', { type: 'application/json' });
}

function sink() {
  const chunks: SourceChunkUpload[] = [];
  const attachments: PendingAttachment[] = [];
  const target: LargeImportSink = {
    uploadSourceChunk: async chunk => { chunks.push(chunk); },
    uploadAttachment: async attachment => { attachments.push(attachment); },
  };
  return { target, chunks, attachments };
}

async function fileBytes(file: File): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.arrayBuffer());
}

describe('streaming scan of oversized source files', () => {
  it('recognises native and wrapped NHI exports without reading them into memory', async () => {
    expect(await scanImportFile(jsonFile(syntheticNhi), emptyRecords())).toEqual({ format: 'NHI', needsConfirmation: true });
    expect(await scanImportFile(jsonFile({ r7: syntheticNhi.myhealthbank.bdata.r7 }), emptyRecords())).toEqual({ format: 'NHI', needsConfirmation: true });
  });
  it('recognises FHIR bundles and requires a verifiable patient', async () => {
    expect(await scanImportFile(jsonFile(syntheticBundle()), emptyRecords())).toEqual({ format: 'FHIR', needsConfirmation: false });
    const anonymous = { resourceType: 'Bundle', type: 'collection', entry: [{ resource: { resourceType: 'Patient' } }, { resource: { resourceType: 'Observation', id: 'synthetic' } }] };
    await expect(scanImportFile(jsonFile(anonymous), emptyRecords())).rejects.toThrow('Patient');
  });
  it('rejects partial, duplicated and non-bundle FHIR input before anything is stored', async () => {
    await expect(scanImportFile(jsonFile({ resourceType: 'Patient', id: 'synthetic' }), emptyRecords())).rejects.toThrow('FHIR R4 Bundle');
    await expect(scanImportFile(jsonFile({ ...syntheticBundle(), type: 'searchset', total: 9 }), emptyRecords())).rejects.toThrow('分頁');
    await expect(scanImportFile(jsonFile({ ...syntheticBundle(), link: [{ relation: 'next', url: 'synthetic' }] }), emptyRecords())).rejects.toThrow('分頁');
    const duplicate = syntheticBundle([{ resourceType: 'Observation', id: 'synthetic-observation' }]);
    (duplicate.entry as { fullUrl: string }[])[1].fullUrl = 'urn:uuid:synthetic-patient';
    await expect(scanImportFile(jsonFile(duplicate), emptyRecords())).rejects.toThrow('fullUrl');
    await expect(scanImportFile(jsonFile({ synthetic: true }), emptyRecords())).rejects.toThrow('不是支援的');
    await expect(scanImportFile(textFile(''), emptyRecords())).rejects.toThrow('空');
  });
  it('rejects truncated JSON instead of treating it as an empty export', async () => {
    const text = JSON.stringify(syntheticBundle()).slice(0, 120);
    await expect(scanImportFile(textFile(text), emptyRecords())).rejects.toThrow();
  });
});

describe('two-pass extraction of oversized source files', () => {
  it('separates attachments, uploads every raw chunk and links them by digest', async () => {
    const file = jsonFile(syntheticBundle([{ resourceType: 'DiagnosticReport', id: 'report', presentedForm: [{ contentType: 'image/png', data: SYNTHETIC_PNG }] }]));
    const store = sink();
    const extracted = await extractImportFile(file, 'FHIR', emptyRecords(), store.target, undefined, ratio => expect(ratio).toBeGreaterThan(0));
    const bytes = await fileBytes(file);
    expect(store.chunks).toHaveLength(1);
    expect(store.chunks[0].bytes).toEqual(bytes);
    expect(extracted.chunks).toEqual([{ id: store.chunks[0].id, digest: await sha256(bytes), size: bytes.length }]);
    expect(extracted.sourceId).toBe(await sha256(canonicalJson({ format: 'FHIR', chunks: extracted.chunks })));
    expect(store.attachments).toHaveLength(1);
    expect(store.attachments[0].data).toBe(SYNTHETIC_PNG);
    expect(Object.keys(extracted.attachments)).toEqual([store.attachments[0].id]);
    const entry = (extracted.json.entry as { resource: Record<string, unknown> }[])[1].resource;
    expect(JSON.stringify(extracted.json)).not.toContain(SYNTHETIC_PNG);
    expect(entry.presentedForm).toEqual([{ contentType: 'image/png', __vaultAttachment: store.attachments[0].id, __vaultOriginalSize: false, size: base64ToBytes(SYNTHETIC_PNG).length }]);
    expect(extracted.json).toMatchObject({ resourceType: 'Bundle', type: 'collection' });
    expect((extracted.json.entry as unknown[]).length).toBe(2);
  });
  it('splits a file larger than one chunk into verifiable source chunks', async () => {
    const valueString = 'x'.repeat(8.5 * 1024 * 1024);
    const file = jsonFile(syntheticBundle([{ resourceType: 'Observation', id: 'large', status: 'final', valueString }]));
    const store = sink();
    const extracted = await extractImportFile(file, 'FHIR', emptyRecords(), store.target);
    const bytes = await fileBytes(file);
    expect(store.chunks.length).toBeGreaterThan(1);
    expect(store.chunks.reduce((total, chunk) => total + chunk.bytes.length, 0)).toBe(bytes.length);
    const joined = new Uint8Array(bytes.length);
    let offset = 0;
    for (const chunk of store.chunks) { joined.set(chunk.bytes, offset); offset += chunk.bytes.length; }
    expect(await sha256(joined)).toBe(await sha256(bytes));
    expect(extracted.chunks.map(chunk => chunk.digest)).toEqual(await Promise.all(store.chunks.map(chunk => sha256(chunk.bytes))));
    expect(extracted.sourceId).toBe(await sha256(canonicalJson({ format: 'FHIR', chunks: extracted.chunks })));
    const entry = (extracted.json.entry as { resource: Record<string, unknown> }[])[1].resource;
    expect(entry.valueString).toBe(valueString);
  }, 60_000);
  it('rebuilds wrapped NHI exports so the merged manifest keeps the original shape', async () => {
    const store = sink();
    const extracted = await extractImportFile(jsonFile(syntheticNhi), 'NHI', emptyRecords(), store.target);
    expect(extracted.json).toEqual({ myhealthbank: { bdata: { r1: syntheticNhi.myhealthbank.bdata.r1, r7: syntheticNhi.myhealthbank.bdata.r7 } } });
    expect(store.attachments).toHaveLength(0);
    expect(store.chunks).toHaveLength(1);
  });
  it('refuses to build an index beyond the encrypted manifest budget', async () => {
    const valueString = 'x'.repeat(33 * 1024 * 1024);
    const store = sink();
    await expect(extractImportFile(jsonFile(syntheticBundle([{ resourceType: 'Observation', id: 'huge', valueString }])), 'FHIR', emptyRecords(), store.target))
      .rejects.toThrow('32 MiB');
  });
});
