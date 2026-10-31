import { describe, expect, it } from 'vitest';
import type {
  CheckupReport,
  DentalVisit,
  Hospitalization,
  LabResult,
  MedicalReport,
  MedicationRecord,
  TextLabResult,
  Vaccination,
  Visit,
} from '../parsers/types';
import { computeAllLabSeriesSummaries, isLabSeriesPinned, type LabSeriesSummary } from './clinicalLabSeries';
import {
  ABNORMAL_RECHECK_DAYS,
  computeFreshness,
  latestRecordDate,
  recheckCandidates,
  ROUTINE_RECHECK_DAYS,
  STALE_DATA_DAYS,
  type DatedRecords,
} from './freshness';

const NOW = new Date(2026, 9, 31, 12);
const daysAgo = (days: number) => new Date(2026, 9, 31 - days);

const emptyRecords = (): DatedRecords => ({
  visits: [],
  hospitalizations: [],
  vaccinations: [],
  labResults: [],
  checkupReports: [],
  dentalVisits: [],
  medicalReports: [],
  medications: [],
  textLabResults: [],
});

const visit = (date: Date): Visit => ({ date, hospital: 'Hosp A', diagnoses: [], procedures: [] });
const hospitalization = (admitDate: Date, dischargeDate: Date): Hospitalization => ({
  admitDate,
  dischargeDate,
  hospital: 'Hosp A',
  diagnoses: [],
});
const vaccination = (date: Date): Vaccination => ({ date, vaccine: 'Vaccine', location: 'Clinic' });
const checkup = (date: Date): CheckupReport => ({ date, hospital: 'Hosp A', examName: 'Exam', report: 'Report' });
const dental = (date: Date): DentalVisit => ({ date, hospital: 'Hosp A', diagnoses: [], procedures: [] });
const medicalReport = (date: Date | null): MedicalReport => ({
  id: 'report-1',
  kind: 'general',
  date,
  hospital: 'Hosp A',
  title: 'Report',
  text: 'Body',
  attachments: [],
  relatedResources: [],
  externalAttachmentCount: 0,
  rawResource: {},
});
const medication = (date: Date | null): MedicationRecord => ({
  id: 'med-1',
  date,
  hospital: 'Hosp A',
  name: 'Drug',
  dosage: '1 tab',
  status: 'active',
  source: 'FHIR',
  category: '處方',
  rawResource: {},
});
const textLab = (date: Date | null): TextLabResult => ({
  date,
  hospital: 'Hosp A',
  testGroup: 'Group',
  subItem: 'Item',
  text: 'Positive',
});
const lab = (date: Date): LabResult => ({
  date,
  hospital: 'Hosp A',
  testGroup: 'Chem',
  subItem: 'Glucose',
  value: 100,
  refLow: 70,
  refHigh: 110,
  unit: 'mg/dL',
  source: 'FHIR',
  code: 'glucose',
});

