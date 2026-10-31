import { describe, expect, it } from 'vitest';
import { fhirDate, referenceIndex, type FhirObject } from './fhir-common';
import { parseFhirResources, readFhirBundleResources } from './fhir-parser';
import { syntheticBundle } from '../test/fixtures';

function parse(extra: FhirObject[]) {
  const bundle = syntheticBundle(extra);
  return parseFhirResources(readFhirBundleResources(bundle), bundle.entry as FhirObject[]);
}
const lab = { resourceType: 'Observation', id: 'lab', effectiveDateTime: '2026-10-01', code: { text: 'synthetic' } };
describe('lossless clinical result representation', () => {
  it('retains numeric parent and component results, their units, and reference text', () => {
    const data = parse([{ ...lab, valueQuantity: { value: 12, unit: 'mg/dL' }, referenceRange: [{ low: { value: 1, unit: 'mg/dL' }, high: { value: 20, unit: 'mg/dL' }, text: 'synthetic reference' }],
      component: [{ code: { text: 'component' }, valueQuantity: { value: 0.12, unit: 'g/L' } }] }]);
    expect(data.labResults.map(item => item.value)).toEqual([12, 0.12]);
    expect(data.labResults.map(item => item.unit)).toEqual(['mg/dL', 'g/L']);
    expect(data.labResults[0]).toMatchObject({ refLow: 1, refHigh: 20 });
    expect(data.labResults[0].refText).toContain('synthetic reference');
  });
  it.each([
    { valueQuantity: { value: 1, comparator: '<', unit: 'mg/dL' } },
    { valueString: '陰性' },
    { valueCodeableConcept: { coding: [{ code: 'negative', display: '未檢出' }] } },
    { valueBoolean: false },
    { dataAbsentReason: { text: '檢體不足' } },
  ])('keeps qualitative/comparator results out of numeric charts', value => {
    const data = parse([{ ...lab, ...value }]);
    expect(data.labResults).toHaveLength(0);
    expect(data.textLabResults).toHaveLength(1);
    expect(data.textLabResults[0].text.length).toBeGreaterThan(0);
  });
  it('does not invent dates or chart withdrawn results', () => {
    const data = parse([{ ...lab, effectiveDateTime: '2026-10', valueQuantity: { value: 12 } },
      { ...lab, id: 'withdrawn', status: 'entered-in-error', valueInteger: 5 },
      { resourceType: 'DocumentReference', id: 'undated', description: 'synthetic report', content: [] },
      { resourceType: 'MedicationRequest', id: 'undated-medication', medicationCodeableConcept: { text: 'synthetic medication' } }]);
    expect(data.labResults).toHaveLength(0);
    expect(data.textLabResults[0].date).toBeNull();
    expect(data.medicalReports[0].date).toBeNull();
    expect(data.medications[0].date).toBeNull();
  });
  it('does not apply incompatible-unit or patient-conditional reference limits', () => {
    const data = parse([{ ...lab, valueQuantity: { value: 12, unit: 'mg/dL' }, referenceRange: [{ high: { value: 1, unit: 'mmol/L' } }] },
      { ...lab, id: 'conditional', valueQuantity: { value: 12 }, referenceRange: [{ high: { value: 10 }, appliesTo: [{ text: 'synthetic age group' }] }] }]);
    expect(data.labResults.every(item => item.refHigh === null)).toBe(true);
    expect(data.labResults[0].refText).toContain('mmol/L');
    expect(data.labResults[1].refText).toContain('synthetic age group');
  });
  it('separates prescription, dispense and administration-history categories', () => {
    const data = parse(['MedicationRequest', 'MedicationDispense', 'MedicationStatement'].map((resourceType, index) => ({ resourceType, id: `med-${index}`, medicationCodeableConcept: { text: 'synthetic medication' } })));
    expect(new Set(data.medications.map(item => item.category))).toEqual(new Set(['處方', '領藥', '用藥紀錄']));
    expect(data.medications.every(item => item.rawResource.resourceType)).toBe(true);
  });
});

describe('local FHIR references and strict calendar dates', () => {
  it('resolves relative resources within their source namespace without guessing remote URLs', () => {
    const a = { resourceType: 'Organization', id: 'hospital', meta: { source: 'synthetic-a' } };
    const b = { resourceType: 'Organization', id: 'hospital', meta: { source: 'synthetic-b' } };
    const owner = { resourceType: 'Encounter', id: 'visit', meta: { source: 'synthetic-a' } };
    const resolve = referenceIndex([a, b, owner], [{ fullUrl: 'urn:uuid:hospital-a', resource: a }]);
    expect(resolve('Organization/hospital', owner)).toBe(a);
    expect(resolve('Organization/hospital')).toBeUndefined();
    expect(resolve('urn:uuid:hospital-a')).toBe(a);
    expect(resolve('https://untrusted.invalid/Organization/hospital', owner)).toBeUndefined();
  });
  it.each(['2026', '2026-10', '2026-02-30', '2026-10-01T24:00:00Z', '2026-10-01T10:00:00+15:00', '0000-01-01'])('rejects incomplete or invalid date %s', value => {
    expect(fhirDate(value)).toBeNull();
  });
});
