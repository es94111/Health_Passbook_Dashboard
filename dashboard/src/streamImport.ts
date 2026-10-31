import { JSONParser } from '@streamparser/json';
import { canonicalJson, fhirDate, object, sha256, string, type FhirObject } from './parsers/fhir-common';
import { patientIdentifiers } from './parsers/fhir-parser';
import { parseNHIDate } from './parsers/nhi-parser';
import {
  attachmentType, createAttachmentSeparator, MAX_IMPORT_FILE_BYTES, MAX_RECORD_BYTES, SOURCE_CHUNK_BYTES,
  type AttachmentMetadata, type PendingAttachment,
} from './medicalAttachments';
import type { ScanSummary } from './importPreview';
import { formatLocalDate } from './lib/clock';
import { LEGACY_DATE_FIELDS, patientIdentityDecision } from './recordImport';
import { RECORD_TYPES, type RecordType, type SourceChunk, type StoredRecords } from './recordStore';

const SCAN_READ_BYTES = 4 * 1024 * 1024;
const MAX_FHIR_ENTRIES = 100_000;
const RESOURCE_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]+$/;
const RESOURCE_ID_PATTERN = /^[A-Za-z0-9.-]{1,64}$/;
type NhiType = Exclude<RecordType, 'fhir'>;
const NHI_TYPES: readonly NhiType[] = RECORD_TYPES.filter((type): type is NhiType => type !== 'fhir');

export interface ImportScanResult {
  format: 'NHI' | 'FHIR';
  needsConfirmation: boolean;
  summary: ScanSummary;
}

export interface SourceChunkUpload {
  id: string;
  bytes: Uint8Array<ArrayBuffer>;
}

/** Sink provided by the caller so this module never touches crypto or the network directly. */
export interface LargeImportSink {
  uploadSourceChunk(chunk: SourceChunkUpload): Promise<void>;
  uploadAttachment(attachment: PendingAttachment): Promise<void>;
}

export interface ExtractedImport {
  /** Attachment-separated document, small enough to live in the encrypted manifest. */
  json: FhirObject;
  attachments: Record<string, AttachmentMetadata>;
  warnings: string[];
  chunks: SourceChunk[];
  sourceId: string;
}

function assertImportFile(file: File): void {
  if (!file.size) throw new Error('檔案是空的，請選擇 Bridge 匯出的 JSON 檔');
  if (file.size > MAX_IMPORT_FILE_BYTES) throw new Error('檔案超過 4 GiB 單檔上限，請分次匯入');
}

async function readSlice(file: File, start: number, end: number): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

function stripBom(bytes: Uint8Array, first: boolean): Uint8Array {
  return first && bytes.length > 2 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
}

function nhiType(key: unknown): NhiType | null {
  return NHI_TYPES.includes(key as NhiType) ? key as NhiType : null;
}

const IMAGING_RESOURCE_TYPES = new Set(['ImagingStudy', 'Media']);
const REPORT_RESOURCE_TYPES = new Set(['DiagnosticReport', 'DocumentReference', 'ImagingStudy', 'Media']);

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

/** 掃描階段可見的日期欄位；與 fhir-parser 的取用順序一致。 */
function resourceDate(resource: FhirObject): Date | null {
  return fhirDate(
    resource.effectiveDateTime, object(resource.effectivePeriod).start, resource.issued, resource.date,
    resource.created, resource.createdDateTime, object(resource.period).start, resource.started,
    resource.authoredOn, resource.occurrenceDateTime, resource.recorded, resource.whenHandedOver,
    resource.whenPrepared, resource.dateAsserted,
  );
}

/** 尚未分離的附件來源；參考形式的附件要等匯入解析後才知道有沒有內容。 */
function rawAttachments(resource: FhirObject): unknown[] {
  return [
    ...listOf(resource.presentedForm),
    ...listOf(resource.content).map(item => object(item).attachment ?? item),
    ...listOf(resource.media).map(item => object(item).link ?? item),
    ...listOf(resource.image),
  ];
}

