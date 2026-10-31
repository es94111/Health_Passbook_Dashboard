import { describe, expect, it } from 'vitest';
import { isFhirBundle, parseFhirResources, readFhirBundleResources } from './fhir-parser';
import { mergeNHIJson, emptyRecords, flattenRecords } from '../cryptoVault';
import { parseNHIJson } from './nhi-parser';

const SAMPLE_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const localDay = (date: Date | null | undefined) => date
  ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  : '';
const bundle = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    { resource: { resourceType: 'Patient', id: 'person-a', identifier: [{ system: 'urn:synthetic', value: 'synthetic-a' }] } },
    { resource: { resourceType: 'Encounter', id: 'enc-1', class: { code: 'AMB' }, period: { start: '2026-10-01' },
      serviceProvider: { display: '測試醫院' } } },
    { resource: { resourceType: 'Observation', id: 'lab-1', code: { text: '葡萄糖' }, effectiveDateTime: '2026-10-02',
      valueQuantity: { value: 105, unit: 'mg/dL' }, referenceRange: [{ low: { value: 70 }, high: { value: 99 } }] } },
    { resource: { resourceType: 'Observation', id: 'lab-text', code: { text: '檢驗備註' }, effectiveDateTime: '2026-10-02',
      valueString: '未發現異常' } },
    { resource: { resourceType: 'DiagnosticReport', id: 'report-1', code: { text: '影像報告' }, effectiveDateTime: '2026-10-03',
      conclusion: '正常', presentedForm: [{ contentType: 'image/png', title: '預覽', data: SAMPLE_PNG }] } },
    { resource: { resourceType: 'MedicationRequest', id: 'med-1', authoredOn: '2026-10-03',
      medicationCodeableConcept: { text: '測試藥品' }, dosageInstruction: [{ text: '每日一次' }] } },
  ],
} as const;

