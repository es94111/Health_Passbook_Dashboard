import { describe, expect, it } from 'vitest';
import { buildMergedPreview, buildScannedPreview, recordsTotal, resourceTypeLabel } from './importPreview';
import { emptyRecords, flattenRecords, type StoredRecords } from './recordStore';
import { mergeNHIJson } from './recordImport';
import { parseNHIJson } from './parsers/nhi-parser';
import { SYNTHETIC_PNG, syntheticBundle, syntheticNhi } from './test/fixtures';

async function merged(input: object, existing: StoredRecords = emptyRecords()) {
  const { records, stats, pendingAttachments } = await mergeNHIJson(existing, input, { confirmPatient: true });
  return { records, stats, pendingAttachments, data: parseNHIJson(flattenRecords(records)) };
}

const inlinePng = { contentType: 'image/png', title: '影像', data: SYNTHETIC_PNG };

function diagnosticReport(presentedForm: unknown[], extra: object = {}) {
  return {
    resourceType: 'DiagnosticReport', id: 'report-1', status: 'final', code: { text: '胸腔 X 光' },
    effectiveDateTime: '2024-03-05', presentedForm, ...extra,
  };
}

describe('buildMergedPreview', () => {
  it('reports exact counts for a first FHIR import', async () => {
    const { records, stats, data } = await merged(syntheticBundle([diagnosticReport([inlinePng])]));
    const preview = buildMergedPreview({
      fileName: 'synthetic.json', fileSize: 1234, format: 'FHIR', needsConfirmation: false, stats, records, data, warnings: [],
    });
    expect(preview).toMatchObject({
      fileName: 'synthetic.json', fileSize: 1234, format: 'FHIR', estimated: false, needsConfirmation: false,
      from: '2024-03-05', to: '2024-03-05',
      counts: { incoming: 2, added: 2, updated: 0, skipped: 0 },
      existingTotal: 0, totalAfter: 2, warnings: [],
    });
    expect(preview.rows).toEqual([{ key: 'fhir', label: 'FHIR 資源', incoming: 2, added: 2, updated: 0, skipped: 0 }]);
    expect(preview.resourceTypes).toContainEqual({ type: 'DiagnosticReport', label: '檢查報告', count: 1 });
    expect(preview.attachments).toEqual({
      reports: 1, imagingReports: 1, total: 1, previewable: 1, external: 0, references: 0, unsupported: [],
    });
  });

  it('keeps local calendar dates for FHIR and NHI records', async () => {
    const fhir = await merged(syntheticBundle([diagnosticReport([inlinePng])]));
    expect(buildMergedPreview({ fileName: 'a.json', fileSize: 1, format: 'FHIR', needsConfirmation: false, ...fhir, warnings: [] }))
      .toMatchObject({ from: '2024-03-05', to: '2024-03-05' });
    const nhi = await merged(syntheticNhi);
    const preview = buildMergedPreview({ fileName: 'b.json', fileSize: 1, format: 'NHI', needsConfirmation: true, ...nhi, warnings: [] });
    expect(preview).toMatchObject({ format: 'NHI', from: '2026-10-01', to: '2026-10-02' });
    expect(preview.rows).toEqual([
      { key: 'r1', label: '就醫紀錄', incoming: 1, added: 1, updated: 0, skipped: 0 },
      { key: 'r7', label: '檢驗結果', incoming: 1, added: 1, updated: 0, skipped: 0 },
    ]);
    expect(preview.resourceTypes).toEqual([]);
    expect(preview.warnings[0]).toContain('病人身分');
  });

  it('marks imaging reports and lists attachment formats that cannot be previewed', async () => {
    const { records, stats, data } = await merged(syntheticBundle([
      diagnosticReport([{ contentType: 'application/dicom', data: 'AAECAw==' }, { contentType: 'application/pdf', url: 'https://example.test/scan' }], {
        imagingStudy: [{ reference: 'ImagingStudy/1' }],
      }),
    ]));
    const preview = buildMergedPreview({ fileName: 'c.json', fileSize: 1, format: 'FHIR', needsConfirmation: false, stats, records, data, warnings: [] });
    expect(preview.attachments).toEqual({
      reports: 1, imagingReports: 1, total: 0, previewable: 0, external: 1, references: 0, unsupported: ['application/dicom'],
    });
  });

  it('counts duplicates as skipped and keeps the existing baseline', async () => {
    const first = await merged(syntheticBundle([diagnosticReport([inlinePng])]));
    const second = await merged(syntheticBundle([diagnosticReport([inlinePng])]), first.records);
    const preview = buildMergedPreview({
      fileName: 'd.json', fileSize: 1, format: 'FHIR', needsConfirmation: false, ...second, warnings: ['略過 2 筆重複資料'],
    });
    expect(preview.counts).toEqual({ incoming: 2, added: 0, updated: 0, skipped: 2 });
    expect(preview.existingTotal).toBe(2);
    expect(preview.totalAfter).toBe(2);
    expect(preview.rows).toEqual([{ key: 'fhir', label: 'FHIR 資源', incoming: 2, added: 0, updated: 0, skipped: 2 }]);
    expect(preview.warnings).toEqual(['略過 2 筆重複資料']);
  });
});

