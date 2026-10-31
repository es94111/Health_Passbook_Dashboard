import { comparePatients, isFhirBundle, patientIdentifiers, readFhirBundleResources } from './parsers/fhir-parser';
import { array, canonicalJson, fhirDate, object, resourceSource, sha256, string, type FhirObject } from './parsers/fhir-common';
import { separateAttachments, type PendingAttachment } from './medicalAttachments';
import { parseNHIDate } from './parsers/nhi-parser';
import { normalizeStoredRecords, RECORD_TYPES, type MergeStats, type RecordType, type StoredRecords } from './recordStore';

export class PatientConfirmationRequired extends Error {
  constructor() { super('無法自動比對病人身分。請確認此次檔案與目前帳號的既有資料屬於同一人後再匯入。'); }
}

function nhiSource(json: FhirObject): FhirObject {
  return Object.hasOwn(json, 'myhealthbank') ? object(object(json.myhealthbank).bdata) : json;
}

export function inspectImportIdentity(existing: StoredRecords, input: object): { needsConfirmation: boolean; format: 'NHI' | 'FHIR' } {
  const json = object(input);
  if (json.resourceType !== undefined) {
    if (!isFhirBundle(json)) throw new Error('請選擇完整的 FHIR R4 Bundle JSON，而非單一 FHIR resource');
    const resources = readFhirBundleResources(json);
    const patient = resources.find(resource => resource.resourceType === 'Patient')!;
    const prior = Object.values(existing.fhir ?? {}).map(object).filter(resource => resource.resourceType === 'Patient');
    const matches = prior.map(previous => comparePatients(previous, patient));
    if (matches.includes('different')) throw new Error('偵測到不同的病人識別資訊，已中止匯入以避免混合病歷');
    const hasExisting = RECORD_TYPES.some(type => Object.keys(existing[type] ?? {}).length);
    return { format: 'FHIR', needsConfirmation: hasExisting ? !matches.includes('same') : patientIdentifiers(patient).size === 0 };
  }
  const source = nhiSource(json);
  const recognized = RECORD_TYPES.filter(type => type !== 'fhir' && Object.hasOwn(source, type));
  if (!recognized.length || recognized.some(type => !Array.isArray(source[type]))) throw new Error('不是支援的 NHI JSON 或 FHIR Bundle，既有資料未變更');
  for (const type of recognized) {
    if (array(source[type]).some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw new Error('NHI 記錄陣列含有格式錯誤的資料');
  }
  if (!recognized.some(type => array(source[type]).length)) throw new Error('檔案沒有可匯入的病歷紀錄');
  return { format: 'NHI', needsConfirmation: true };
}

const legacyDateFields: Partial<Record<RecordType, string[]>> = {
  r1: ['r1.5'], r2: ['r2.5', 'r2.6'], r3: ['r3.5'], r6: ['r6.1'], r7: ['r7.5'], r8: ['r8.5'],
};

function legacyKey(type: RecordType, record: FhirObject): string | null {
  const fields: Record<string, string[]> = { r1: ['r1.4', 'r1.5', 'r1.7'], r2: ['r2.4', 'r2.5', 'r2.6'],
    r3: ['r3.4', 'r3.5', 'r3.7'], r6: ['r6.1', 'r6.3'], r7: ['r7.4', 'r7.5', 'r7.7', 'r7.10'], r8: ['r8.4', 'r8.5', 'r8.8'] };
  const values = (fields[type] ?? []).map(field => record[field]);
  return values.length && values.every(value => value !== undefined && value !== null && String(value) !== '') ? values.map(String).join('_') : null;
}

function staleResource(previous: FhirObject, incoming: FhirObject): boolean {
  const oldMeta = object(previous.meta);
  const newMeta = object(incoming.meta);
  const oldDate = fhirDate(oldMeta.lastUpdated);
  const newDate = fhirDate(newMeta.lastUpdated);
  if (oldDate && newDate) return newDate.getTime() < oldDate.getTime();
  const oldVersion = string(oldMeta.versionId);
  const newVersion = string(newMeta.versionId);
  return /^\d+$/.test(oldVersion) && /^\d+$/.test(newVersion) && BigInt(newVersion) < BigInt(oldVersion);
}

export async function mergeNHIJson(
  previous: StoredRecords,
  json: object,
  options: { confirmPatient?: boolean } = {},
): Promise<{ records: StoredRecords; stats: MergeStats; pendingAttachments: PendingAttachment[] }> {
  const existing = normalizeStoredRecords(previous);
  const identity = inspectImportIdentity(existing, json);
  if (identity.needsConfirmation && !options.confirmPatient) throw new PatientConfirmationRequired();
  const sourceId = await sha256(canonicalJson(json));
  const separated = await separateAttachments(json, existing.attachments);
  const prepared = object(separated.json);
  const records = normalizeStoredRecords(existing);
  records.attachments = separated.metadata;
  records.sources = { ...existing.sources, [sourceId]: { format: identity.format, data: prepared } };
  records.fhirAliases = { ...existing.fhirAliases };
  const stats = Object.fromEntries(RECORD_TYPES.map(type => [type, { added: 0, skipped: 0, updated: 0 }])) as MergeStats;
  const warnings = new Set(separated.warnings);
  if (identity.needsConfirmation) warnings.add('此來源的病人身分由使用者人工確認，無法由系統自動驗證');

  if (identity.format === 'FHIR') {
    const resources = readFhirBundleResources(prepared);
    const entries = array(prepared.entry).map(object);
    const seen = new Set<string>();
    const aliases = new Map(Object.entries(existing.fhirAliases).flatMap(([key, values]) => values.map(alias => [alias, key] as const)));
    const displayed = new Set(['Patient', 'Encounter', 'Condition', 'Organization', 'Observation', 'Procedure', 'DiagnosticReport', 'DocumentReference', 'ImagingStudy', 'Media', 'Binary', 'Immunization', 'Medication', 'MedicationRequest', 'MedicationStatement', 'MedicationDispense', 'Practitioner', 'PractitionerRole', 'Location', 'Composition']);
    for (let i = 0; i < resources.length; i++) {
      const resource = resources[i];
      const type = string(resource.resourceType);
      const fullUrl = string(entries[i].fullUrl);
      const namespace = resourceSource(resource, fullUrl);
      const key = `${type}|${namespace}|${string(resource.id) || fullUrl || await sha256(canonicalJson(resource))}`;
      if (seen.has(key)) throw new Error('FHIR Bundle 包含無法區分的重複資源識別，請檢查匯出檔');
      seen.add(key);
      const old = records.fhir[key];
      if (old && staleResource(object(old), resource)) {
        stats.fhir.skipped++;
        warnings.add('較舊的 FHIR 版本未覆寫目前紀錄；原始匯入檔仍完整保留');
      } else if (old && canonicalJson(old) === canonicalJson(resource)) {
        stats.fhir.skipped++;
      } else {
        records.fhir[key] = resource;
        if (old) stats.fhir.updated++; else stats.fhir.added++;
      }
      if (fullUrl) {
        if (aliases.has(fullUrl) && aliases.get(fullUrl) !== key) throw new Error('FHIR fullUrl 與既有來源的不同資源衝突，已停止匯入');
        aliases.set(fullUrl, key);
        records.fhirAliases[key] = [...new Set([...(records.fhirAliases[key] ?? []), fullUrl])];
      }
      if (!displayed.has(type)) warnings.add('部分資源尚無專用圖表，仍完整保留於原始加密來源檔');
      if (['Observation', 'Encounter', 'DiagnosticReport', 'DocumentReference', 'ImagingStudy', 'MedicationRequest', 'MedicationDispense', 'MedicationStatement'].includes(type) &&
          !fhirDate(resource.effectiveDateTime, object(resource.effectivePeriod).start, resource.issued, resource.date, resource.created, resource.started,
            object(resource.period).start, resource.authoredOn, resource.whenHandedOver, resource.whenPrepared, resource.dateAsserted)) {
        warnings.add('部分紀錄缺少完整日期，保留原始內容但不納入日期趨勢');
      }
      if (['Observation', 'Encounter', 'DiagnosticReport', 'MedicationRequest', 'MedicationDispense', 'MedicationStatement'].includes(type) && !resource.subject && !resource.patient) {
        warnings.add('部分臨床資源未附病人參照，以本 Bundle 唯一的 Patient 為匯入上下文');
      }
    }
  } else {
    const source = nhiSource(prepared);
    for (const type of RECORD_TYPES) {
      if (type === 'fhir') continue;
      for (const item of array(source[type])) {
        const record = object(item);
        for (const field of legacyDateFields[type] ?? []) {
          try { parseNHIDate(String(record[field] ?? '')); }
          catch { warnings.add('部分 NHI 紀錄日期不完整或無效，原始內容已保留，但不納入日期趨勢'); }
        }
        if (type === 'r1' && record['r1.7'] === 'XXXX') { stats.r1.skipped++; continue; }
        const key = legacyKey(type, record) ?? `content:${await sha256(canonicalJson(record))}`;
        const old = records[type][key];
        if (old && canonicalJson(old) === canonicalJson(record)) stats[type].skipped++;
        else {
          records[type][key] = record;
          if (old) stats[type].updated++; else stats[type].added++;
        }
      }
    }
  }
  const total = Object.values(stats).reduce((sum, item) => ({ added: sum.added + item.added, updated: sum.updated + item.updated, skipped: sum.skipped + item.skipped }), { added: 0, updated: 0, skipped: 0 });
  records.importHistory = [...existing.importHistory, { id: crypto.randomUUID(), sourceId, format: identity.format, importedAt: new Date().toISOString(),
    ...total, warnings: [...warnings], identityConfirmed: identity.needsConfirmation && options.confirmPatient === true }];
  return { records, stats, pendingAttachments: separated.pending };
}
