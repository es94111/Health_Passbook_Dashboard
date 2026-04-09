import { describe, it, expect } from 'vitest';
import {
  parseNHIDate,
  parseLabResults,
  parseVisits,
  parseVaccinations,
  parseHospitalizations,
  parseCheckupReports,
  parseNHIJson,
} from './nhi-parser';

// ---- parseNHIDate ----
describe('parseNHIDate', () => {
  it('parses a standard date string', () => {
    const d = parseNHIDate('20230414');
    expect(d.getFullYear()).toBe(2023);
    expect(d.getMonth()).toBe(3); // April = 3
    expect(d.getDate()).toBe(14);
  });

  it('parses an early date', () => {
    const d = parseNHIDate('19990101');
    expect(d.getFullYear()).toBe(1999);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(1);
  });
});

// ---- parseLabResults ----
describe('parseLabResults', () => {
  it('parses a normal record with two-sided reference range', () => {
    const results = parseLabResults([{
      'r7.5': '20230414',
      'r7.4': '台大醫院',
      'r7.9': '全套血液檢查',
      'r7.10': '紅血球計數',
      'r7.11': '335',
      'r7.12': '[450][550]',
    }]);
    expect(results).toHaveLength(1);
    expect(results[0].value).toBe(335);
    expect(results[0].refLow).toBe(450);
    expect(results[0].refHigh).toBe(550);
  });

  it('parses a one-sided reference range', () => {
    const results = parseLabResults([{
      'r7.5': '20230414',
      'r7.4': '台大醫院',
      'r7.9': '群組',
      'r7.10': '項目',
      'r7.11': '5.2',
      'r7.12': '[3.5]',
    }]);
    expect(results[0].refLow).toBe(3.5);
    expect(results[0].refHigh).toBeNull();
  });

  it('parses an empty reference range', () => {
    const results = parseLabResults([{
      'r7.5': '20230414',
      'r7.4': '台大醫院',
      'r7.9': '群組',
      'r7.10': '項目',
      'r7.11': '5.2',
      'r7.12': '',
    }]);
    expect(results[0].refLow).toBeNull();
    expect(results[0].refHigh).toBeNull();
  });

  it('handles decimal reference ranges', () => {
    const results = parseLabResults([{
      'r7.5': '20230414',
      'r7.4': '台大醫院',
      'r7.9': '群組',
      'r7.10': '項目',
      'r7.11': '4.0',
      'r7.12': '[3.5][5.5]',
    }]);
    expect(results[0].refLow).toBe(3.5);
    expect(results[0].refHigh).toBe(5.5);
  });

  it('returns empty array for empty input', () => {
    expect(parseLabResults([])).toEqual([]);
  });

  it('returns empty array without throwing for bad input', () => {
    expect(() => parseLabResults([{ bad: 'data' }])).not.toThrow();
  });
});

// ---- parseVisits ----
describe('parseVisits', () => {
  it('parses a normal visit with ICD diagnoses', () => {
    const results = parseVisits([{
      'r1.4': '中山附醫',
      'r1.5': '20230414',
      'r1.8': 'J06.9',
      'r1.9': '急性上呼吸道感染',
      'r1_1': [],
    }]);
    expect(results).toHaveLength(1);
    expect(results[0].hospital).toBe('中山附醫');
    expect(results[0].diagnoses).toHaveLength(1);
    expect(results[0].diagnoses[0].code).toBe('J06.9');
  });

  it('returns diagnoses: [] when no ICD fields match the pattern', () => {
    const results = parseVisits([{
      'r1.4': '中山附醫',
      'r1.5': '20230414',
      'r1.8': '這不是ICD碼',
      'r1.9': '說明',
      'r1_1': [],
    }]);
    expect(results).toHaveLength(1);
    expect(results[0].diagnoses).toEqual([]);
  });

  it('handles a visit with no r1_1 procedures', () => {
    const results = parseVisits([{
      'r1.4': '台大醫院',
      'r1.5': '20230101',
    }]);
    expect(results[0].procedures).toEqual([]);
  });

  it('returns [] for empty input', () => {
    expect(parseVisits([])).toEqual([]);
  });

  it('returns [] without throwing for malformed input', () => {
    expect(() => parseVisits([{ broken: undefined }])).not.toThrow();
  });
});

// ---- parseVaccinations ----
describe('parseVaccinations', () => {
  it('parses a vaccination record', () => {
    const results = parseVaccinations([{
      'r6.1': '19990407',
      'r6.3': 'B型肝炎遺傳工程疫苗',
      'r6.5': '臺中市外埔區衛生所',
    }]);
    expect(results).toHaveLength(1);
    expect(results[0].vaccine).toBe('B型肝炎遺傳工程疫苗');
    expect(results[0].location).toBe('臺中市外埔區衛生所');
    expect(results[0].date.getFullYear()).toBe(1999);
  });

  it('returns [] for empty input', () => {
    expect(parseVaccinations([])).toEqual([]);
  });
});

// ---- parseHospitalizations ----
describe('parseHospitalizations', () => {
  it('parses admit and discharge dates', () => {
    const results = parseHospitalizations([{
      'r2.4': '林口長庚',
      'r2.5': '20180219',
      'r2.6': '20180313',
    }]);
    expect(results[0].admitDate.getFullYear()).toBe(2018);
    expect(results[0].admitDate.getMonth()).toBe(1); // February
    expect(results[0].dischargeDate.getDate()).toBe(13);
  });

  it('returns [] for empty input', () => {
    expect(parseHospitalizations([])).toEqual([]);
  });
});

// ---- parseCheckupReports ----
describe('parseCheckupReports', () => {
  it('captures the full r8.10 report text', () => {
    const results = parseCheckupReports([{
      'r8.4': '台大醫院',
      'r8.5': '20220601',
      'r8.9': '心電圖',
      'r8.10': '正常竇性心律，無明顯異常。',
    }]);
    expect(results[0].report).toBe('正常竇性心律，無明顯異常。');
    expect(results[0].examName).toBe('心電圖');
  });

  it('returns [] for empty input', () => {
    expect(parseCheckupReports([])).toEqual([]);
  });
});

// ---- BOM handling ----
describe('BOM handling', () => {
  it('parses JSON with a BOM prefix without SyntaxError', () => {
    const json = '\uFEFF' + JSON.stringify({ r1: [], r2: [], r6: [], r7: [], r8: [] });
    expect(() => parseNHIJson(json)).not.toThrow();
  });
});
