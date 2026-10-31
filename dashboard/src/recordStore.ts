import type { ImportSummary } from './parsers/types';
import { object, type FhirObject } from './parsers/fhir-common';
import { attachmentType, UUID_PATTERN, type AttachmentMetadata } from './medicalAttachments';

export const RECORD_TYPES = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8', 'fhir'] as const;
export type RecordType = typeof RECORD_TYPES[number];
export type MergeStats = Record<RecordType, { added: number; skipped: number; updated: number }>;
export interface SourceArchive {
  format: 'NHI' | 'FHIR';
  data: FhirObject;
}
export interface StoredRecords {
  r1: Record<string, object>;
  r2: Record<string, object>;
  r3: Record<string, object>;
  r6: Record<string, object>;
  r7: Record<string, object>;
  r8: Record<string, object>;
  fhir: Record<string, object>;
  fhirAliases: Record<string, string[]>;
  attachments: Record<string, AttachmentMetadata>;
  sources: Record<string, SourceArchive>;
  importHistory: ImportSummary[];
}

export function emptyRecords(): StoredRecords {
  return { r1: {}, r2: {}, r3: {}, r6: {}, r7: {}, r8: {}, fhir: {}, fhirAliases: {}, attachments: {}, sources: {}, importHistory: [] };
}

export function normalizeStoredRecords(value: unknown): StoredRecords {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('加密資料內容不是有效的病歷資料庫');
  const root = object(value);
  const normalized = emptyRecords();
  for (const type of RECORD_TYPES) {
    if (root[type] === undefined) continue;
    const records = root[type];
    if (records === null || typeof records !== 'object' || Array.isArray(records) ||
        Object.values(records).some(record => record === null || typeof record !== 'object' || Array.isArray(record))) {
      throw new Error('病歷索引格式不正確，為避免覆寫資料已停止載入');
    }
    normalized[type] = { ...records };
  }
  for (const key of ['fhirAliases', 'attachments', 'sources']) {
    if (root[key] !== undefined && (root[key] === null || typeof root[key] !== 'object' || Array.isArray(root[key]))) throw new Error('加密病歷中繼資料格式不正確');
  }
  const knownAliases = new Map<string, string>();
  for (const [key, aliases] of Object.entries(object(root.fhirAliases))) {
    if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) throw new Error('FHIR 參照索引已損壞');
    if (!Object.hasOwn(normalized.fhir, key)) throw new Error('FHIR 參照索引指向不存在的資源');
    for (const alias of aliases) {
      if (!alias || (knownAliases.has(alias) && knownAliases.get(alias) !== key)) throw new Error('FHIR 參照索引存在衝突');
      knownAliases.set(alias, key);
    }
    normalized.fhirAliases[key] = [...new Set(aliases)];
  }
  for (const [id, value] of Object.entries(object(root.attachments))) {
    const item = object(value);
    const contentType = attachmentType(item.contentType);
    if (!UUID_PATTERN.test(id) || item.id !== id || !contentType || !/^[0-9a-f]{64}$/.test(String(item.digest)) ||
        !Number.isSafeInteger(item.size) || Number(item.size) < 1 || Number(item.size) > 12 * 1024 * 1024) {
      throw new Error('加密附件索引已損壞');
    }
    normalized.attachments[id] = { id, contentType, digest: String(item.digest), size: Number(item.size) };
  }
  for (const [id, value] of Object.entries(object(root.sources))) {
    const archive = object(value);
    if (!/^[0-9a-f]{64}$/.test(id) || !['NHI', 'FHIR'].includes(String(archive.format)) || !Object.keys(object(archive.data)).length) throw new Error('加密來源索引已損壞');
    normalized.sources[id] = archive as unknown as SourceArchive;
  }
  if (root.importHistory !== undefined && !Array.isArray(root.importHistory)) throw new Error('匯入歷程格式不正確');
  normalized.importHistory = ((root.importHistory as unknown[] | undefined) ?? []).map(value => {
    const entry = object(value);
    if (typeof entry.id !== 'string' || !UUID_PATTERN.test(entry.id) || typeof entry.sourceId !== 'string' || !normalized.sources[entry.sourceId] ||
        !['NHI', 'FHIR'].includes(String(entry.format)) || typeof entry.importedAt !== 'string' || !Number.isFinite(Date.parse(entry.importedAt)) ||
        typeof entry.identityConfirmed !== 'boolean' || !['added', 'updated', 'skipped'].every(key => Number.isSafeInteger(entry[key]) && Number(entry[key]) >= 0) ||
        !Array.isArray(entry.warnings) || entry.warnings.some(warning => typeof warning !== 'string')) throw new Error('加密匯入歷程已損壞');
    return entry as unknown as ImportSummary;
  });
  return normalized;
}

export function flattenRecords(stored: StoredRecords): Record<string, unknown[]> {
  const root = normalizeStoredRecords(stored);
  return { ...Object.fromEntries(RECORD_TYPES.map(type => [type, Object.values(root[type])])),
    fhirEntries: Object.entries(root.fhir).flatMap(([key, resource]) => (root.fhirAliases[key] ?? []).map(fullUrl => ({ fullUrl, resource }))),
    importHistory: root.importHistory };
}