describe('latestRecordDate', () => {
  it('returns null when there are no records', () => {
    expect(latestRecordDate(emptyRecords())).toBeNull();
  });

  const categories: [string, (date: Date) => Partial<DatedRecords>][] = [
    ['visits', date => ({ visits: [visit(date)] })],
    ['hospitalization admit date', date => ({ hospitalizations: [hospitalization(date, new Date(1990, 0, 1))] })],
    ['hospitalization discharge date', date => ({ hospitalizations: [hospitalization(new Date(1990, 0, 1), date)] })],
    ['vaccinations', date => ({ vaccinations: [vaccination(date)] })],
    ['lab results', date => ({ labResults: [lab(date)] })],
    ['text lab results', date => ({ textLabResults: [textLab(date)] })],
    ['checkup reports', date => ({ checkupReports: [checkup(date)] })],
    ['dental visits', date => ({ dentalVisits: [dental(date)] })],
    ['medical reports', date => ({ medicalReports: [medicalReport(date)] })],
    ['medications', date => ({ medications: [medication(date)] })],
  ];

  it.each(categories)('counts %s', (_name, make) => {
    const date = new Date(2026, 5, 15);
    expect(latestRecordDate({ ...emptyRecords(), ...make(date) })).toEqual(date);
  });

  it('picks the newest date across categories', () => {
    const newest = new Date(2026, 8, 20);
    const result = latestRecordDate({
      ...emptyRecords(),
      visits: [visit(new Date(2026, 1, 1))],
      labResults: [lab(newest)],
      medications: [medication(new Date(2026, 7, 1))],
    });
    expect(result).toEqual(newest);
  });

  it('uses a discharge date that is later than every other record', () => {
    const discharge = new Date(2026, 9, 5);
    const result = latestRecordDate({
      ...emptyRecords(),
      visits: [visit(new Date(2026, 9, 1))],
      hospitalizations: [hospitalization(new Date(2026, 8, 28), discharge)],
    });
    expect(result).toEqual(discharge);
  });

  it('ignores null and invalid dates', () => {
    expect(
      latestRecordDate({
        ...emptyRecords(),
        medications: [medication(null)],
        medicalReports: [medicalReport(null)],
        textLabResults: [textLab(null)],
        visits: [visit(new Date(Number.NaN))],
      }),
    ).toBeNull();

    const valid = new Date(2025, 2, 3);
    expect(
      latestRecordDate({
        ...emptyRecords(),
        visits: [visit(new Date(Number.NaN)), visit(valid)],
        medications: [medication(null)],
      }),
    ).toEqual(valid);
  });

  it('does not filter future dates', () => {
    const future = new Date(2027, 0, 1);
    expect(latestRecordDate({ ...emptyRecords(), visits: [visit(new Date(2026, 0, 1)), visit(future)] })).toEqual(
      future,
    );
  });

  it('returns a new Date instance instead of the record reference', () => {
    const source = new Date(2026, 3, 4);
    const result = latestRecordDate({ ...emptyRecords(), visits: [visit(source)] });
    expect(result).not.toBe(source);
  });
});

describe('computeFreshness', () => {
  it('has no age when there is no latest date', () => {
    expect(computeFreshness(null, NOW)).toEqual({ latest: null, ageDays: null, stale: false });
  });

  it('is fresh on the same day regardless of the time of day', () => {
    const result = computeFreshness(new Date(2026, 9, 31, 23, 59), NOW);
    expect(result.ageDays).toBe(0);
    expect(result.stale).toBe(false);
  });

  it(`is not stale at exactly ${STALE_DATA_DAYS} days and stale one day later`, () => {
    expect(computeFreshness(daysAgo(STALE_DATA_DAYS), NOW)).toMatchObject({ ageDays: STALE_DATA_DAYS, stale: false });
    expect(computeFreshness(daysAgo(STALE_DATA_DAYS + 1), NOW)).toMatchObject({
      ageDays: STALE_DATA_DAYS + 1,
      stale: true,
    });
  });

  it('treats a future date as zero days old', () => {
    const result = computeFreshness(new Date(2027, 5, 1), NOW);
    expect(result.ageDays).toBe(0);
    expect(result.stale).toBe(false);
  });

  it('keeps the latest date it was given', () => {
    const latest = daysAgo(10);
    expect(computeFreshness(latest, NOW).latest).toBe(latest);
  });
});

