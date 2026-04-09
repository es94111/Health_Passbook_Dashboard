import type { Visit, Hospitalization, Vaccination, LabResult, CheckupReport, DentalVisit, NHIData } from './types';

// ICD-10 codes start with an uppercase letter followed by 2-3 digits
const ICD_PATTERN = /^[A-Z]\d{2,3}/;

// Reference range format: [low][high] — both are optional
const REF_RANGE_PATTERN = /\[(\d+(?:\.\d+)?)\]/g;

export function parseNHIDate(s: string): Date {
  return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
}

export function parseVisits(records: Record<string, unknown>[]): Visit[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((r) => {
    try {
      const date = parseNHIDate(String(r['r1.5'] ?? ''));
      const hospital = String(r['r1.4'] ?? '');

      // Dynamic ICD-10 scan: find all string values matching the ICD pattern
      const diagnoses: { code: string; name: string }[] = [];
      const keys = Object.keys(r).sort();
      for (const key of keys) {
        const val = r[key];
        if (typeof val === 'string' && ICD_PATTERN.test(val)) {
          // The diagnosis name is in the next key (e.g., r1.8 code → r1.9 name)
          const keyNum = parseInt(key.replace(/[^0-9]/g, ''), 10);
          const nameKey = key.replace(/\d+$/, String(keyNum + 1));
          const name = String(r[nameKey] ?? '');
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
          const keyNum = parseInt(key.replace(/[^0-9]/g, ''), 10);
          const nameKey = key.replace(/\d+$/, String(keyNum + 1));
          const name = String(r[nameKey] ?? '');
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
      const valueStr = String(r['r7.11'] ?? '');
      if (!valueStr) return [];
      const value = parseFloat(valueStr);
      if (isNaN(value)) return [];

      const refRange = String(r['r7.12'] ?? '');
      const matches = [...refRange.matchAll(REF_RANGE_PATTERN)];
      const refLow = matches[0] ? parseFloat(matches[0][1]) : null;
      const refHigh = matches[1] ? parseFloat(matches[1][1]) : null;

      return [{
        date: parseNHIDate(String(r['r7.5'] ?? '')),
        hospital: String(r['r7.4'] ?? ''),
        testGroup: String(r['r7.9'] ?? ''),
        subItem: String(r['r7.10'] ?? ''),
        value,
        refLow,
        refHigh,
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
          const keyNum = parseInt(key.replace(/[^0-9]/g, ''), 10);
          const nameKey = key.replace(/\d+$/, String(keyNum + 1));
          const name = String(r[nameKey] ?? '');
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

export function parseNHIJson(raw: string | Record<string, unknown[]>): NHIData {
  const parsed: Record<string, unknown> =
    typeof raw === 'string'
      ? (JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>)
      : (raw as Record<string, unknown>);

  const data = extractBdata(parsed) as Record<string, Record<string, unknown>[]>;

  return {
    visits: parseVisits(data.r1 ?? []),
    hospitalizations: parseHospitalizations(data.r2 ?? []),
    vaccinations: parseVaccinations(data.r6 ?? []),
    labResults: parseLabResults(data.r7 ?? []),
    checkupReports: parseCheckupReports(data.r8 ?? []),
    dentalVisits: parseDentalVisits(data.r3 ?? []),
  };
}
