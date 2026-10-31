import { describe, expect, it } from 'vitest';
import type { Allergy, Condition, PersonalNote } from '../personalData';
import {
  ALLERGY_SEVERITY_LABEL,
  LIMIT_MESSAGE,
  NOTE_FILTER_LABEL,
  NOTE_KIND_LABEL,
  filterNotes,
  openQuestions,
  parseAllergySeverity,
  parseNoteFilter,
  parseNoteKind,
  sortNotesNewestFirst,
  validateAllergy,
  validateCondition,
  validateNote,
  withQuestionDone,
} from './healthProfile';
import type { NoteFilter } from './healthProfile';

type AllergyInput = Parameters<typeof validateAllergy>[0];
type ConditionInput = Parameters<typeof validateCondition>[0];
type NoteInput = Parameters<typeof validateNote>[0];

const NOW = new Date(2026, 9, 31, 12, 0, 0);

const allergyInput = (overrides: Partial<AllergyInput> = {}): AllergyInput => ({
  name: '花生',
  reaction: '',
  severity: '',
  ...overrides,
});

const conditionInput = (overrides: Partial<ConditionInput> = {}): ConditionInput => ({
  name: '高血壓',
  sinceYear: '',
  ...overrides,
});

const noteInput = (overrides: Partial<NoteInput> = {}): NoteInput => ({
  date: '2026-10-31',
  kind: 'note',
  text: '血壓偏高',
  ...overrides,
});

const EXISTING_ALLERGIES: Allergy[] = [
  { id: 'al-1', name: 'Penicillin', severity: 'severe' },
  { id: 'al-2', name: '蝦子' },
];

const EXISTING_CONDITIONS: Condition[] = [{ id: 'co-1', name: 'Type 2 Diabetes', sinceYear: 2015 }];

function makeNote(id: string, date: string, kind: PersonalNote['kind'], done?: true): PersonalNote {
  return { id, date, kind, text: `內容 ${id}`, ...(done ? { done } : {}) };
}

function expectNoEmptyValues(value: object) {
  for (const [key, field] of Object.entries(value)) {
    expect(field, key).not.toBeUndefined();
    expect(field, key).not.toBe('');
  }
}

describe('labels', () => {
  it('uses Traditional Chinese labels for every enum value', () => {
    expect(ALLERGY_SEVERITY_LABEL).toStrictEqual({ mild: '輕微', moderate: '中度', severe: '嚴重' });
    expect(NOTE_KIND_LABEL).toStrictEqual({ note: '筆記', question: '回診問題' });
    expect(NOTE_FILTER_LABEL).toStrictEqual({ all: '全部', note: '筆記', open: '待問', done: '已問' });
  });

  it('words the cap messages with the limits that personal data enforces', () => {
    expect(LIMIT_MESSAGE).toStrictEqual({
      allergies: '過敏史已達上限（200 筆）',
      conditions: '病史已達上限（200 筆）',
      notes: '筆記已達上限（2000 筆）',
    });
  });
});

