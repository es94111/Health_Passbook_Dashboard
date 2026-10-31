import { isFhirBundle, parseFhirResources, readFhirBundleResources } from './fhir-parser';
import { array, canonicalJson, fhirDate, object } from './fhir-common';
import type { Visit, Hospitalization, Vaccination, LabResult, TextLabResult, CheckupReport, DentalVisit, NHIData, SourcedRecord, ImportSummary } from './types';

// ICD-10 codes start with an uppercase letter followed by 2-3 digits
const ICD_PATTERN = /^[A-Z]\d{2,3}/;

// Reference range format: [low][high] — both are optional
const REF_RANGE_PATTERN = /\[([^\]]*)\]/g;
const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseNHIDate(s: string): Date {
  const date = fhirDate(s.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
  if (!date) throw new Error('NHI 日期格式不正確');
  return date;
}

function numericLabValue(value: unknown): { value: number; unit?: string } | null {
  const text = String(value ?? '').trim();
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(?:\(([A-Za-z0-9µμ%/.*^·⁰¹²³⁴⁵⁶⁷⁸⁹ -]+)\)|([A-Za-zµμ%][A-Za-z0-9µμ%/.*^·⁰¹²³⁴⁵⁶⁷⁸⁹ -]*))?$/i.exec(text);
  return match && Number.isFinite(Number(match[1])) ? { value: Number(match[1]), unit: (match[2] || match[3])?.trim() || undefined } : null;
}

/** Given a key like "r1.8" or "r2.10", return the key for the next field ("r1.9", "r2.11"). */
function nextKey(key: string): string {
  const dot = key.lastIndexOf('.');
  const suffix = parseInt(key.slice(dot + 1), 10);
  return key.slice(0, dot + 1) + (suffix + 1);
}

export function parseVisits(records: Record<string, unknown>[]): Visit[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      // Skip masked records (r1.7 === 'XXXX') — NHI uses this as a placeholder
      // when the visit sequence number is unavailable; they duplicate real records.
      if (String(r['r1.7'] ?? '') === 'XXXX') return [];

      const date = parseNHIDate(String(r['r1.5'] ?? ''));
      const hospital = String(r['r1.4'] ?? '');

      // Dynamic ICD-10 scan: find all string values matching the ICD pattern
      const diagnoses: { code: string; name: string }[] = [];
      const keys = Object.keys(r).sort();
      for (const key of keys) {
        const val = r[key];
        if (typeof val === 'string' && ICD_PATTERN.test(val)) {
          // The diagnosis name is in the next key (e.g., r1.8 code → r1.9 name)
          const name = String(r[nextKey(key)] ?? '');
          diagnoses.push({ code: val, name });
        }
      }

      // Nested procedures from r1_1[]
      const procedures: { code: string; name: string; qty: number }[] = [];
      const nested = r['r1_1'];
      if (Array.isArray(nested)) {
        for (const item of nested) {
          const rec = item as Record<string, unknown>;
          procedures.push({
            code: String(rec['r1_1.1'] ?? ''),
            name: String(rec['r1_1.2'] ?? ''),
            qty: parseFloat(String(rec['r1_1.3'] ?? '0')) || 0,
          });
        }
      }

      return [{ date, hospital, diagnoses, procedures }];
    } catch {
      return [];
    }
  });
}

export function parseHospitalizations(records: Record<string, unknown>[]): Hospitalization[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      const admitDate = parseNHIDate(String(r['r2.5'] ?? ''));
      const dischargeDate = parseNHIDate(String(r['r2.6'] ?? ''));
      const hospital = String(r['r2.4'] ?? '');

      const diagnoses: { code: string; name: string }[] = [];
      const keys = Object.keys(r).sort();
      for (const key of keys) {
        const val = r[key];
        if (typeof val === 'string' && ICD_PATTERN.test(val)) {
          const name = String(r[nextKey(key)] ?? '');
          diagnoses.push({ code: val, name });
        }
      }

      return [{ admitDate, dischargeDate, hospital, diagnoses }];
    } catch {
      return [];
    }
  });
}

export function parseVaccinations(records: Record<string, unknown>[]): Vaccination[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      return [{
        date: parseNHIDate(String(r['r6.1'] ?? '')),
        vaccine: String(r['r6.3'] ?? ''),
        location: String(r['r6.5'] ?? ''),
      }];
    } catch {
      return [];
    }
  });
}

export function parseLabResults(records: Record<string, unknown>[]): LabResult[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      const numeric = numericLabValue(r['r7.11']);
      if (!numeric) return [];
      const { value, unit } = numeric;
      const refRange = String(r['r7.12'] ?? '');
      const matches = [...refRange.matchAll(REF_RANGE_PATTERN)];
      const bound = (index: number) => matches[index] && NUMBER_PATTERN.test(matches[index][1].trim()) ? Number(matches[index][1]) : null;
      const refLow = bound(0);
      const refHigh = bound(1);

      return [{
        date: parseNHIDate(String(r['r7.5'] ?? '')),
        hospital: String(r['r7.4'] ?? ''),
        testGroup: String(r['r7.9'] ?? ''),
        subItem: String(r['r7.10'] ?? ''),
        value,
        refLow,
        refHigh,
        unit,
        refText: refRange || undefined,
        source: '健保署原生 JSON',
      }];
    } catch {
      return [];
    }
  });
}

