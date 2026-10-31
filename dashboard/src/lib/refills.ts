import { PERSONAL_TEXT_LIMITS, type RefillPlan } from '../personalData';
import { addDays, daysBetween, formatLocalDate, parseLocalDate } from './clock';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type RefillState = 'notYet' | 'open' | 'overdue' | 'finished';

export interface RefillStatus {
  state: RefillState;
  label: string;
  /** 最早建議領藥日；連續處方已領完時為 null。 */
  windowOpensOn: Date | null;
  /** 依已領藥次數推估的藥量用完日（finished 時仍依 taken 計算，僅供參考）。 */
  supplyEndsOn: Date;
  remainingFills: number;
  /** 正數表示最早領藥日在今天之後。 */
  daysUntilOpen: number;
  /** 正數表示藥量用完日在今天之後。 */
  daysUntilEnd: number;
}

export interface RefillEntry {
  plan: RefillPlan;
  status: RefillStatus;
}

export interface RefillFormInput {
  drugName: string;
  drugCode: string;
  hospital: string;
  prescribedDate: string;
  daysPerFill: string;
  fills: string;
  taken: string;
  note: string;
}

/** 提醒用的參考天數：預估用完日前幾天起顯示「可領藥」，不是健保的領藥規定。 */
export const REFILL_WINDOW_DAYS = 10;
export const REFILL_DISCLAIMER = '實際規定以健保署與藥局為準';

export const EMPTY_REFILL_FORM: RefillFormInput = {
  drugName: '',
  drugCode: '',
  hospital: '',
  prescribedDate: '',
  daysPerFill: '',
  fills: '',
  taken: '1',
  note: '',
};

const DRUG_CODE_MAX = 40;
const MIN_PRESCRIBED_DATE = '1900-01-01';

const STATE_LABELS: Record<RefillState, string> = {
  notYet: '尚未到期',
  open: '可領藥',
  overdue: '藥量可能已用完',
  finished: '連續處方已領完，需回診開立新處方',
};

const STATE_RANK: Record<RefillState, number> = { overdue: 0, open: 1, notYet: 2, finished: 3 };

export function computeRefillStatus(plan: RefillPlan, now: Date): RefillStatus {
  const today = parseLocalDate(formatLocalDate(now));
  const supplyEndsOn = addDays(parseLocalDate(plan.prescribedDate), plan.taken * plan.daysPerFill);
  const opensOn = addDays(supplyEndsOn, -REFILL_WINDOW_DAYS);
  const daysUntilOpen = daysBetween(today, opensOn);
  const daysUntilEnd = daysBetween(today, supplyEndsOn);

  let state: RefillState;
  if (plan.taken >= plan.fills) state = 'finished';
  else if (daysUntilOpen > 0) state = 'notYet';
  else if (daysUntilEnd > 0) state = 'open';
  else state = 'overdue';

  return {
    state,
    label: STATE_LABELS[state],
    windowOpensOn: state === 'finished' ? null : opensOn,
    supplyEndsOn,
    remainingFills: Math.max(0, plan.fills - plan.taken),
    daysUntilOpen,
    daysUntilEnd,
  };
}

/** 清單上的輔助說明，例如「3 天後開始可領」；已領完的處方沒有時程可說明，回傳 null。 */
export function describeRefillTiming(status: RefillStatus): string | null {
  switch (status.state) {
    case 'notYet':
      return `${status.daysUntilOpen} 天後開始可領`;
    case 'open':
      return `預估 ${status.daysUntilEnd} 天後用完`;
    case 'overdue':
      return status.daysUntilEnd === 0 ? '預估今天用完' : `預估已用完 ${-status.daysUntilEnd} 天`;
    case 'finished':
      return null;
  }
}

function urgencyKey(status: RefillStatus): number {
  switch (status.state) {
    case 'overdue':
    case 'open':
      return status.daysUntilEnd;
    case 'notYet':
      return status.daysUntilOpen;
    case 'finished':
      return 0;
  }
}

/** 逾期（逾期最久者在前）→ 可領藥（最快用完者在前）→ 尚未到期（最早可領者在前）→ 已領完；同分維持輸入順序。 */
export function sortRefillsByUrgency(plans: RefillPlan[], now: Date): RefillEntry[] {
  return plans
    .map((plan, index) => ({ plan, status: computeRefillStatus(plan, now), index }))
    .sort(
      (a, b) =>
        STATE_RANK[a.status.state] - STATE_RANK[b.status.state] ||
        urgencyKey(a.status) - urgencyKey(b.status) ||
        a.index - b.index,
    )
    .map(({ plan, status }) => ({ plan, status }));
}

/** 只留下需要採取行動的處方（可領藥或可能已逾期），順序同 sortRefillsByUrgency。 */
export function refillReminders(plans: RefillPlan[], now: Date): RefillEntry[] {
  return sortRefillsByUrgency(plans, now).filter(
    ({ status }) => status.state === 'open' || status.state === 'overdue',
  );
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function parseInteger(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : null;
}

function isRealDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    value >= MIN_PRESCRIBED_DATE &&
    formatLocalDate(parseLocalDate(value)) === value
  );
}

export function validateRefillPlan(
  input: RefillFormInput,
  now: Date,
): ValidationResult<Omit<RefillPlan, 'id'>> {
  const drugName = input.drugName.trim();
  const drugCode = input.drugCode.trim();
  const hospital = input.hospital.trim();
  const prescribedDate = input.prescribedDate.trim();
  const note = input.note.trim();

  if (!drugName) return fail('請輸入藥品名稱');
  if (drugName.length > PERSONAL_TEXT_LIMITS.name) {
    return fail(`藥品名稱不能超過 ${PERSONAL_TEXT_LIMITS.name} 字`);
  }
  if (drugCode.length > DRUG_CODE_MAX) return fail(`藥品代碼不能超過 ${DRUG_CODE_MAX} 字`);
  if (hospital.length > PERSONAL_TEXT_LIMITS.name) {
    return fail(`醫院名稱不能超過 ${PERSONAL_TEXT_LIMITS.name} 字`);
  }
  if (!prescribedDate) return fail('請輸入處方開立日');
  if (!isRealDate(prescribedDate)) return fail(`處方開立日需為 ${MIN_PRESCRIBED_DATE} 起的有效日期`);
  if (prescribedDate > formatLocalDate(now)) return fail('處方開立日不能晚於今天');

  const daysPerFill = parseInteger(input.daysPerFill.trim(), 1, 180);
  if (daysPerFill === null) return fail('每次天數需為 1–180 的整數');
  const fills = parseInteger(input.fills.trim(), 1, 12);
  if (fills === null) return fail('連續處方總次數需為 1–12 的整數');
  const taken = parseInteger(input.taken.trim(), 1, fills);
  if (taken === null) return fail('已領藥次數需介於 1 與總次數之間');
  if (note.length > PERSONAL_TEXT_LIMITS.detail) {
    return fail(`備註不能超過 ${PERSONAL_TEXT_LIMITS.detail} 字`);
  }

  return {
    ok: true,
    value: {
      drugName,
      ...(drugCode ? { drugCode } : {}),
      ...(hospital ? { hospital } : {}),
      prescribedDate,
      daysPerFill,
      fills,
      taken,
      ...(note ? { note } : {}),
    },
  };
}