describe('validateAllergy', () => {
  it('accepts a full entry and trims every field', () => {
    const result = validateAllergy(
      allergyInput({ name: '  花生  ', reaction: '  蕁麻疹、喉嚨緊  ', severity: 'severe' }),
      [],
    );
    expect(result).toStrictEqual({
      ok: true,
      value: { name: '花生', reaction: '蕁麻疹、喉嚨緊', severity: 'severe' },
    });
  });

  it('keeps only the name when the optional fields are blank', () => {
    expect(validateAllergy(allergyInput({ reaction: ' \n ' }), [])).toStrictEqual({
      ok: true,
      value: { name: '花生' },
    });
  });

  it.each(['mild', 'moderate', 'severe'] as const)('keeps the %s severity', severity => {
    expect(validateAllergy(allergyInput({ severity }), [])).toStrictEqual({
      ok: true,
      value: { name: '花生', severity },
    });
  });

  it.each<[string, Partial<AllergyInput>, string]>([
    ['an empty name', { name: '' }, '請輸入過敏原名稱'],
    ['a blank name', { name: ' \t ' }, '請輸入過敏原名稱'],
    ['a name over 120 characters', { name: 'a'.repeat(121) }, '名稱不可超過 120 字'],
    ['a reaction over 300 characters', { reaction: 'a'.repeat(301) }, '反應描述不可超過 300 字'],
    ['a duplicate name', { name: 'Penicillin' }, '已有相同名稱的項目'],
    ['a duplicate name in another case with padding', { name: '  pENICILLIN ' }, '已有相同名稱的項目'],
    ['a duplicate Chinese name with padding', { name: ' 蝦子 ' }, '已有相同名稱的項目'],
  ])('rejects %s', (_label, overrides, error) => {
    expect(validateAllergy(allergyInput(overrides), EXISTING_ALLERGIES)).toStrictEqual({ ok: false, error });
  });

  it('accepts a name of 120 and a reaction of 300 characters', () => {
    const name = 'a'.repeat(120);
    const reaction = 'b'.repeat(300);
    expect(validateAllergy(allergyInput({ name, reaction }), [])).toStrictEqual({
      ok: true,
      value: { name, reaction },
    });
  });

  it('measures the limits after trimming', () => {
    const name = 'a'.repeat(120);
    const reaction = 'b'.repeat(300);
    const result = validateAllergy(allergyInput({ name: ` ${name} `, reaction: ` ${reaction} ` }), []);
    expect(result).toStrictEqual({ ok: true, value: { name, reaction } });
  });

  it('reports the name problem before the reaction problem', () => {
    expect(validateAllergy(allergyInput({ name: '', reaction: 'a'.repeat(301) }), [])).toStrictEqual({
      ok: false,
      error: '請輸入過敏原名稱',
    });
  });

  it('never returns empty or undefined fields', () => {
    const inputs = [
      allergyInput(),
      allergyInput({ reaction: '   ', severity: 'mild' }),
      allergyInput({ reaction: '紅疹' }),
    ];
    for (const input of inputs) {
      const result = validateAllergy(input, []);
      if (!result.ok) throw new Error(result.error);
      expectNoEmptyValues(result.value);
    }
  });
});

describe('validateCondition', () => {
  it('accepts a name with a start year', () => {
    expect(validateCondition(conditionInput({ name: ' 高血壓 ', sinceYear: ' 2015 ' }), [], NOW)).toStrictEqual({
      ok: true,
      value: { name: '高血壓', sinceYear: 2015 },
    });
  });

  it('omits the start year when it is blank', () => {
    expect(validateCondition(conditionInput({ sinceYear: '   ' }), [], NOW)).toStrictEqual({
      ok: true,
      value: { name: '高血壓' },
    });
  });

  it.each<[string, Partial<ConditionInput>, string]>([
    ['an empty name', { name: '' }, '請輸入疾病名稱'],
    ['a blank name', { name: '   ' }, '請輸入疾病名稱'],
    ['a name over 120 characters', { name: 'a'.repeat(121) }, '名稱不可超過 120 字'],
    ['a duplicate name', { name: 'Type 2 Diabetes' }, '已有相同名稱的項目'],
    ['a duplicate name in another case with padding', { name: ' type 2 DIABETES ' }, '已有相同名稱的項目'],
    ['letters as the year', { sinceYear: 'abcd' }, '年份格式不正確'],
    ['a two-digit year', { sinceYear: '20' }, '年份格式不正確'],
    ['a five-digit year', { sinceYear: '20101' }, '年份格式不正確'],
    ['a negative year', { sinceYear: '-201' }, '年份格式不正確'],
    ['a decimal year', { sinceYear: '2.10' }, '年份格式不正確'],
    ['full-width digits', { sinceYear: '２０１０' }, '年份格式不正確'],
    ['a year before 1900', { sinceYear: '1899' }, '年份不能早於 1900'],
    ['year zero', { sinceYear: '0000' }, '年份不能早於 1900'],
    ['next year', { sinceYear: '2027' }, '年份不能晚於今年'],
    ['a far future year', { sinceYear: '9999' }, '年份不能晚於今年'],
  ])('rejects %s', (_label, overrides, error) => {
    expect(validateCondition(conditionInput(overrides), EXISTING_CONDITIONS, NOW)).toStrictEqual({
      ok: false,
      error,
    });
  });

  it.each(['1900', '1901', '2025', '2026'])('accepts the year %s', sinceYear => {
    expect(validateCondition(conditionInput({ sinceYear }), [], NOW)).toStrictEqual({
      ok: true,
      value: { name: '高血壓', sinceYear: Number(sinceYear) },
    });
  });

  it('judges "this year" by the injected clock', () => {
    const input = conditionInput({ sinceYear: '2030' });
    expect(validateCondition(input, [], new Date(2030, 0, 1))).toStrictEqual({
      ok: true,
      value: { name: '高血壓', sinceYear: 2030 },
    });
    expect(validateCondition(input, [], new Date(2029, 11, 31, 23, 59))).toStrictEqual({
      ok: false,
      error: '年份不能晚於今年',
    });
  });

  it('accepts a name of exactly 120 characters', () => {
    const name = 'a'.repeat(120);
    expect(validateCondition(conditionInput({ name }), [], NOW)).toStrictEqual({ ok: true, value: { name } });
  });

  it('reports the name problem before the year problem', () => {
    expect(validateCondition(conditionInput({ name: '', sinceYear: 'abcd' }), [], NOW)).toStrictEqual({
      ok: false,
      error: '請輸入疾病名稱',
    });
  });

  it('never returns empty or undefined fields', () => {
    for (const sinceYear of ['', '  ', '2020']) {
      const result = validateCondition(conditionInput({ sinceYear }), [], NOW);
      if (!result.ok) throw new Error(result.error);
      expectNoEmptyValues(result.value);
    }
  });
});

