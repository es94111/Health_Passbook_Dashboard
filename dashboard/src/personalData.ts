/**
 * 使用者自行輸入的資料（追蹤目標、自我量測、備忘、健康檔案、領藥計畫）。
 * 與匯入的醫療紀錄一同存在瀏覽器端加密的紀錄庫內，伺服器看不到明文。
 * 本檔必須保持自足（不得 import recordStore），避免循環相依。
 */

export const PERSONAL_VERSION = 1;

export const PERSONAL_LIMITS = {
  targets: 500,
  measurements: 20000,
  notes: 2000,
  allergies: 200,
  conditions: 200,
  refills: 200,
} as const;

export const PERSONAL_TEXT_LIMITS = { key: 600, name: 120, detail: 300, note: 2000 } as const;

export type MeasurementKind = 'bp' | 'glucose' | 'weight';
export type GlucoseContext = 'fasting' | 'postMeal' | 'random';
export type NoteKind = 'note' | 'question';
export type AllergySeverity = 'mild' | 'moderate' | 'severe';

export interface LabTarget {
  low?: number;
  high?: number;
}

interface MeasurementBase {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm */
  time?: string;
  note?: string;
}

export interface BloodPressureMeasurement extends MeasurementBase {
  kind: 'bp';
  systolic: number;
  diastolic: number;
  pulse?: number;
}

export interface GlucoseMeasurement extends MeasurementBase {
  kind: 'glucose';
  value: number;
  context: GlucoseContext;
}

export interface WeightMeasurement extends MeasurementBase {
  kind: 'weight';
  value: number;
}

export type Measurement = BloodPressureMeasurement | GlucoseMeasurement | WeightMeasurement;

export interface PersonalNote {
  id: string;
  date: string;
  kind: NoteKind;
  text: string;
  done?: true;
}

export interface Allergy {
  id: string;
  name: string;
  reaction?: string;
  severity?: AllergySeverity;
}

export interface Condition {
  id: string;
  name: string;
  sinceYear?: number;
}

export interface RefillPlan {
  id: string;
  drugName: string;
  drugCode?: string;
  hospital?: string;
  /** 處方開立日（第 1 次領藥的起算日） */
  prescribedDate: string;
  daysPerFill: number;
  fills: number;
  /** 已領藥次數（含第 1 次） */
  taken: number;
  note?: string;
}

export interface PersonalProfile {
  allergies: Allergy[];
  conditions: Condition[];
}

export interface PersonalData {
  version: typeof PERSONAL_VERSION;
  /** 以檢驗序列 key 為索引的個人追蹤目標 */
  targets: Record<string, LabTarget>;
  measurements: Measurement[];
  notes: PersonalNote[];
  profile: PersonalProfile;
  refills: RefillPlan[];
}

export function emptyPersonal(): PersonalData {
  return { version: PERSONAL_VERSION, targets: {}, measurements: [], notes: [], profile: { allergies: [], conditions: [] }, refills: [] };
}

export function isPersonalEmpty(personal: PersonalData): boolean {
  return Object.keys(personal.targets).length === 0 && personal.measurements.length === 0 && personal.notes.length === 0
    && personal.profile.allergies.length === 0 && personal.profile.conditions.length === 0 && personal.refills.length === 0;
}

export function newPersonalId(): string {
  return crypto.randomUUID();
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ID_PATTERN = /^[\w-]{1,64}$/;
const SEVERITIES: readonly AllergySeverity[] = ['mild', 'moderate', 'severe'];
const GLUCOSE_CONTEXTS: readonly GlucoseContext[] = ['fasting', 'postMeal', 'random'];
const NOTE_KINDS: readonly NoteKind[] = ['note', 'question'];

function corrupt(what: string): Error {
  return new Error(`加密個人資料已損壞：${what}`);
}

function plain(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw corrupt(what);
  return value as Record<string, unknown>;
}

function list(value: unknown, max: number, what: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) throw corrupt(what);
  return value;
}

function text(value: unknown, max: number, what: string): string {
  if (typeof value !== 'string') throw corrupt(what);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) throw corrupt(what);
  return trimmed;
}

function optionalText(value: unknown, max: number, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw corrupt(what);
  const trimmed = value.trim();
  if (trimmed.length > max) throw corrupt(what);
  return trimmed || undefined;
}

function number(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw corrupt(what);
  return value;
}

function optionalNumber(value: unknown, min: number, max: number, what: string): number | undefined {
  return value === undefined || value === null ? undefined : number(value, min, max, what);
}

function integer(value: unknown, min: number, max: number, what: string): number {
  const result = number(value, min, max, what);
  if (!Number.isInteger(result)) throw corrupt(what);
  return result;
}

function day(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ISO_DAY.test(value) || value < '1900-01-01') throw corrupt(what);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw corrupt(what);
  return value;
}

function timeOfDay(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !ISO_TIME.test(value)) throw corrupt('量測時間');
  return value;
}

function identifier(value: unknown, seen: Set<string>, what: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || seen.has(value)) throw corrupt(what);
  seen.add(value);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw corrupt(what);
  return value as T;
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function normalizeTargets(value: unknown): Record<string, LabTarget> {
  if (value === undefined) return {};
  const source = plain(value, '追蹤目標');
  const keys = Object.keys(source);
  if (keys.length > PERSONAL_LIMITS.targets) throw corrupt('追蹤目標數量');
  const entries = keys.sort().map((key): [string, LabTarget] => {
    if (!key || key.length > PERSONAL_TEXT_LIMITS.key) throw corrupt('追蹤目標名稱');
    const item = plain(source[key], '追蹤目標');
    const low = optionalNumber(item.low, -1e9, 1e9, '目標下限');
    const high = optionalNumber(item.high, -1e9, 1e9, '目標上限');
    if (low === undefined && high === undefined) throw corrupt('追蹤目標範圍');
    if (low !== undefined && high !== undefined && low > high) throw corrupt('追蹤目標範圍');
    return [key, { ...optional('low', low), ...optional('high', high) }];
  });
  return Object.fromEntries(entries);
}

