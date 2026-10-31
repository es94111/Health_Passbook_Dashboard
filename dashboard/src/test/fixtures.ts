import type { FhirObject } from '../parsers/fhir-common';

export const SYNTHETIC_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
export function syntheticBundle(extra: FhirObject[] = []): FhirObject {
  return { resourceType: 'Bundle', type: 'collection', timestamp: '2026-10-30T08:00:00Z',
    entry: [
      { fullUrl: 'urn:uuid:synthetic-patient', resource: { resourceType: 'Patient', id: 'synthetic-patient', identifier: [{ system: 'urn:test:patient', value: 'synthetic-a' }] } },
      ...extra.map(resource => ({ fullUrl: `urn:uuid:${String(resource.id ?? resource.resourceType)}`, resource: { subject: { reference: 'urn:uuid:synthetic-patient' }, ...resource } })),
    ] };
}
export const syntheticNhi = { myhealthbank: { pdata: { notice: 'synthetic-only' }, bdata: {
  r1: [{ 'r1.4': '測試院所', 'r1.5': '20261001', 'r1.7': 'synthetic-visit', 'r1.8': 'Z00', 'r1.9': '測試', r1_1: [] }],
  r7: [{ 'r7.4': '測試院所', 'r7.5': '20261002', 'r7.7': 'synthetic-lab', 'r7.10': '測試檢驗', 'r7.11': '12.5 mg/dL', 'r7.12': '[1][20]' }],
} } };