describe('validateNote', () => {
  it('accepts a note and trims the text but keeps inner line breaks', () => {
    expect(validateNote(noteInput({ text: '  血壓偏高\n需追蹤  ' }))).toStrictEqual({
      ok: true,
      value: { date: '2026-10-31', kind: 'note', text: '血壓偏高\n需追蹤' },
    });
  });

  it('accepts a question without a done flag', () => {
    expect(validateNote(noteInput({ kind: 'question', text: '要不要調整藥量？' }))).toStrictEqual({
      ok: true,
      value: { date: '2026-10-31', kind: 'question', text: '要不要調整藥量？' },
    });
  });

  it.each<[string, string, string]>([
    ['an empty date', '', '請選擇日期'],
    ['a blank date', '   ', '請選擇日期'],
    ['slashes', '2026/10/31', '日期格式不正確'],
    ['unpadded parts', '2026-1-5', '日期格式不正確'],
    ['plain text', 'tomorrow', '日期格式不正確'],
    ['a two-digit year', '26-10-31', '日期格式不正確'],
    ['a trailing time', '2026-10-31T00:00', '日期格式不正確'],
    ['February 30', '2026-02-30', '日期格式不正確'],
    ['month 13', '2026-13-01', '日期格式不正確'],
    ['day 00', '2026-10-00', '日期格式不正確'],
    ['April 31', '2026-04-31', '日期格式不正確'],
    ['February 29 in a common year', '2025-02-29', '日期格式不正確'],
    ['February 29 in a century year that is not a leap year', '1900-02-29', '日期格式不正確'],
    ['a day before 1900', '1899-12-31', '日期不能早於 1900-01-01'],
    ['year 0001', '0001-01-01', '日期不能早於 1900-01-01'],
  ])('rejects %s', (_label, date, error) => {
    expect(validateNote(noteInput({ date }))).toStrictEqual({ ok: false, error });
  });

  it.each(['1900-01-01', '2000-02-29', '2024-02-29', '2026-10-31', '2026-11-15', '2027-03-01', '9999-12-31'])(
    'accepts the date %s, including dates in the future',
    date => {
      expect(validateNote(noteInput({ date }))).toStrictEqual({
        ok: true,
        value: { date, kind: 'note', text: '血壓偏高' },
      });
    },
  );

  it.each(['', ' \n\t '])('rejects empty content %j', text => {
    expect(validateNote(noteInput({ text }))).toStrictEqual({ ok: false, error: '請輸入內容' });
  });

  it('accepts 2000 characters and rejects 2001', () => {
    const limit = 'a'.repeat(2000);
    expect(validateNote(noteInput({ text: limit }))).toStrictEqual({
      ok: true,
      value: { date: '2026-10-31', kind: 'note', text: limit },
    });
    expect(validateNote(noteInput({ text: `${limit}a` }))).toStrictEqual({
      ok: false,
      error: '內容不可超過 2000 字',
    });
  });

  it('measures the content limit after trimming', () => {
    const limit = 'a'.repeat(2000);
    expect(validateNote(noteInput({ text: `  ${limit}\n` })).ok).toBe(true);
  });

  it('reports the date problem before the content problem', () => {
    expect(validateNote(noteInput({ date: '', text: '' }))).toStrictEqual({ ok: false, error: '請選擇日期' });
  });

  it('never returns empty or undefined fields', () => {
    for (const kind of ['note', 'question'] as const) {
      const result = validateNote(noteInput({ kind }));
      if (!result.ok) throw new Error(result.error);
      expectNoEmptyValues(result.value);
      expect('done' in result.value).toBe(false);
    }
  });
});

