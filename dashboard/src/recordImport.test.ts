import { describe, expect, it } from 'vitest';
import { emptyRecords, flattenRecords } from './recordStore';
import { mergeNHIJson, PatientConfirmationRequired } from './recordImport';
import { parseNHIJson } from './parsers/nhi-parser';
import { readFhirBundleResources } from './parsers/fhir-parser';
import { canonicalJson, type FhirObject } from './parsers/fhir-common';
import { syntheticBundle, syntheticNhi } from './test/fixtures';

const observation = (value = 12): FhirObject => ({ resourceType: 'Observation', id: 'lab', effectiveDateTime: '2026-10-01', code: { text: 'synthetic lab' }, valueQuantity: { value, unit: 'mg/dL' } });
const entries = (bundle: FhirObject) => bundle.entry as { resource: FhirObject; fullUrl: string }[];

describe('patient isolation and safe incremental imports', () => {
  it('requires per-import consent for NHI and preserves old data on rejection', async () => {
    const original = emptyRecords();
    await expect(mergeNHIJson(original, syntheticNhi)).rejects.toBeInstanceOf(PatientConfirmationRequired);
    expect(original).toEqual(emptyRecords());
    const first = await mergeNHIJson(original, syntheticNhi, { confirmPatient: true });
    expect(first.stats.r1.added).toBe(1);
    expect(first.records.importHistory[0].identityConfirmed).toBe(true);
    await expect(mergeNHIJson(first.records, syntheticNhi)).rejects.toBeInstanceOf(PatientConfirmationRequired);
    const second = await mergeNHIJson(first.records, syntheticNhi, { confirmPatient: true });
    expect(second.stats.r1.skipped).toBe(1);
    expect(Object.keys(second.records.sources)).toHaveLength(1);
    expect(second.records.importHistory).toHaveLength(2);
  });
  it('retains undated legacy originals and warns instead of silently implying complete trends', async () => {
    const input = { r1: [{ 'r1.4': 'synthetic hospital', 'r1.5': 'invalid date', 'r1.7': 'synthetic code' }] };
    const result = await mergeNHIJson(emptyRecords(), input, { confirmPatient: true });
    expect(result.stats.r1.added).toBe(1);
    expect(parseNHIJson(flattenRecords(result.records)).visits).toHaveLength(0);
    expect(result.records.importHistory[0].warnings.join()).toContain('NHI 紀錄日期');
    expect(Object.values(result.records.sources)[0].data).toEqual(input);
  });
  it('does not treat a reused local Patient.id as verified identity', async () => {
    const bundle = syntheticBundle();
    delete entries(bundle)[0].resource.identifier;
    await expect(mergeNHIJson(emptyRecords(), bundle)).rejects.toBeInstanceOf(PatientConfirmationRequired);
    const first = await mergeNHIJson(emptyRecords(), bundle, { confirmPatient: true });
    await expect(mergeNHIJson(first.records, bundle)).rejects.toBeInstanceOf(PatientConfirmationRequired);
  });
  it('requires confirmation when moving from legacy data to a known FHIR patient', async () => {
    const first = await mergeNHIJson(emptyRecords(), syntheticNhi, { confirmPatient: true });
    await expect(mergeNHIJson(first.records, syntheticBundle())).rejects.toBeInstanceOf(PatientConfirmationRequired);
    const merged = await mergeNHIJson(first.records, syntheticBundle(), { confirmPatient: true });
    expect(Object.keys(merged.records.r1)).toHaveLength(1);
    expect(Object.keys(merged.records.fhir)).toHaveLength(1);
  });
  it('cannot override contradicting identifiers with confirmation', async () => {
    const first = await mergeNHIJson(emptyRecords(), syntheticBundle());
    const different = syntheticBundle();
    entries(different)[0].resource.identifier = [{ system: 'urn:test:patient', value: 'synthetic-b' }];
    await expect(mergeNHIJson(first.records, different, { confirmPatient: true })).rejects.toThrow('不同的病人');
    expect(first.records.importHistory).toHaveLength(1);
  });
  it('deduplicates reordered object keys, updates changed values and preserves every source', async () => {
    const first = await mergeNHIJson(emptyRecords(), syntheticBundle([observation()]));
    const reordered = JSON.parse(canonicalJson(syntheticBundle([observation()])));
    const second = await mergeNHIJson(first.records, reordered);
    expect(second.stats.fhir).toEqual({ added: 0, updated: 0, skipped: 2 });
    const third = await mergeNHIJson(second.records, syntheticBundle([observation(15)]));
    expect(third.stats.fhir.updated).toBe(1);
    expect(Object.keys(third.records.sources)).toHaveLength(2);
    expect(parseNHIJson(flattenRecords(third.records)).labResults[0].value).toBe(15);
    expect(parseNHIJson(flattenRecords(first.records)).labResults[0].value).toBe(12);
  });
  it('retains an older incoming original without downgrading current records', async () => {
    const first = await mergeNHIJson(emptyRecords(), syntheticBundle([{ ...observation(15), meta: { versionId: '3', lastUpdated: '2026-10-03T00:00:00Z' } }]));
    const second = await mergeNHIJson(first.records, syntheticBundle([{ ...observation(), meta: { versionId: '2', lastUpdated: '2026-10-02T00:00:00Z' } }]));
    expect(second.stats.fhir.updated).toBe(0);
    expect(second.records.importHistory[1].warnings.join()).toContain('較舊');
    expect(parseNHIJson(flattenRecords(second.records)).labResults[0].value).toBe(15);
    expect(Object.keys(second.records.sources)).toHaveLength(2);
  });
  it('rejects an alias reassigned to a different resource without mutating prior records', async () => {
    const first = await mergeNHIJson(emptyRecords(), syntheticBundle([observation()]));
    const conflicting = syntheticBundle([{ ...observation(), id: 'another-lab' }]);
    entries(conflicting)[1].fullUrl = 'urn:uuid:lab';
    await expect(mergeNHIJson(first.records, conflicting)).rejects.toThrow('fullUrl');
    expect(Object.keys(first.records.fhir)).toHaveLength(2);
  });
  it.each([
    { resourceType: 'Patient', id: 'alone' },
    { unrelated: [] },
    { r1: [null] },
    { r1: [] },
  ])('rejects malformed/empty imports before writing', async invalid => {
    await expect(mergeNHIJson(emptyRecords(), invalid, { confirmPatient: true })).rejects.toThrow();
  });
});