interface ScanTally {
  counts: Record<string, number>;
  min: number;
  max: number;
  reports: number;
  imagingReports: number;
  inline: number;
  previewable: number;
  references: number;
  unsupported: Set<string>;
}

function tally(): ScanTally {
  return {
    counts: {}, min: Infinity, max: -Infinity,
    reports: 0, imagingReports: 0, inline: 0, previewable: 0, references: 0, unsupported: new Set(),
  };
}

function noteDate(state: ScanTally, date: Date | null): void {
  if (!date) return;
  const time = date.getTime();
  if (!Number.isFinite(time)) return;
  if (time < state.min) state.min = time;
  if (time > state.max) state.max = time;
}

function tallySummary(state: ScanTally): ScanSummary {
  const iso = (time: number) => Number.isFinite(time) ? formatLocalDate(new Date(time)) : null;
  return {
    counts: state.counts,
    from: iso(state.min),
    to: iso(state.max),
    attachments: {
      reports: state.reports, imagingReports: state.imagingReports, inline: state.inline,
      previewable: state.previewable, references: state.references, unsupported: [...state.unsupported].sort(),
    },
  };
}

/** Rejects anything that is not a complete, exportable FHIR Bundle before a single byte is stored. */
function assertBundleShape(state: {
  type: unknown; total: unknown; links: unknown[]; entries: number; patients: FhirObject[];
}): FhirObject {
  if (state.type !== undefined && !['collection', 'document', 'searchset'].includes(String(state.type))) {
    throw new Error('目前僅支援 collection、document 或完整 searchset Bundle，不執行交易或刪除指令');
  }
  if (!state.entries || state.entries > MAX_FHIR_ENTRIES) throw new Error('FHIR Bundle 資源數量必須介於 1 至 100,000');
  if (state.links.some(link => object(link).relation === 'next') ||
      (state.type === 'searchset' && typeof state.total === 'number' && state.total > state.entries)) {
    throw new Error('FHIR Bundle 仍有未下載分頁，請匯出完整資料後再匯入');
  }
  const [patient] = state.patients;
  if (!patient) throw new Error('FHIR Bundle 必須包含且只能包含一位 Patient，請將不同病人資料分開匯入');
  return patient;
}