describe('openQuestions', () => {
  const notes: PersonalNote[] = [
    makeNote('n-1', '2026-10-01', 'note'),
    makeNote('q-3', '2026-10-20', 'question'),
    makeNote('q-2', '2026-10-05', 'question'),
    makeNote('q-1', '2026-10-05', 'question'),
    makeNote('q-4', '2026-10-06', 'question', true),
  ];

  it('keeps only questions that have not been asked yet', () => {
    const ids = openQuestions(notes).map(item => item.id);
    expect(ids).not.toContain('n-1');
    expect(ids).not.toContain('q-4');
    expect(ids).toHaveLength(3);
  });

  it('orders by date and then by id, oldest first', () => {
    expect(openQuestions(notes).map(item => item.id)).toStrictEqual(['q-1', 'q-2', 'q-3']);
  });

  it('does not reorder or modify the input', () => {
    const before = notes.map(item => item.id);
    openQuestions(notes);
    expect(notes.map(item => item.id)).toStrictEqual(before);
  });

  it('returns an empty list when nothing is open', () => {
    expect(openQuestions([])).toStrictEqual([]);
    expect(openQuestions([makeNote('n-1', '2026-10-01', 'note'), makeNote('q-1', '2026-10-02', 'question', true)])).toStrictEqual([]);
  });
});

describe('sortNotesNewestFirst', () => {
  const notes: PersonalNote[] = [
    makeNote('q-1', '2026-10-05', 'question'),
    makeNote('n-1', '2026-10-01', 'note'),
    makeNote('q-3', '2026-10-20', 'question'),
    makeNote('q-2', '2026-10-05', 'question'),
  ];

  it('orders by date descending and breaks ties by id descending', () => {
    expect(sortNotesNewestFirst(notes).map(item => item.id)).toStrictEqual(['q-3', 'q-2', 'q-1', 'n-1']);
  });

  it('returns a copy and leaves the input order alone', () => {
    const sorted = sortNotesNewestFirst(notes);
    expect(sorted).not.toBe(notes);
    expect(notes.map(item => item.id)).toStrictEqual(['q-1', 'n-1', 'q-3', 'q-2']);
  });
});

describe('filterNotes', () => {
  const notes: PersonalNote[] = [
    makeNote('n-1', '2026-10-01', 'note'),
    makeNote('q-open', '2026-10-02', 'question'),
    makeNote('q-done', '2026-10-03', 'question', true),
  ];

  it.each<[NoteFilter, string[]]>([
    ['all', ['n-1', 'q-open', 'q-done']],
    ['note', ['n-1']],
    ['open', ['q-open']],
    ['done', ['q-done']],
  ])('filters by %s', (filter, ids) => {
    expect(filterNotes(notes, filter).map(item => item.id)).toStrictEqual(ids);
  });

  it('returns a new array even when nothing is filtered out', () => {
    expect(filterNotes(notes, 'all')).not.toBe(notes);
  });
});

describe('withQuestionDone', () => {
  it('marks a question as done', () => {
    const question = makeNote('q-1', '2026-10-05', 'question');
    expect(withQuestionDone(question, true)).toStrictEqual({ ...question, done: true });
    expect('done' in question).toBe(false);
  });

  it('removes the done key instead of storing false', () => {
    const reopened = withQuestionDone(makeNote('q-1', '2026-10-05', 'question', true), false);
    expect('done' in reopened).toBe(false);
    expect(Object.keys(reopened)).toStrictEqual(['id', 'date', 'kind', 'text']);
  });

  it('leaves plain notes untouched', () => {
    const plain = makeNote('n-1', '2026-10-05', 'note');
    expect(withQuestionDone(plain, true)).toBe(plain);
  });
});

describe('select value parsers', () => {
  it.each([
    ['mild', 'mild'],
    ['moderate', 'moderate'],
    ['severe', 'severe'],
    ['', ''],
    ['unknown', ''],
  ])('reads allergy severity %j as %j', (value, expected) => {
    expect(parseAllergySeverity(value)).toBe(expected);
  });

  it.each([
    ['note', 'note'],
    ['question', 'question'],
    ['unknown', 'note'],
  ])('reads note kind %j as %j', (value, expected) => {
    expect(parseNoteKind(value)).toBe(expected);
  });

  it.each([
    ['all', 'all'],
    ['note', 'note'],
    ['open', 'open'],
    ['done', 'done'],
    ['unknown', 'all'],
  ])('reads note filter %j as %j', (value, expected) => {
    expect(parseNoteFilter(value)).toBe(expected);
  });
});
