import { PERSONAL_TEXT_LIMITS } from '../personalData';
import type {
  BloodPressureMeasurement,
  GlucoseContext,
  GlucoseMeasurement,
  Measurement,
  MeasurementKind,
  WeightMeasurement,
} from '../personalData';
import { daysBetween, formatLocalDate, parseLocalDate } from './clock';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type NewMeasurement =
  | Omit<BloodPressureMeasurement, 'id'>
  | Omit<GlucoseMeasurement, 'id'>
  | Omit<WeightMeasurement, 'id'>;

export const EMPTY_VALUE = '—';

export const MEASUREMENT_KINDS: readonly MeasurementKind[] = ['bp', 'glucose', 'weight'];

export const MEASUREMENT_KIND_LABEL: Record<MeasurementKind, string> = {
  bp: '血壓',
  glucose: '血糖',
  weight: '體重',
};

export const MEASUREMENT_UNIT: Record<MeasurementKind, string> = {
  bp: 'mmHg',
  glucose: 'mg/dL',
  weight: 'kg',
};

export const GLUCOSE_CONTEXTS: readonly GlucoseContext[] = ['fasting', 'postMeal', 'random'];

export const GLUCOSE_CONTEXT_LABEL: Record<GlucoseContext, string> = {
  fasting: '空腹',
  postMeal: '餐後',
  random: '隨機',
};

export function isGlucoseContext(value: string): value is GlucoseContext {
  return GLUCOSE_CONTEXTS.some(context => context === value);
}

export interface SplitMeasurements {
  bp: BloodPressureMeasurement[];
  glucose: GlucoseMeasurement[];
  weight: WeightMeasurement[];
}

function compareMeasurements(a: Measurement, b: Measurement): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  const timeA = a.time ?? '';
  const timeB = b.time ?? '';
  if (timeA !== timeB) return timeA < timeB ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

export function splitByKind(measurements: Measurement[]): SplitMeasurements {
  const result: SplitMeasurements = { bp: [], glucose: [], weight: [] };
  for (const measurement of measurements) {
    if (measurement.kind === 'bp') result.bp.push(measurement);
    else if (measurement.kind === 'glucose') result.glucose.push(measurement);
    else result.weight.push(measurement);
  }
  result.bp.sort(compareMeasurements);
  result.glucose.sort(compareMeasurements);
  result.weight.sort(compareMeasurements);
  return result;
}

export interface WindowAverages {
  avg7: number | null;
  avg30: number | null;
}

export interface BpSummary {
  count: number;
  latest: BloodPressureMeasurement | null;
  systolic: WindowAverages;
  diastolic: WindowAverages;
}

export interface ValueKindSummary<T> {
  count: number;
  latest: T | null;
  value: WindowAverages;
}

export interface MeasurementsSummary {
  bp: BpSummary;
  glucose: ValueKindSummary<GlucoseMeasurement>;
  weight: ValueKindSummary<WeightMeasurement>;
}

const SHORT_WINDOW_DAYS = 7;
const LONG_WINDOW_DAYS = 30;

// 窗口以本地日曆日計算並含今天；未來日期不納入。
function averageWindows<T extends Measurement>(
  items: readonly T[],
  pick: (item: T) => number,
  today: Date,
): WindowAverages {
  let sum7 = 0;
  let count7 = 0;
  let sum30 = 0;
  let count30 = 0;
  for (const item of items) {
    const age = daysBetween(parseLocalDate(item.date), today);
    if (!(age >= 0 && age < LONG_WINDOW_DAYS)) continue;
    const value = pick(item);
    sum30 += value;
    count30 += 1;
    if (age < SHORT_WINDOW_DAYS) {
      sum7 += value;
      count7 += 1;
    }
  }
  return {
    avg7: count7 > 0 ? sum7 / count7 : null,
    avg30: count30 > 0 ? sum30 / count30 : null,
  };
}

export function summarizeMeasurements(measurements: Measurement[], now: Date): MeasurementsSummary {
  const today = parseLocalDate(formatLocalDate(now));
  const { bp, glucose, weight } = splitByKind(measurements);
  return {
    bp: {
      count: bp.length,
      latest: bp[bp.length - 1] ?? null,
      systolic: averageWindows(bp, item => item.systolic, today),
      diastolic: averageWindows(bp, item => item.diastolic, today),
    },
    glucose: {
      count: glucose.length,
      latest: glucose[glucose.length - 1] ?? null,
      value: averageWindows(glucose, item => item.value, today),
    },
    weight: {
      count: weight.length,
      latest: weight[weight.length - 1] ?? null,
      value: averageWindows(weight, item => item.value, today),
    },
  };
}