describe('FHIR resource identity and completeness validation', () => {
  it('rejects a missing Patient, partial searchset and malformed entry', () => {
    expect(() => readFhirBundleResources({ resourceType: 'Bundle', entry: [{ resource: observation() }] })).toThrow('Patient');
    expect(() => readFhirBundleResources({ ...syntheticBundle(), type: 'searchset', total: 2 })).toThrow('分頁');
    const bad = syntheticBundle();
    (bad.entry as unknown[]).push({});
    expect(() => readFhirBundleResources(bad)).toThrow('resource');
  });
  it('rejects unresolved subjects and nested cross-patient references', () => {
    expect(() => readFhirBundleResources(syntheticBundle([{ ...observation(), subject: { reference: 'Patient/other' } }]))).toThrow('病人');
    expect(() => readFhirBundleResources(syntheticBundle([{ ...observation(), focus: [{ reference: 'Patient/other' }] }]))).toThrow('病人');
  });
  it('supports contained matching patients and rejects unidentified contained patients', () => {
    const patient = { resourceType: 'Patient', id: 'contained', identifier: [{ system: 'urn:test:patient', value: 'synthetic-a' }] };
    expect(readFhirBundleResources(syntheticBundle([{ ...observation(), contained: [patient], subject: { reference: '#contained' } }]))).toHaveLength(2);
    expect(() => readFhirBundleResources(syntheticBundle([{ ...observation(), contained: [{ ...patient, identifier: [] }], subject: { reference: '#contained' } }]))).toThrow('病人');
  });
});
