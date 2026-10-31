import type { Allergy, AllergySeverity, Condition, NoteKind, PersonalNote } from '../personalData';
import { PERSONAL_LIMITS, PERSONAL_TEXT_LIMITS } from '../personalData';
import { formatLocalDate, parseLocalDate } from './clock';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type NoteFilter = 'all' | 'note' | 'open' | 'done';

export const ALLERGY_SEVERITY_LABEL: Record<AllergySeverity, string> = {
  mild: '輕微',
  moderate: '中度',
  severe: '嚴重',
};

export const NOTE_KIND_LABEL: Record<NoteKind, string> = {
  note: '筆記',
  question: '回診問題',
};

export const NOTE_FILTER_LABEL: Record<NoteFilter, string> = {
  all: '全部',
  note: '筆記',
  open: '待問',
  done: '已問',
};

export const ALLERGY_SEVERITIES: readonly AllergySeverity[] = ['mild', 'moderate', 'severe'];
export const NOTE_KINDS: readonly NoteKind[] = ['note', 'question'];
export const NOTE_FILTERS: readonly NoteFilter[] = ['all', 'note', 'open', 'done'];

export const LIMIT_MESSAGE = {
  allergies: `過敏史已達上限（${PERSONAL_LIMITS.allergies} 筆）`,
  conditions: `病史已達上限（${PERSONAL_LIMITS.conditions} 筆）`,
  notes: `筆記已達上限（${PERSONAL_LIMITS.notes} 筆）`,
} as const;

const MIN_YEAR = 1900;
const MIN_NOTE_DATE = '1900-01-01';

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateName(
  raw: string,
  emptyMessage: string,
  existing: ReadonlyArray<{ name: string }>,
): ValidationResult<string> {
  const name = raw.trim();
  if (!name) return fail(emptyMessage);
  if (name.length > PERSONAL_TEXT_LIMITS.name) {
    return fail(`名稱不可超過 ${PERSONAL_TEXT_LIMITS.name} 字`);
  }
  const key = name.toLowerCase();
  if (existing.some(item => item.name.trim().toLowerCase() === key)) {
    return fail('已有相同名稱的項目');
  }
  return { ok: true, value: name };
}

function validateSinceYear(raw: string, now: Date): ValidationResult<number | undefined> {
  const text = raw.trim();
  if (!text) return { ok: true, value: undefined };
  if (!/^\d{4}$/.test(text)) return fail('年份格式不正確');
  const year = Number(text);
  if (year < MIN_YEAR) return fail(`年份不能早於 ${MIN_YEAR}`);
  if (year > now.getFullYear()) return fail('年份不能晚於今年');
  return { ok: true, value: year };
}

export function validateAllergy(
  input: { name: string; reaction: string; severity: AllergySeverity | '' },
  existing: readonly Allergy[],
): ValidationResult<Omit<Allergy, 'id'>> {
  const name = validateName(input.name, '請輸入過敏原名稱', existing);
  if (!name.ok) return name;
  const reaction = input.reaction.trim();
  if (reaction.length > PERSONAL_TEXT_LIMITS.detail) {
    return fail(`反應描述不可超過 ${PERSONAL_TEXT_LIMITS.detail} 字`);
  }
  return {
    ok: true,
    value: {
      name: name.value,
      ...(reaction ? { reaction } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
    },
  };
}

export function validateCondition(
  input: { name: string; sinceYear: string },
  existing: readonly Condition[],
  now: Date,
): ValidationResult<Omit<Condition, 'id'>> {
  const name = validateName(input.name, '請輸入疾病名稱', existing);
  if (!name.ok) return name;
  const year = validateSinceYear(input.sinceYear, now);
  if (!year.ok) return year;
  return {
    ok: true,
    value: {
      name: name.value,
      ...(year.value !== undefined ? { sinceYear: year.value } : {}),
    },
  };
}

export function validateNote(input: {
  date: string;
  kind: NoteKind;
  text: string;
}): ValidationResult<Omit<PersonalNote, 'id'>> {
  const date = input.date.trim();
  if (!date) return fail('請選擇日期');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail('日期格式不正確');
  if (date < MIN_NOTE_DATE) return fail(`日期不能早於 ${MIN_NOTE_DATE}`);
  // 來回轉換相同才是真實日曆日（排除 2026-02-30 這類日期）
  if (formatLocalDate(parseLocalDate(date)) !== date) return fail('日期格式不正確');
  const text = input.text.trim();
  if (!text) return fail('請輸入內容');
  if (text.length > PERSONAL_TEXT_LIMITS.note) {
    return fail(`內容不可超過 ${PERSONAL_TEXT_LIMITS.note} 字`);
  }
  return { ok: true, value: { date, kind: input.kind, text } };
}

export function openQuestions(notes: readonly PersonalNote[]): PersonalNote[] {
  return notes
    .filter(note => note.kind === 'question' && !note.done)
    .sort((a, b) => compareText(a.date, b.date) || compareText(a.id, b.id));
}

export function sortNotesNewestFirst(notes: readonly PersonalNote[]): PersonalNote[] {
  return [...notes].sort((a, b) => compareText(b.date, a.date) || compareText(b.id, a.id));
}

export function filterNotes(notes: readonly PersonalNote[], filter: NoteFilter): PersonalNote[] {
  switch (filter) {
    case 'note':
      return notes.filter(note => note.kind === 'note');
    case 'open':
      return notes.filter(note => note.kind === 'question' && !note.done);
    case 'done':
      return notes.filter(note => note.kind === 'question' && note.done === true);
    case 'all':
      return [...notes];
  }
}

export function withQuestionDone(note: PersonalNote, done: boolean): PersonalNote {
  if (note.kind !== 'question') return note;
  const base: PersonalNote = { id: note.id, date: note.date, kind: note.kind, text: note.text };
  return done ? { ...base, done: true } : base;
}

export function parseAllergySeverity(value: string): AllergySeverity | '' {
  return ALLERGY_SEVERITIES.find(severity => severity === value) ?? '';
}

export function parseNoteKind(value: string): NoteKind {
  return NOTE_KINDS.find(kind => kind === value) ?? 'note';
}

export function parseNoteFilter(value: string): NoteFilter {
  return NOTE_FILTERS.find(filter => filter === value) ?? 'all';
}