export function parseDentalVisits(records: Record<string, unknown>[]): DentalVisit[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      const date = parseNHIDate(String(r['r3.5'] ?? ''));
      const hospital = String(r['r3.4'] ?? '');

      // ICD scan — same pattern as r1
      const diagnoses: { code: string; name: string }[] = [];
      const keys = Object.keys(r).sort();
      for (const key of keys) {
        const val = r[key];
        if (typeof val === 'string' && ICD_PATTERN.test(val)) {
          const name = String(r[nextKey(key)] ?? '');
          diagnoses.push({ code: val, name });
        }
      }

      // Nested procedure items from r3_1[]
      const procedures: { code: string; name: string; qty: number; toothCode: string; toothName: string }[] = [];
      const nested = r['r3_1'];
      if (Array.isArray(nested)) {
        for (const item of nested) {
          const rec = item as Record<string, unknown>;
          procedures.push({
            code: String(rec['r3_1.1'] ?? ''),
            name: String(rec['r3_1.2'] ?? ''),
            qty: parseFloat(String(rec['r3_1.3'] ?? '0')) || 0,
            toothCode: String(rec['r3_1.4'] ?? ''),
            toothName: String(rec['r3_1.5'] ?? ''),
          });
        }
      }

      return [{ date, hospital, diagnoses, procedures }];
    } catch {
      return [];
    }
  });
}

export function parseCheckupReports(records: Record<string, unknown>[]): CheckupReport[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      return [{
        date: parseNHIDate(String(r['r8.5'] ?? '')),
        hospital: String(r['r8.4'] ?? ''),
        examName: String(r['r8.9'] ?? ''),
        report: String(r['r8.10'] ?? ''),
      }];
    } catch {
      return [];
    }
  });
}

/** Extract the bdata node from an NHI JSON object (handles the myhealthbank wrapper). */
function extractBdata(obj: Record<string, unknown>): Record<string, unknown> {
  // Real NHI export: { myhealthbank: { bdata: { r1: [], r7: [], ... } } }
  const inner = obj?.myhealthbank as Record<string, unknown> | undefined;
  if (inner?.bdata) return inner.bdata as Record<string, unknown>;
  // Fallback: already flat (e.g. from server fetch or test fixtures)
  return obj;
}

export function parseTextLabResults(records: Record<string, unknown>[]): TextLabResult[] {
  return records.flatMap(record => {
    const text = String(record['r7.11'] ?? '').trim();
    if (!text) return [];
    let date: Date | null = null;
    try { date = parseNHIDate(String(record['r7.5'] ?? '')); } catch { /* Preserve undated values outside the trend chart. */ }
    if (numericLabValue(text) && date) return [];
    return [{ date, hospital: String(record['r7.4'] ?? ''), testGroup: String(record['r7.9'] ?? ''),
      subItem: String(record['r7.10'] ?? ''), text, refText: String(record['r7.12'] ?? '') || undefined, source: '健保署原生 JSON' }];
  });
}

function legacy<T extends object>(items: T[]): (T & SourcedRecord)[] {
  return items.map(item => ({ ...item, origins: [{ format: 'NHI', source: '健保署原生 JSON' }] }));
}

function duplicateCandidates(legacyItems: unknown[], fhirItems: unknown[], fields: string[]): number {
  const key = (value: unknown) => {
    const item = object(value);
    return canonicalJson(Object.fromEntries(fields.map(field => [field, item[field] instanceof Date ? (item[field] as Date).getTime() : item[field] ?? null])));
  };
  const seen = new Set(legacyItems.map(key));
  return fhirItems.filter(item => seen.has(key(item))).length;
}

export function parseNHIJson(raw: string | Record<string, unknown>): NHIData {
  const parsed = object(typeof raw === 'string' ? JSON.parse(raw.replace(/^\uFEFF/, '')) : raw);
  const directBundle = isFhirBundle(parsed);
  const data = extractBdata(parsed);
  const resources = directBundle ? readFhirBundleResources(parsed) : array(data.fhir).map(object);
  const entries = directBundle ? array(parsed.entry).map(object) : array(data.fhirEntries).map(object);
  const fhir = parseFhirResources(resources, entries);
  const visits = legacy(parseVisits(array(data.r1).map(object)));
  const hospitalizations = legacy(parseHospitalizations(array(data.r2).map(object)));
  const vaccinations = legacy(parseVaccinations(array(data.r6).map(object)));
  const labs = legacy(parseLabResults(array(data.r7).map(object)));
  return {
    visits: [...visits, ...fhir.visits], hospitalizations: [...hospitalizations, ...fhir.hospitalizations],
    vaccinations: [...vaccinations, ...fhir.vaccinations], labResults: [...labs, ...fhir.labResults],
    textLabResults: [...legacy(parseTextLabResults(array(data.r7).map(object))), ...fhir.textLabResults],
    checkupReports: [...legacy(parseCheckupReports(array(data.r8).map(object))), ...fhir.checkupReports],
    dentalVisits: legacy(parseDentalVisits(array(data.r3).map(object))), medicalReports: fhir.medicalReports, medications: fhir.medications,
    importHistory: array(data.importHistory) as ImportSummary[],
    duplicateCandidateCount: duplicateCandidates(visits, fhir.visits, ['date', 'hospital', 'diagnoses', 'procedures']) +
      duplicateCandidates(labs, fhir.labResults, ['date', 'hospital', 'subItem', 'value', 'unit']),
  };
}