describe('buildScannedPreview', () => {
  it('summarises a streamed scan without inventing added or skipped counts', () => {
    const preview = buildScannedPreview({
      fileName: 'large.json', fileSize: 40 * 1024 * 1024, format: 'FHIR', needsConfirmation: false, existingTotal: 3,
      summary: {
        counts: { Observation: 5, DiagnosticReport: 1 }, from: '2024-01-02', to: '2025-05-06',
        attachments: { reports: 1, imagingReports: 0, inline: 2, previewable: 1, references: 0, unsupported: ['application/dicom'] },
      },
    });
    expect(preview).toMatchObject({
      fileName: 'large.json', fileSize: 40 * 1024 * 1024, format: 'FHIR', estimated: true,
      from: '2024-01-02', to: '2025-05-06', counts: { incoming: 6 }, existingTotal: 3, totalAfter: null, warnings: [],
    });
    expect(preview.counts).not.toHaveProperty('added');
    expect(preview.rows).toEqual([
      { key: 'Observation', label: '檢驗檢查', incoming: 5 },
      { key: 'DiagnosticReport', label: '檢查報告', incoming: 1 },
    ]);
    expect(preview.resourceTypes).toEqual(preview.rows.map(row => ({ type: row.key, label: row.label, count: row.incoming })));
    expect(preview.attachments).toEqual({
      reports: 1, imagingReports: 0, total: 2, previewable: 1, external: 0, references: 0, unsupported: ['application/dicom'],
    });
  });

  it('labels NHI record types and asks for identity confirmation', () => {
    const preview = buildScannedPreview({
      fileName: 'large.json', fileSize: 40 * 1024 * 1024, format: 'NHI', needsConfirmation: true, existingTotal: 0,
      summary: {
        counts: { r7: 2, r1: 1, r2: 0 }, from: null, to: null,
        attachments: { reports: 0, imagingReports: 0, inline: 0, previewable: 0, references: 0, unsupported: [] },
      },
    });
    expect(preview.rows).toEqual([
      { key: 'r7', label: '檢驗結果', incoming: 2 },
      { key: 'r1', label: '就醫紀錄', incoming: 1 },
    ]);
    expect(preview.resourceTypes).toEqual([]);
    expect(preview.counts).toEqual({ incoming: 3 });
    expect(preview.from).toBeNull();
    expect(preview.warnings[0]).toContain('病人身分');
  });
});

describe('preview helpers', () => {
  it('counts every stored record type and falls back to raw resource type labels', async () => {
    expect(recordsTotal(emptyRecords())).toBe(0);
    const { records } = await merged(syntheticBundle([diagnosticReport([inlinePng])]));
    expect(recordsTotal(records)).toBe(2);
    expect(resourceTypeLabel('DiagnosticReport')).toBe('檢查報告');
    expect(resourceTypeLabel('UnmappedType')).toBe('UnmappedType');
  });
});