export async function scanImportFile(
  file: File,
  existing: StoredRecords,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<ImportScanResult> {
  assertImportFile(file);
  let resourceType: unknown;
  let bundleType: unknown;
  let bundleTotal: unknown;
  let links: unknown[] = [];
  let entries = 0;
  let nhiItems = 0;
  let nhiShapeError = false;
  const fullUrls = new Set<string>();
  const patients: FhirObject[] = [];
  const patientFullUrls: string[] = [];
  const nhiTally = tally();
  const fhirTally = tally();

  const countNhi = (type: NhiType, record: FhirObject) => {
    nhiTally.counts[type] = (nhiTally.counts[type] ?? 0) + 1;
    for (const field of LEGACY_DATE_FIELDS[type] ?? []) {
      const raw = string(record[field]);
      if (!raw) continue;
      try { noteDate(nhiTally, parseNHIDate(raw)); } catch { /* 匯入時會回報日期格式問題 */ }
    }
  };

  const countResource = (type: string, resource: FhirObject) => {
    fhirTally.counts[type] = (fhirTally.counts[type] ?? 0) + 1;
    noteDate(fhirTally, resourceDate(resource));
    if (!REPORT_RESOURCE_TYPES.has(type)) return;
    const values = rawAttachments(resource);
    if (!values.length) return;
    fhirTally.reports++;
    if (IMAGING_RESOURCE_TYPES.has(type)) fhirTally.imagingReports++;
    for (const value of values) {
      const raw = object(value);
      if (typeof raw.data === 'string' && raw.data) {
        fhirTally.inline++;
        const mime = attachmentType(raw.contentType);
        if (mime) fhirTally.previewable++;
        else fhirTally.unsupported.add(string(raw.contentType).toLowerCase().split(';')[0].trim() || '未知格式');
      } else fhirTally.references++;
    }
  };

  const paths = ['$.resourceType', '$.type', '$.total', '$.link', '$.entry.*',
    ...NHI_TYPES.flatMap(type => [`$.${type}.*`, `$.myhealthbank.bdata.${type}.*`])];
  const parser = new JSONParser({ paths, keepStack: false });
  parser.onValue = info => {
    const { key, stack, value } = info;
    if (stack.length === 1) {
      if (key === 'resourceType') resourceType = value;
      else if (key === 'type') bundleType = value;
      else if (key === 'total') bundleTotal = value;
      else if (key === 'link') links = Array.isArray(value) ? value : [];
      return;
    }
    const container = stack[stack.length - 1];
    const type = nhiType(container.key);
    const wrapped = stack.length === 4 && stack[1].key === 'myhealthbank' && stack[2].key === 'bdata';
    if (type && (stack.length === 2 || wrapped)) {
      if (!Array.isArray(info.parent) || !value || typeof value !== 'object' || Array.isArray(value)) nhiShapeError = true;
      else {
        nhiItems++;
        countNhi(type, object(value));
      }
      return;
    }
    if (stack.length !== 2 || container.key !== 'entry') return;
    if (!Array.isArray(info.parent)) {
      nhiShapeError = true;
      return;
    }
    entries++;
    if (entries > MAX_FHIR_ENTRIES) throw new Error('FHIR Bundle 資源數量必須介於 1 至 100,000');
    const entry = object(value);
    const resource = object(entry.resource);
    const resourceTypeName = string(resource.resourceType);
    if (!RESOURCE_TYPE_PATTERN.test(resourceTypeName) ||
        (resource.id !== undefined && !RESOURCE_ID_PATTERN.test(string(resource.id)))) {
      throw new Error('FHIR entry 含有缺漏或格式錯誤的 resource，已中止整份匯入');
    }
    countResource(resourceTypeName, resource);
    const fullUrl = string(entry.fullUrl);
    if (fullUrl) {
      if (fullUrls.has(fullUrl)) throw new Error('FHIR Bundle 含有重複的 fullUrl，無法安全關聯資源');
      fullUrls.add(fullUrl);
    }
    if (resourceTypeName === 'Patient') {
      patients.push(resource);
      patientFullUrls.push(fullUrl);
    }
  };

  for (let offset = 0; offset < file.size; offset += SCAN_READ_BYTES) {
    signal?.throwIfAborted();
    const bytes = await readSlice(file, offset, Math.min(offset + SCAN_READ_BYTES, file.size));
    parser.write(stripBom(bytes, offset === 0));
    onProgress?.(Math.min(offset + bytes.length, file.size) / file.size);
  }
  if (!parser.isEnded) parser.end();
  signal?.throwIfAborted();

  if (resourceType !== undefined) {
    if (resourceType !== 'Bundle') throw new Error('請選擇完整的 FHIR R4 Bundle JSON，而非單一 FHIR resource');
    const patient = assertBundleShape({ type: bundleType, total: bundleTotal, links, entries, patients });
    if (!string(patient.id) && !string(patientFullUrls[0]) && !patientIdentifiers(patient).size) {
      throw new Error('Patient 缺少可建立關聯的 id、fullUrl 或 identifier');
    }
    return {
      format: 'FHIR',
      needsConfirmation: patientIdentityDecision(existing, patient),
      summary: tallySummary(fhirTally),
    };
  }
  if (!nhiItems || nhiShapeError) throw new Error('不是支援的 NHI JSON 或 FHIR Bundle，既有資料未變更');
  return { format: 'NHI', needsConfirmation: true, summary: tallySummary(nhiTally) };
}

export async function extractImportFile(
  file: File,
  format: 'NHI' | 'FHIR',
  existing: StoredRecords,
  sink: LargeImportSink,
  signal?: AbortSignal,
  onProgress?: (ratio: number) => void,
): Promise<ExtractedImport> {
  assertImportFile(file);
  const separator = createAttachmentSeparator(existing.attachments);
  const encoder = new TextEncoder();
  let textBytes = 0;
  const account = (value: unknown) => {
    textBytes += encoder.encode(JSON.stringify(value)).length;
    if (textBytes > MAX_RECORD_BYTES) {
      throw new Error('病歷文字內容超過 8 GiB 上限；請在 Bridge 縮小日期範圍後分次匯入，或關閉影像再匯出');
    }
  };

  let bundleType: unknown;
  let bundleTotal: unknown;
  let links: unknown[] = [];
  const entries: unknown[] = [];
  const rootRecords = new Map<NhiType, unknown[]>();
  const wrappedRecords = new Map<NhiType, unknown[]>();
  const queue: (() => Promise<void>)[] = [];
  const drain = async () => { while (queue.length) await queue.shift()!(); };
  const collect = (target: Map<NhiType, unknown[]>, type: NhiType, value: unknown) => {
    queue.push(async () => {
      const { json, pending } = await separator.separate(value);
      for (const attachment of pending) await sink.uploadAttachment(attachment);
      account(json);
      const list = target.get(type);
      if (list) list.push(json);
      else target.set(type, [json]);
    });
  };

  const paths = format === 'FHIR' ? ['$.type', '$.total', '$.link', '$.entry.*']
    : NHI_TYPES.flatMap(type => [`$.${type}.*`, `$.myhealthbank.bdata.${type}.*`]);
  const parser = new JSONParser({ paths, keepStack: false });
  parser.onValue = info => {
    const { key, stack, value } = info;
    if (format === 'FHIR') {
      if (stack.length === 1) {
        if (key === 'type') bundleType = value;
        else if (key === 'total') bundleTotal = value;
        else if (key === 'link') links = Array.isArray(value) ? value : [];
        return;
      }
      if (stack.length !== 2 || stack[1].key !== 'entry' || !Array.isArray(info.parent)) return;
      if (entries.length + queue.length >= MAX_FHIR_ENTRIES) throw new Error('FHIR Bundle 資源數量必須介於 1 至 100,000');
      queue.push(async () => {
        const { json, pending } = await separator.separate(value);
        for (const attachment of pending) await sink.uploadAttachment(attachment);
        account(json);
        entries.push(json);
      });
      return;
    }
    if (!Array.isArray(info.parent)) return;
    const type = nhiType(stack[stack.length - 1].key);
    if (!type) return;
    if (stack.length === 2) collect(rootRecords, type, value);
    else if (stack.length === 4 && stack[1].key === 'myhealthbank' && stack[2].key === 'bdata') collect(wrappedRecords, type, value);
  };

  const chunks: SourceChunk[] = [];
  for (let offset = 0; offset < file.size; offset += SOURCE_CHUNK_BYTES) {
    signal?.throwIfAborted();
    const bytes = await readSlice(file, offset, Math.min(offset + SOURCE_CHUNK_BYTES, file.size));
    parser.write(stripBom(bytes, offset === 0));
    await drain();
    signal?.throwIfAborted();
    const chunk: SourceChunk = { id: crypto.randomUUID(), digest: await sha256(bytes), size: bytes.length };
    await sink.uploadSourceChunk({ id: chunk.id, bytes });
    chunks.push(chunk);
    onProgress?.(Math.min(offset + bytes.length, file.size) / file.size);
    signal?.throwIfAborted();
  }
  if (!parser.isEnded) parser.end();
  await drain();
  signal?.throwIfAborted();

  const json: FhirObject = format === 'FHIR' ? { resourceType: 'Bundle' } : {};
  if (format === 'FHIR') {
    if (bundleType !== undefined) json.type = bundleType;
    if (bundleTotal !== undefined) json.total = bundleTotal;
    if (links.length) json.link = links;
    json.entry = entries;
  } else {
    const wrapped = [...wrappedRecords.values()].some(items => items.length);
    const source = wrapped ? wrappedRecords : rootRecords;
    const arrays = Object.fromEntries(source);
    if (wrapped) json.myhealthbank = { bdata: arrays };
    else Object.assign(json, arrays);
  }
  const sourceId = await sha256(canonicalJson({ format, chunks }));
  return { json, attachments: separator.metadata, warnings: [...separator.warnings], chunks, sourceId };
}
