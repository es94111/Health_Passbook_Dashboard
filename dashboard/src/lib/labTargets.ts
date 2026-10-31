import { PERSONAL_LIMITS, PERSONAL_TEXT_LIMITS, type LabTarget, type PersonalData } from '../personalData';
import { labReference } from './clinicalLabSeries';
import { statusFor } from './keySummary';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export interface LabTargetForm {
  low: string;
  high: string;
}

export const EMPTY_TARGET_FORM: LabTargetForm = { low: '', high: '' };

const BOUND_LIMIT = 1e9;
// 最多 6 位小數，確保 String(n) 不會產生科學記號，表單才能無損往返。
const NUMBER_PATTERN = /^-?\d+(?:\.\d{1,6})?$/;

function parseBound(raw: string, label: '下限' | '上限'): ValidationResult<number | undefined> {
  const text = raw.normalize('NFKC').trim();
  if (text === '') return { ok: true, value: undefined };
  if (!NUMBER_PATTERN.test(text)) {
    return { ok: false, error: `${label}請輸入數字（例如 90 或 5.5，最多 6 位小數）` };
  }
  const value = Number(text);
  if (Math.abs(value) > BOUND_LIMIT) {
    return { ok: false, error: `${label}的絕對值不可超過 1,000,000,000` };
  }
  return { ok: true, value: value === 0 ? 0 : value };
}

export function validateLabTarget(form: LabTargetForm): ValidationResult<LabTarget> {
  const low = parseBound(form.low, '下限');
  if (!low.ok) return low;
  const high = parseBound(form.high, '上限');
  if (!high.ok) return high;
  if (low.value === undefined && high.value === undefined) {
    return { ok: false, error: '請至少填寫下限或上限' };
  }
  if (low.value !== undefined && high.value !== undefined && low.value > high.value) {
    return { ok: false, error: '下限不可大於上限' };
  }
  const target: LabTarget = {};
  if (low.value !== undefined) target.low = low.value;
  if (high.value !== undefined) target.high = high.value;
  return { ok: true, value: target };
}

export function targetToForm(target?: LabTarget): LabTargetForm {
  return {
    low: target?.low === undefined ? '' : String(target.low),
    high: target?.high === undefined ? '' : String(target.high),
  };
}

/** 與檢驗參考區間相同的寫法：≤ 90、≥ 70、70–90。 */
export function describeTarget(target: LabTarget): string {
  return labReference({ refLow: target.low ?? null, refHigh: target.high ?? null });
}

export function isOutsideTarget(value: number, target: LabTarget): boolean {
  const status = statusFor(value, target.low ?? null, target.high ?? null);
  return status === 'high' || status === 'low';
}

/** 回傳錯誤訊息；已存在的項目即使在上限也允許修改。 */
export function checkTargetKey(targets: Record<string, LabTarget>, key: string): string | null {
  if (!key || key.length > PERSONAL_TEXT_LIMITS.key) return '此檢驗項目的識別碼過長，無法儲存個人目標';
  if (!Object.hasOwn(targets, key) && Object.keys(targets).length >= PERSONAL_LIMITS.targets) {
    return `個人目標已達上限（${PERSONAL_LIMITS.targets} 項）`;
  }
  return null;
}

export function withTarget(current: PersonalData, key: string, target: LabTarget): PersonalData {
  return { ...current, targets: { ...current.targets, [key]: target } };
}

export function withoutTarget(current: PersonalData, key: string): PersonalData {
  return {
    ...current,
    targets: Object.fromEntries(Object.entries(current.targets).filter(([existing]) => existing !== key)),
  };
}
