import { formatLocalDate } from './lib/clock';
import type { NHIData } from './parsers/types';
import { RECORD_TYPES, type MergeStats, type RecordType, type StoredRecords } from './recordStore';

export const RECORD_TYPE_LABELS: Record<RecordType, string> = {
  r1: '就醫紀錄', r2: '住院紀錄', r3: '牙科就醫', r6: '疫苗接種', r7: '檢驗結果', r8: '健康檢查', fhir: 'FHIR 資源',
};

const RESOURCE_LABELS: Record<string, string> = {
  Patient: '病人', Encounter: '就醫', Observation: '檢驗檢查', DiagnosticReport: '檢查報告', DocumentReference: '文件',
  ImagingStudy: '影像檢查', Media: '影像媒體', Binary: '二進位附件', Immunization: '疫苗', Medication: '藥品',
  MedicationRequest: '處方', MedicationStatement: '用藥紀錄', MedicationDispense: '領藥', Condition: '診斷',
  Procedure: '處置', Organization: '院所', Practitioner: '醫師', PractitionerRole: '醫師角色', Location: '地點', Composition: '文件組合',
};

export function resourceTypeLabel(type: string): string {
  return RESOURCE_LABELS[type] ?? type;
}

export interface ImportPreviewRow {
  key: string;
  label: string;
  incoming: number;
  added?: number;
  updated?: number;
  skipped?: number;
}

export interface ImportPreviewAttachments {
  /** 含附件的報告數。 */
  reports: number;
  /** 影像類報告數（DiagnosticReport／ImagingStudy／Media）。 */
  imagingReports: number;
  /** 附件總數，含無法預覽的格式。 */
  total: number;
  /** 可直接在瀏覽器預覽的附件數。 */
  previewable: number;
  /** 只有外部連結、不會下載的附件數。 */
  external: number;
  /** 以參考（Reference）連結、需匯入後才解析的附件數。 */
  references: number;
  /** 無法在瀏覽器預覽的格式。 */
  unsupported: string[];
}

export interface ImportPreview {
  fileName: string;
  fileSize: number;
  format: 'NHI' | 'FHIR';
  /** true 表示統計來自大型檔案的串流掃描，新增／略過筆數在匯入時才確定。 */
  estimated: boolean;
  needsConfirmation: boolean;
  /** 資料日期範圍（YYYY-MM-DD）。 */
  from: string | null;
  to: string | null;
  counts: { incoming: number; added?: number; updated?: number; skipped?: number };
  existingTotal: number;
  totalAfter: number | null;
  rows: ImportPreviewRow[];
  resourceTypes: { type: string; label: string; count: number }[];
  attachments: ImportPreviewAttachments;
  warnings: string[];
}

export type PreviewData = Pick<NHIData,
  'visits' | 'hospitalizations' | 'vaccinations' | 'labResults' | 'textLabResults' | 'checkupReports' | 'dentalVisits' | 'medicalReports' | 'medications'>;

function dateBounds(data: PreviewData): { from: string | null; to: string | null } {
  let min = Infinity;
  let max = -Infinity;
  const add = (value: Date | null | undefined) => {
    if (!value) return;
    const time = value.getTime();
    if (!Number.isFinite(time)) return;
    if (time < min) min = time;
    if (time > max) max = time;
  };
  for (const item of data.visits) add(item.date);
  for (const item of data.hospitalizations) { add(item.admitDate); add(item.dischargeDate); }
  for (const item of data.vaccinations) add(item.date);
  for (const item of data.labResults) add(item.date);
  for (const item of data.textLabResults) add(item.date);
  for (const item of data.checkupReports) add(item.date);
  for (const item of data.dentalVisits) add(item.date);
  for (const item of data.medicalReports) add(item.date);
  for (const item of data.medications) add(item.date);
  return {
    from: Number.isFinite(min) ? formatLocalDate(new Date(min)) : null,
    to: Number.isFinite(max) ? formatLocalDate(new Date(max)) : null,
  };
}

function attachmentSummary(data: Pick<PreviewData, 'medicalReports'>): ImportPreviewAttachments {
  const unsupported = new Set<string>();
  let reports = 0;
  let imagingReports = 0;
  let total = 0;
  let external = 0;
  for (const report of data.medicalReports) {
    if (report.kind === 'imaging') imagingReports++;
    if (report.attachments.length + report.externalAttachmentCount + (report.unsupportedAttachmentTypes?.length ?? 0) > 0) reports++;
    total += report.attachments.length;
    external += report.externalAttachmentCount;
    for (const type of report.unsupportedAttachmentTypes ?? []) unsupported.add(type);
  }
  return { reports, imagingReports, total, previewable: total, external, references: 0, unsupported: [...unsupported].sort() };
}