function byWhen(a: { date: string; time?: string; id: string }, b: { date: string; time?: string; id: string }): number {
  return a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.id.localeCompare(b.id);
}

function normalizeMeasurement(raw: unknown, ids: Set<string>): Measurement {
  const item = plain(raw, '量測紀錄');
  const common = {
    id: identifier(item.id, ids, '量測編號'),
    date: day(item.date, '量測日期'),
    ...optional('time', timeOfDay(item.time)),
    ...optional('note', optionalText(item.note, PERSONAL_TEXT_LIMITS.detail, '量測備註')),
  };
  switch (item.kind) {
    case 'bp':
      return {
        ...common,
        kind: 'bp',
        systolic: number(item.systolic, 30, 300, '收縮壓'),
        diastolic: number(item.diastolic, 10, 200, '舒張壓'),
        ...optional('pulse', optionalNumber(item.pulse, 20, 300, '脈搏')),
      };
    case 'glucose':
      return { ...common, kind: 'glucose', value: number(item.value, 10, 1500, '血糖'), context: oneOf(item.context, GLUCOSE_CONTEXTS, '血糖情境') };
    case 'weight':
      return { ...common, kind: 'weight', value: number(item.value, 1, 500, '體重') };
    default:
      throw corrupt('量測類型');
  }
}

function normalizeNote(raw: unknown, ids: Set<string>): PersonalNote {
  const item = plain(raw, '備忘');
  if (item.done !== undefined && typeof item.done !== 'boolean') throw corrupt('備忘狀態');
  return {
    id: identifier(item.id, ids, '備忘編號'),
    date: day(item.date, '備忘日期'),
    kind: oneOf(item.kind, NOTE_KINDS, '備忘類型'),
    text: text(item.text, PERSONAL_TEXT_LIMITS.note, '備忘內容'),
    ...(item.done === true ? { done: true as const } : {}),
  };
}

function normalizeAllergy(raw: unknown, ids: Set<string>): Allergy {
  const item = plain(raw, '過敏史');
  return {
    id: identifier(item.id, ids, '過敏史編號'),
    name: text(item.name, PERSONAL_TEXT_LIMITS.name, '過敏原'),
    ...optional('reaction', optionalText(item.reaction, PERSONAL_TEXT_LIMITS.detail, '過敏反應')),
    ...optional('severity', item.severity === undefined || item.severity === null ? undefined : oneOf(item.severity, SEVERITIES, '過敏嚴重度')),
  };
}

function normalizeCondition(raw: unknown, ids: Set<string>): Condition {
  const item = plain(raw, '慢性病史');
  return {
    id: identifier(item.id, ids, '慢性病史編號'),
    name: text(item.name, PERSONAL_TEXT_LIMITS.name, '病名'),
    ...optional('sinceYear', item.sinceYear === undefined || item.sinceYear === null ? undefined : integer(item.sinceYear, 1900, 2200, '確診年份')),
  };
}

function normalizeRefill(raw: unknown, ids: Set<string>): RefillPlan {
  const item = plain(raw, '領藥計畫');
  const fills = integer(item.fills, 1, 12, '領藥總次數');
  return {
    id: identifier(item.id, ids, '領藥計畫編號'),
    drugName: text(item.drugName, PERSONAL_TEXT_LIMITS.name, '藥品名稱'),
    ...optional('drugCode', optionalText(item.drugCode, 40, '藥品代碼')),
    ...optional('hospital', optionalText(item.hospital, PERSONAL_TEXT_LIMITS.name, '院所')),
    prescribedDate: day(item.prescribedDate, '處方日期'),
    daysPerFill: integer(item.daysPerFill, 1, 180, '每次給藥天數'),
    fills,
    taken: integer(item.taken, 1, fills, '已領藥次數'),
    ...optional('note', optionalText(item.note, PERSONAL_TEXT_LIMITS.detail, '領藥備註')),
  };
}

function normalizeList<T>(value: unknown, max: number, what: string, normalizeItem: (raw: unknown, ids: Set<string>) => T): T[] {
  const ids = new Set<string>();
  return list(value, max, what).map(raw => normalizeItem(raw, ids));
}

/**
 * 嚴格驗證並正規化；缺少（舊資料）時回傳空白預設值，結構損壞則丟出錯誤。
 * 輸出的鍵順序固定，重複儲存同樣內容會得到同樣的位元組。
 */
export function normalizePersonalData(value: unknown): PersonalData {
  if (value === undefined || value === null) return emptyPersonal();
  const root = plain(value, '資料結構');
  if (root.version !== PERSONAL_VERSION) throw corrupt('版本不支援');
  const profile = root.profile === undefined ? {} : plain(root.profile, '健康檔案');
  return {
    version: PERSONAL_VERSION,
    targets: normalizeTargets(root.targets),
    measurements: normalizeList(root.measurements, PERSONAL_LIMITS.measurements, '量測紀錄', normalizeMeasurement).sort(byWhen),
    notes: normalizeList(root.notes, PERSONAL_LIMITS.notes, '備忘', normalizeNote).sort(byWhen),
    profile: {
      allergies: normalizeList(profile.allergies, PERSONAL_LIMITS.allergies, '過敏史', normalizeAllergy),
      conditions: normalizeList(profile.conditions, PERSONAL_LIMITS.conditions, '慢性病史', normalizeCondition),
    },
    refills: normalizeList(root.refills, PERSONAL_LIMITS.refills, '領藥計畫', normalizeRefill),
  };
}