export function formatMeasurementValue(measurement: Measurement): string {
  switch (measurement.kind) {
    case 'bp':
      return `${measurement.systolic}/${measurement.diastolic}`;
    case 'glucose':
      return String(measurement.value);
    case 'weight':
      return measurement.value.toFixed(1);
  }
}

export function formatMeasurementMoment(measurement: Measurement): string {
  return measurement.time ? `${measurement.date} ${measurement.time}` : measurement.date;
}

function formatAverage(value: number | null, digits: number): string {
  return value === null ? EMPTY_VALUE : value.toFixed(digits);
}

function formatBpAverage(systolic: number | null, diastolic: number | null): string {
  if (systolic === null || diastolic === null) return EMPTY_VALUE;
  return `${systolic.toFixed(0)}/${diastolic.toFixed(0)}`;
}

export interface SummaryDisplay {
  count: number;
  latestValue: string;
  latestMoment: string | null;
  avg7: string;
  avg30: string;
}

export function describeSummary(summary: MeasurementsSummary, kind: MeasurementKind): SummaryDisplay {
  if (kind === 'bp') {
    const { count, latest, systolic, diastolic } = summary.bp;
    return {
      count,
      latestValue: latest ? formatMeasurementValue(latest) : EMPTY_VALUE,
      latestMoment: latest ? formatMeasurementMoment(latest) : null,
      avg7: formatBpAverage(systolic.avg7, diastolic.avg7),
      avg30: formatBpAverage(systolic.avg30, diastolic.avg30),
    };
  }
  const { count, latest, value } = summary[kind];
  const digits = kind === 'weight' ? 1 : 0;
  return {
    count,
    latestValue: latest ? formatMeasurementValue(latest) : EMPTY_VALUE,
    latestMoment: latest ? formatMeasurementMoment(latest) : null,
    avg7: formatAverage(value.avg7, digits),
    avg30: formatAverage(value.avg30, digits),
  };
}

export type ChartRange = '30' | '90' | '365' | 'all';

export const CHART_RANGE_OPTIONS: ReadonlyArray<{ readonly value: ChartRange; readonly label: string }> = [
  { value: '30', label: '近 30 天' },
  { value: '90', label: '近 90 天' },
  { value: '365', label: '近 1 年' },
  { value: 'all', label: '全部' },
];

const CHART_RANGE_DAYS: Record<Exclude<ChartRange, 'all'>, number> = { '30': 30, '90': 90, '365': 365 };

export function isChartRange(value: string): value is ChartRange {
  return CHART_RANGE_OPTIONS.some(option => option.value === value);
}

export function filterByChartRange<T extends Measurement>(items: readonly T[], range: ChartRange, now: Date): T[] {
  if (range === 'all') return [...items];
  const days = CHART_RANGE_DAYS[range];
  const today = parseLocalDate(formatLocalDate(now));
  return items.filter(item => {
    const age = daysBetween(parseLocalDate(item.date), today);
    return age >= 0 && age < days;
  });
}

export interface TrendPoint {
  index: number;
  id: string;
  label: string;
  primary: number;
  secondary?: number;
}

export function buildTrendPoints(items: readonly Measurement[]): TrendPoint[] {
  return items.map((item, index) => ({
    index,
    id: item.id,
    label: formatMeasurementMoment(item),
    primary: item.kind === 'bp' ? item.systolic : item.value,
    ...(item.kind === 'bp' ? { secondary: item.diastolic } : {}),
  }));
}

export interface BloodPressureInput {
  date: string;
  time: string;
  systolic: string;
  diastolic: string;
  pulse: string;
  note: string;
}

export interface GlucoseInput {
  date: string;
  time: string;
  value: string;
  context: GlucoseContext | '';
  note: string;
}