describe('NHI-FHIR Bridge Bundle import', () => {
  it('recognizes FHIR but not legacy NHI JSON', () => {
    expect(isFhirBundle(bundle)).toBe(true);
    expect(isFhirBundle({ myhealthbank: { bdata: {} } })).toBe(false);
  });
  it('keeps records and maps labs, reports, images, medications and visits', () => {
    const resources = readFhirBundleResources(bundle);
    const parsed = parseFhirResources(resources);
    expect(parsed.visits).toHaveLength(1);
    expect(parsed.labResults).toHaveLength(1);
    expect(parsed.labResults[0].value).toBe(105);
    expect(parsed.labResults[0].unit).toBe('mg/dL');
    expect(parsed.medicalReports).toHaveLength(1);
    expect(parsed.textLabResults[0].text).toBe('未發現異常');
    const report = parsed.medicalReports.find(r => r.title === '影像報告');
    expect(report?.kind).toBe('imaging');
    expect(report?.attachments[0].data).toBe(SAMPLE_PNG);
    expect(parsed.medications[0].name).toBe('測試藥品');
  });
  it('merges repeated imports without duplicating resources', async () => {
    const first = await mergeNHIJson(emptyRecords(), bundle);
    expect(first.stats.fhir.added).toBe(bundle.entry.length);
    const second = await mergeNHIJson(first.records, bundle);
    expect(second.stats.fhir.added).toBe(0);
    expect(second.stats.fhir.skipped).toBe(bundle.entry.length);
    const restored = parseNHIJson(flattenRecords(second.records));
    expect(restored.labResults).toHaveLength(1);
    expect(restored.textLabResults[0].text).toBe('未發現異常');
    expect(second.pendingAttachments).toHaveLength(0);
  });
  it('updates a changed resource with the same stable identifier', async () => {
    const first = await mergeNHIJson(emptyRecords(), bundle);
    const changed = JSON.parse(JSON.stringify(bundle));
    changed.entry[2].resource.valueQuantity.value = 115;
    const second = await mergeNHIJson(first.records, changed);
    expect(second.stats.fhir.updated).toBe(1);
    expect(parseNHIJson(flattenRecords(second.records)).labResults[0].value).toBe(115);
  });
  it('refuses to combine known different patients', async () => {
    const first = await mergeNHIJson(emptyRecords(), bundle);
    const another = JSON.parse(JSON.stringify(bundle));
    another.entry[0].resource.identifier[0].value = 'synthetic-b';
    await expect(mergeNHIJson(first.records, another, { confirmPatient: true })).rejects.toThrow('不同的病人');
  });
  it('rejects invalid or mixed-patient Bundles', () => {
    expect(() => readFhirBundleResources({ resourceType: 'Bundle', entry: [] })).toThrow();
    expect(() => readFhirBundleResources({ resourceType: 'Bundle', entry: [
      { resource: { resourceType: 'Patient', id: 'a' } },
      { resource: { resourceType: 'Patient', id: 'b' } },
    ] })).toThrow('只能包含一位');
  });
  it('does not trust external URLs or SVG as image attachments', () => {
    const malicious = [
      { resourceType: 'DocumentReference', id: 'doc-1', date: '2026-10-03',
        content: [{ attachment: { contentType: 'image/svg+xml', data: SAMPLE_PNG } },
          { attachment: { contentType: 'image/png', url: 'https://example.test/secret.png' } }] },
    ];
    expect(parseFhirResources(malicious).medicalReports[0].attachments).toHaveLength(0);
  });
  it('separates imaging reports and extracts modalities, body sites and series', () => {
    const resources = [
      { resourceType: 'ImagingStudy', id: 'study-1', status: 'available', started: '2026-10-04', description: '胸部電腦斷層',
        modality: [{ system: 'http://dicom.nema.org/resources/ontology/DCM', code: 'CT', display: 'CT' }],
        note: [{ text: '需與舊片比較' }],
        series: [
          { uid: '1.2', modality: { code: 'CT', display: 'CT' }, bodySite: { code: '51185008', display: '胸部' }, description: '軸位', numberOfInstances: 120 },
          { uid: '1.3', modality: { code: 'CT', display: 'CT' }, bodySite: { display: '胸部' }, instance: [{}, {}] },
        ] },
      { resourceType: 'DiagnosticReport', id: 'report-imaging', status: 'final', code: { text: '胸部電腦斷層報告' }, effectiveDateTime: '2026-10-04',
        imagingStudy: [{ reference: 'ImagingStudy/study-1' }], conclusion: '無異常',
        presentedForm: [{ contentType: 'application/pdf', title: '報告', data: 'JVBERi0xLjQ=' }] },
      { resourceType: 'DiagnosticReport', id: 'report-general', status: 'final', code: { text: '血液檢查報告' }, effectiveDateTime: '2026-10-05', conclusion: '正常' },
      { resourceType: 'Media', id: 'media-1', status: 'completed', createdDateTime: '2026-10-06', modality: { text: 'X光' }, bodySite: { text: '胸部' },
        content: { contentType: 'image/png', title: '胸部X光', data: SAMPLE_PNG } },
      { resourceType: 'DocumentReference', id: 'doc-imaging', status: 'current', type: { text: '影像報告' }, date: '2026-10-07',
        content: [{ attachment: { contentType: 'application/pdf', title: '影像報告', data: 'JVBERi0xLjQ=' } }] },
    ];
    const parsed = parseFhirResources(resources);
    expect(parsed.medicalReports).toHaveLength(5);
    expect(parsed.medicalReports.filter(report => report.kind === 'general').map(report => report.title)).toEqual(['血液檢查報告']);

    const study = parsed.medicalReports.find(report => report.title === '胸部電腦斷層');
    expect(study?.kind).toBe('imaging');
    expect(localDay(study?.date)).toBe('2026-10-04');
    expect(study?.text).toContain('需與舊片比較');
    expect(study?.imaging).toMatchObject({
      modalities: ['CT'], bodySites: ['胸部'], instanceCount: 122, status: 'available', studyDescription: '胸部電腦斷層',
    });
    expect(study?.imaging?.series.map(series => series.instances)).toEqual([120, 2]);

    const report = parsed.medicalReports.find(report => report.title === '胸部電腦斷層報告');
    expect(report?.kind).toBe('imaging');
    expect(report?.attachments).toHaveLength(1);
    expect(report?.imaging).toMatchObject({
      modalities: ['CT'], bodySites: ['胸部'], instanceCount: 122, status: 'final', studyDescription: '胸部電腦斷層',
    });

    const media = parsed.medicalReports.find(report => report.title === 'X光');
    expect(media?.kind).toBe('imaging');
    expect(localDay(media?.date)).toBe('2026-10-06');
    expect(media?.imaging).toMatchObject({ modalities: ['X光'], bodySites: ['胸部'], instanceCount: 1, studyDescription: '胸部X光' });

    const document = parsed.medicalReports.find(report => report.title === '影像報告');
    expect(document?.kind).toBe('imaging');
    expect(localDay(document?.date)).toBe('2026-10-07');
  });
});