export function recordsTotal(records: StoredRecords): number {
  return RECORD_TYPES.reduce((sum, type) => sum + Object.keys(records[type] ?? {}).length, 0);
}

function fhirBreakdown(records: StoredRecords): { type: string; label: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const resource of Object.values(records.fhir ?? {})) {
    const type = String((resource as { resourceType?: unknown }).resourceType ?? '未知');
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([type, count]) => ({ type, label: resourceTypeLabel(type), count }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

/** 完整統計：以合併後的紀錄推導，數字與匯入後畫面完全一致。 */
export function buildMergedPreview(args: {
  fileName: string;
  fileSize: number;
  format: 'NHI' | 'FHIR';
  needsConfirmation: boolean;
  stats: MergeStats;
  records: StoredRecords;
  data: PreviewData;
  warnings: readonly string[];
}): ImportPreview {
  const { stats, records } = args;
  const rows: ImportPreviewRow[] = RECORD_TYPES.filter(type => type !== 'fhir').map(type => ({
    key: type, label: RECORD_TYPE_LABELS[type], incoming: stats[type].added + stats[type].updated + stats[type].skipped,
    added: stats[type].added, updated: stats[type].updated, skipped: stats[type].skipped,
  })).filter(row => row.incoming > 0);
  const fhirRow = stats.fhir.added + stats.fhir.updated + stats.fhir.skipped;
  if (fhirRow > 0) {
    rows.push({ key: 'fhir', label: RECORD_TYPE_LABELS.fhir, incoming: fhirRow, added: stats.fhir.added, updated: stats.fhir.updated, skipped: stats.fhir.skipped });
  }
  const added = Object.values(stats).reduce((sum, item) => sum + item.added, 0);
  const updated = Object.values(stats).reduce((sum, item) => sum + item.updated, 0);
  const skipped = Object.values(stats).reduce((sum, item) => sum + item.skipped, 0);
  const warnings = [...args.warnings];
  if (args.needsConfirmation) warnings.unshift('病人身分無法自動比對，需由你勾選確認後才會匯入');
  return {
    fileName: args.fileName, fileSize: args.fileSize, format: args.format, estimated: false,
    needsConfirmation: args.needsConfirmation,
    ...dateBounds(args.data),
    counts: { incoming: added + updated + skipped, added, updated, skipped },
    existingTotal: recordsTotal(records) - added,
    totalAfter: recordsTotal(records),
    rows,
    resourceTypes: fhirRow > 0 ? fhirBreakdown(records) : [],
    attachments: attachmentSummary(args.data),
    warnings,
  };
}

export interface ScanSummary {
  /** NHI 為 r1..r8，FHIR 為各資源型別。 */
  counts: Record<string, number>;
  from: string | null;
  to: string | null;
  attachments: { reports: number; imagingReports: number; inline: number; previewable: number; references: number; unsupported: string[] };
}

/** 串流掃描統計：不載入整份檔案，因此新增／略過筆數留待匯入時計算。 */
export function buildScannedPreview(args: {
  fileName: string;
  fileSize: number;
  format: 'NHI' | 'FHIR';
  needsConfirmation: boolean;
  summary: ScanSummary;
  existingTotal: number;
}): ImportPreview {
  const { summary } = args;
  const rows = Object.entries(summary.counts)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => ({
      key, label: args.format === 'NHI' ? RECORD_TYPE_LABELS[key as RecordType] ?? key : resourceTypeLabel(key), incoming: count,
    }))
    .sort((a, b) => b.incoming - a.incoming || a.key.localeCompare(b.key));
  const incoming = rows.reduce((sum, row) => sum + row.incoming, 0);
  return {
    fileName: args.fileName, fileSize: args.fileSize, format: args.format, estimated: true,
    needsConfirmation: args.needsConfirmation,
    from: summary.from,
    to: summary.to,
    counts: { incoming },
    existingTotal: args.existingTotal,
    totalAfter: null,
    rows,
    resourceTypes: args.format === 'FHIR' ? rows.map(row => ({ type: row.key, label: row.label, count: row.incoming })) : [],
    attachments: {
      reports: summary.attachments.reports,
      imagingReports: summary.attachments.imagingReports,
      total: summary.attachments.inline,
      previewable: summary.attachments.previewable,
      external: 0,
      references: summary.attachments.references,
      unsupported: summary.attachments.unsupported,
    },
    warnings: args.needsConfirmation ? ['病人身分無法自動比對，需由你勾選確認後才會匯入'] : [],
  };
}