export interface WeightInput {
  date: string;
  time: string;
  value: string;
  note: string;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

interface NumberRule {
  label: string;
  required: string;
  min: number;
  max: number;
  unit: string;
  integer: boolean;
}

const SYSTOLIC_RULE: NumberRule = { label: '收縮壓', required: '請輸入收縮壓', min: 30, max: 300, unit: 'mmHg', integer: true };
const DIASTOLIC_RULE: NumberRule = { label: '舒張壓', required: '請輸入舒張壓', min: 10, max: 200, unit: 'mmHg', integer: true };
const PULSE_RULE: NumberRule = { label: '脈搏', required: '請輸入脈搏', min: 20, max: 300, unit: '次/分', integer: true };
const GLUCOSE_RULE: NumberRule = { label: '血糖值', required: '請輸入血糖值', min: 10, max: 1500, unit: 'mg/dL', integer: false };
const WEIGHT_RULE: NumberRule = { label: '體重', required: '請輸入體重', min: 1, max: 500, unit: 'kg', integer: false };

function parseNumber(raw: string, rule: NumberRule): ValidationResult<number> {
  const text = raw.trim();
  if (text === '') return fail(rule.required);
  if (rule.integer) {
    if (!/^\d+$/.test(text)) {
      return fail(/^\d+\.\d+$/.test(text) ? `${rule.label}必須是整數` : `${rule.label}必須是數字`);
    }
  } else {
    if (!/^\d+(\.\d+)?$/.test(text)) return fail(`${rule.label}必須是數字`);
    if (!/^\d+(\.\d)?$/.test(text)) return fail(`${rule.label}最多一位小數`);
  }
  const value = Number(text);
  if (value < rule.min || value > rule.max) {
    return fail(`${rule.label}需介於 ${rule.min}–${rule.max} ${rule.unit}`);
  }
  return { ok: true, value };
}

function parseOptionalNumber(raw: string, rule: NumberRule): ValidationResult<number | undefined> {
  if (raw.trim() === '') return { ok: true, value: undefined };
  return parseNumber(raw, rule);
}

const MIN_DATE = '1900-01-01';

function validateDate(raw: string, now: Date): ValidationResult<string> {
  const date = raw.trim();
  if (date === '') return fail('請選擇日期');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('日期格式不正確');
  if (date < MIN_DATE) return fail(`日期不能早於 ${MIN_DATE}`);
  if (formatLocalDate(parseLocalDate(date)) !== date) return fail('日期格式不正確');
  if (date > formatLocalDate(now)) return fail('日期不能晚於今天');
  return { ok: true, value: date };
}

function validateTime(raw: string): ValidationResult<string | undefined> {
  const time = raw.trim();
  if (time === '') return { ok: true, value: undefined };
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return fail('時間格式不正確（HH:mm）');
  return { ok: true, value: time };
}

function validateNote(raw: string): ValidationResult<string | undefined> {
  const note = raw.trim();
  if (note.length > PERSONAL_TEXT_LIMITS.detail) {
    return fail(`備註不可超過 ${PERSONAL_TEXT_LIMITS.detail} 字`);
  }
  return { ok: true, value: note === '' ? undefined : note };
}

interface CommonFields {
  date: string;
  time?: string;
  note?: string;
}

function validateCommonFields(
  input: { date: string; time: string; note: string },
  now: Date,
): ValidationResult<CommonFields> {
  const date = validateDate(input.date, now);
  if (!date.ok) return date;
  const time = validateTime(input.time);
  if (!time.ok) return time;
  const note = validateNote(input.note);
  if (!note.ok) return note;
  return {
    ok: true,
    value: {
      date: date.value,
      ...(time.value !== undefined ? { time: time.value } : {}),
      ...(note.value !== undefined ? { note: note.value } : {}),
    },
  };
}

export function validateBloodPressure(
  input: BloodPressureInput,
  now: Date,
): ValidationResult<Omit<BloodPressureMeasurement, 'id'>> {
  const systolic = parseNumber(input.systolic, SYSTOLIC_RULE);
  if (!systolic.ok) return systolic;
  const diastolic = parseNumber(input.diastolic, DIASTOLIC_RULE);
  if (!diastolic.ok) return diastolic;
  if (systolic.value <= diastolic.value) return fail('收縮壓必須大於舒張壓');
  const pulse = parseOptionalNumber(input.pulse, PULSE_RULE);
  if (!pulse.ok) return pulse;
  const common = validateCommonFields(input, now);
  if (!common.ok) return common;
  return {
    ok: true,
    value: {
      kind: 'bp',
      systolic: systolic.value,
      diastolic: diastolic.value,
      ...(pulse.value !== undefined ? { pulse: pulse.value } : {}),
      ...common.value,
    },
  };
}

export function validateGlucose(
  input: GlucoseInput,
  now: Date,
): ValidationResult<Omit<GlucoseMeasurement, 'id'>> {
  const value = parseNumber(input.value, GLUCOSE_RULE);
  if (!value.ok) return value;
  if (input.context === '') return fail('請選擇情境');
  const common = validateCommonFields(input, now);
  if (!common.ok) return common;
  return {
    ok: true,
    value: { kind: 'glucose', value: value.value, context: input.context, ...common.value },
  };
}

export function validateWeight(
  input: WeightInput,
  now: Date,
): ValidationResult<Omit<WeightMeasurement, 'id'>> {
  const value = parseNumber(input.value, WEIGHT_RULE);
  if (!value.ok) return value;
  const common = validateCommonFields(input, now);
  if (!common.ok) return common;
  return { ok: true, value: { kind: 'weight', value: value.value, ...common.value } };
}