describe('recheckCandidates', () => {
  const item = (name: string, daysOld: number, value: number): LabResult => ({
    date: daysAgo(daysOld),
    hospital: 'Hosp A',
    testGroup: 'Chem',
    subItem: name,
    value,
    refLow: 70,
    refHigh: 110,
    unit: 'mg/dL',
    source: 'FHIR',
    code: `code-${name}`,
  });
  const NORMAL = 100;
  const HIGH = 150;

  const summarize = (...readings: LabResult[]): LabSeriesSummary[] => computeAllLabSeriesSummaries(readings);
  const pinned = (...names: string[]) => (summary: LabSeriesSummary) => isLabSeriesPinned(summary, names);
  const names = (candidates: ReturnType<typeof recheckCandidates>) => candidates.map(c => c.summary.subItem);

  it('excludes an abnormal result at exactly the threshold and includes it one day later', () => {
    const atLimit = recheckCandidates(summarize(item('Alpha', ABNORMAL_RECHECK_DAYS, HIGH)), () => false, NOW);
    expect(atLimit).toEqual([]);

    const over = recheckCandidates(summarize(item('Alpha', ABNORMAL_RECHECK_DAYS + 1, HIGH)), () => false, NOW);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ reason: 'abnormal', ageDays: ABNORMAL_RECHECK_DAYS + 1 });
    expect(over[0].summary.subItem).toBe('Alpha');
  });

  it('includes abnormal results whether or not they are pinned', () => {
    const summaries = summarize(item('Alpha', 200, HIGH), item('Beta', 200, 50));
    const result = recheckCandidates(summaries, pinned('Alpha'), NOW);
    expect(names(result).sort()).toEqual(['Alpha', 'Beta']);
    expect(result.every(candidate => candidate.reason === 'abnormal')).toBe(true);
  });

  it('lists a pinned abnormal series once, as abnormal rather than routine', () => {
    const result = recheckCandidates(summarize(item('Alpha', 800, HIGH)), pinned('Alpha'), NOW);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('abnormal');
  });

  it('flags a pinned normal series only after a full year', () => {
    const atLimit = recheckCandidates(summarize(item('Alpha', ROUTINE_RECHECK_DAYS, NORMAL)), pinned('Alpha'), NOW);
    expect(atLimit).toEqual([]);

    const over = recheckCandidates(summarize(item('Alpha', ROUTINE_RECHECK_DAYS + 1, NORMAL)), pinned('Alpha'), NOW);
    expect(over).toHaveLength(1);
    expect(over[0]).toMatchObject({ reason: 'routine', ageDays: ROUTINE_RECHECK_DAYS + 1 });
  });

  it('ignores normal series that are not pinned', () => {
    expect(recheckCandidates(summarize(item('Alpha', 1000, NORMAL)), () => false, NOW)).toEqual([]);
  });

  it('treats a pinned series without a reference range as routine', () => {
    const unknown: LabResult = { ...item('Alpha', 500, NORMAL), refLow: null, refHigh: null };
    const result = recheckCandidates(summarize(unknown), pinned('Alpha'), NOW);
    expect(result).toHaveLength(1);
    expect(result[0].reason).toBe('routine');
  });

  it('does not flag recent results', () => {
    const summaries = summarize(item('Alpha', 5, HIGH), item('Beta', 5, NORMAL));
    expect(recheckCandidates(summaries, pinned('Alpha', 'Beta'), NOW)).toEqual([]);
  });

  it('uses the latest reading of a series, not an older one', () => {
    const summaries = summarize(item('Alpha', 400, HIGH), item('Alpha', 10, NORMAL));
    expect(recheckCandidates(summaries, pinned('Alpha'), NOW)).toEqual([]);
  });

  it('never flags a future-dated result', () => {
    const future: LabResult = { ...item('Alpha', 0, HIGH), date: new Date(2027, 0, 1) };
    expect(recheckCandidates(summarize(future), pinned('Alpha'), NOW)).toEqual([]);
  });

  it('puts abnormal first, then orders by how recently the result became overdue', () => {
    const summaries = summarize(
      item('Routine', 400, NORMAL),
      item('Old', 200, HIGH),
      item('Recent', 100, HIGH),
      item('Middle', 150, 50),
    );
    const result = recheckCandidates(summaries, pinned('Routine'), NOW);
    expect(names(result)).toEqual(['Recent', 'Middle', 'Old', 'Routine']);
    expect(result.map(candidate => candidate.reason)).toEqual(['abnormal', 'abnormal', 'abnormal', 'routine']);
  });

  it('breaks ties by name so the order is stable', () => {
    const summaries = summarize(item('Beta', 120, HIGH), item('Alpha', 120, HIGH));
    expect(names(recheckCandidates(summaries, () => false, NOW))).toEqual(['Alpha', 'Beta']);
  });

  it('does not modify its input', () => {
    const summaries = Object.freeze(summarize(item('Old', 200, HIGH), item('Recent', 100, HIGH)));
    const before = summaries.map(summary => summary.subItem);
    expect(() => recheckCandidates(summaries, () => false, NOW)).not.toThrow();
    expect(summaries.map(summary => summary.subItem)).toEqual(before);
  });

  it('returns an empty list when there are no summaries', () => {
    expect(recheckCandidates([], () => true, NOW)).toEqual([]);
  });
});
