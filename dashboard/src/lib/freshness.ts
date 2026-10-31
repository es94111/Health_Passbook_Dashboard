import type { NHIData } from '../parsers/types';
import { daysBetween } from './clock';
import { isAbnormalSummary, type LabSeriesSummary } from './clinicalLabSeries';

/** 最新一筆紀錄距今超過這個天數，就提醒使用者重新匯入。 */
export const STALE_DATA_DAYS = 90;
/** 最新數值異常的檢驗，超過這個天數未複驗就列入建議複驗。 */
export const ABNORMAL_RECHECK_DAYS = 90;
/** 已追蹤且數值正常的檢驗，超過這個天數未檢驗就列入建議複驗。 */
export const ROUTINE_RECHECK_DAYS = 365;

export type DatedRecords = Pick<
  NHIData,
  | 'visits'
  | 'hospitalizations'
  | 'vaccinations'
  | 'labResults'
  | 'checkupReports'
  | 'dentalVisits'
  | 'medicalReports'
  | 'medications'
  | 'textLabResults'
>;

export interface Freshness {
  latest: Date | null;
  ageDays: number | null;
  stale: boolean;
}

export type RecheckReason = 'abnormal' | 'routine';

export interface RecheckCandidate {
  summary: LabSeriesSummary;
  reason: RecheckReason;
  ageDays: number;
}

function newest<T>(records: readonly T[], pick: (record: T) => Date | null | undefined, current: number): number {
  let max = current;
  for (const record of records) {
    const date = pick(record);
    if (!date) continue;
    const time = date.getTime();
    if (Number.isFinite(time) && time > max) max = time;
  }
  return max;
}

/** 所有就醫與檢驗紀錄中最晚的日期；沒有任何有效日期時回傳 null。自我量測不計入。 */
export function latestRecordDate(data: DatedRecords): Date | null {
  let latest = -Infinity;
  latest = newest(data.visits, record => record.date, latest);
  latest = newest(data.hospitalizations, record => record.admitDate, latest);
  latest = newest(data.hospitalizations, record => record.dischargeDate, latest);
  latest = newest(data.vaccinations, record => record.date, latest);
  latest = newest(data.labResults, record => record.date, latest);
  latest = newest(data.textLabResults, record => record.date, latest);
  latest = newest(data.checkupReports, record => record.date, latest);
  latest = newest(data.dentalVisits, record => record.date, latest);
  latest = newest(data.medicalReports, record => record.date, latest);
  latest = newest(data.medications, record => record.date, latest);
  return Number.isFinite(latest) ? new Date(latest) : null;
}

/** 資料新鮮度；未來日期視為 0 天，不會被判定為過期。 */
export function computeFreshness(latest: Date | null, now: Date): Freshness {
  if (!latest) return { latest: null, ageDays: null, stale: false };
  const ageDays = Math.max(0, daysBetween(latest, now));
  return { latest, ageDays, stale: ageDays > STALE_DATA_DAYS };
}

/**
 * 建議複驗清單：異常項目（不論是否追蹤）超過 90 天、已追蹤且正常或無參考值的項目超過 365 天。
 * 異常優先，其餘依距今天數由少到多排列（剛過期的最值得處理）。
 */
export function recheckCandidates(
  summaries: readonly LabSeriesSummary[],
  isPinned: (summary: LabSeriesSummary) => boolean,
  now: Date,
): RecheckCandidate[] {
  const candidates: RecheckCandidate[] = [];
  for (const summary of summaries) {
    const ageDays = Math.max(0, daysBetween(summary.latestDate, now));
    if (isAbnormalSummary(summary)) {
      if (ageDays > ABNORMAL_RECHECK_DAYS) candidates.push({ summary, reason: 'abnormal', ageDays });
    } else if (ageDays > ROUTINE_RECHECK_DAYS && isPinned(summary)) {
      candidates.push({ summary, reason: 'routine', ageDays });
    }
  }
  return candidates.sort(
    (a, b) =>
      Number(a.reason === 'routine') - Number(b.reason === 'routine') ||
      a.ageDays - b.ageDays ||
      a.summary.subItem.localeCompare(b.summary.subItem) ||
      a.summary.key.localeCompare(b.summary.key),
  );
}
