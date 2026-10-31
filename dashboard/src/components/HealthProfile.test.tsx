import { useState } from 'react';
import type { ReactNode } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PersonalContext } from '../personalContext';
import type { PersonalContextValue } from '../personalContext';
import { emptyPersonal } from '../personalData';
import type { Allergy, Condition, PersonalData, PersonalNote } from '../personalData';
import HealthProfile from './HealthProfile';

afterEach(cleanup);

const NOW = new Date(2026, 9, 31, 12, 0, 0);

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface HarnessProps {
  initial?: PersonalData;
  canEdit?: boolean;
  saving?: boolean;
  fail?: boolean;
  onUpdate?: (next: PersonalData) => void;
  children: ReactNode;
}

function Harness({ initial, canEdit = true, saving = false, fail = false, onUpdate, children }: HarnessProps) {
  const [personal, setPersonal] = useState<PersonalData>(() => initial ?? emptyPersonal());
  const value: PersonalContextValue = {
    personal,
    canEdit,
    saving,
    error: null,
    clearError: () => {},
    update: async mutator => {
      const next = mutator(personal);
      onUpdate?.(next);
      if (fail) return false;
      setPersonal(next);
      return true;
    },
  };
  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}

function renderProfile(options: { initial?: PersonalData; canEdit?: boolean; saving?: boolean; fail?: boolean } = {}) {
  const updates: PersonalData[] = [];
  render(
    <Harness {...options} onUpdate={next => updates.push(next)}>
      <HealthProfile now={NOW} />
    </Harness>,
  );
  return updates;
}

function renderWithServerData(rendered: PersonalData, server: PersonalData) {
  const results: PersonalData[] = [];
  const value: PersonalContextValue = {
    personal: rendered,
    canEdit: true,
    saving: false,
    error: null,
    clearError: () => {},
    update: async mutator => {
      results.push(mutator(server));
      return true;
    },
  };
  render(
    <PersonalContext.Provider value={value}>
      <HealthProfile now={NOW} />
    </PersonalContext.Provider>,
  );
  return results;
}

function withData(data: { allergies?: Allergy[]; conditions?: Condition[]; notes?: PersonalNote[] }): PersonalData {
  return {
    ...emptyPersonal(),
    profile: { allergies: data.allergies ?? [], conditions: data.conditions ?? [] },
    notes: data.notes ?? [],
  };
}

const PEANUT: Allergy = { id: 'al-1', name: '花生', reaction: '蕁麻疹', severity: 'severe' };
const PENICILLIN: Allergy = { id: 'al-2', name: 'Penicillin' };
const HYPERTENSION: Condition = { id: 'co-1', name: '高血壓', sinceYear: 2015 };
const APPENDECTOMY: Condition = { id: 'co-2', name: '闌尾切除' };
const WALK: PersonalNote = { id: 'n-1', date: '2026-10-01', kind: 'note', text: '飯後散步三十分鐘' };
const ASK_DOSE: PersonalNote = { id: 'n-2', date: '2026-10-20', kind: 'question', text: '詢問用藥時間' };
const ASK_TARGET: PersonalNote = { id: 'n-3', date: '2026-10-20', kind: 'question', text: '詢問血壓目標', done: true };
const NEXT_VISIT: PersonalNote = { id: 'n-4', date: '2026-11-15', kind: 'note', text: '預約下次回診' };
const FULL = withData({
  allergies: [PEANUT, PENICILLIN],
  conditions: [HYPERTENSION, APPENDECTOMY],
  notes: [WALK, ASK_DOSE, ASK_TARGET, NEXT_VISIT],
});

const allergySection = () => screen.getByRole('region', { name: '過敏史' });
const conditionSection = () => screen.getByRole('region', { name: '慢性病／既往病史' });
const noteSection = () => screen.getByRole('region', { name: '筆記與回診問題' });

function control(scope: HTMLElement, label: string | RegExp): Control {
  return within(scope).getByLabelText(label) as Control;
}

function formControls(): Control[] {
  return [
    control(allergySection(), /過敏原名稱/),
    control(allergySection(), /反應描述/),
    control(allergySection(), /嚴重度/),
    control(conditionSection(), /疾病名稱/),
    control(conditionSection(), /起病年份/),
    control(noteSection(), /日期/),
    control(noteSection(), /類型/),
    control(noteSection(), /內容/),
  ];
}

function rows(section: HTMLElement): HTMLElement[] {
  return within(section).queryAllByRole('listitem');
}

function enter(element: HTMLElement, value: string) {
  fireEvent.change(element, { target: { value } });
}

async function press(element: Element) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

describe('HealthProfile', () => {
  describe('basics', () => {
    it('is read-only without a provider and shows the read-only hint once', () => {
      render(<HealthProfile now={NOW} />);
      expect(formControls().every(element => element.disabled)).toBe(true);
      const submits = [
        within(allergySection()).getByRole('button', { name: '新增過敏史' }),
        within(conditionSection()).getByRole('button', { name: '新增病史' }),
        within(noteSection()).getByRole('button', { name: '新增筆記' }),
      ] as HTMLButtonElement[];
      expect(submits.every(button => button.disabled)).toBe(true);
      expect(screen.getAllByText(/目前為唯讀狀態/)).toHaveLength(1);
      expect(screen.getByText(/不構成診斷或醫療建議/)).toBeTruthy();
    });

    it('shows an empty state in every section and enables the forms when editing is allowed', () => {
      renderProfile();
      expect(within(allergySection()).getByText('尚未記錄過敏史。')).toBeTruthy();
      expect(within(conditionSection()).getByText('尚未記錄慢性病或既往病史。')).toBeTruthy();
      expect(within(noteSection()).getByText('尚未新增筆記或回診問題。')).toBeTruthy();
      expect(screen.queryAllByRole('list')).toHaveLength(0);
      expect(formControls().some(element => element.disabled)).toBe(false);
      expect(screen.queryByText(/目前為唯讀狀態/)).toBeNull();
      expect(screen.queryByText(/已達上限/)).toBeNull();
    });

    it('lists existing entries with severity, start year and question state', () => {
      renderProfile({ initial: FULL });

      const allergyRows = rows(allergySection());
      expect(allergyRows).toHaveLength(2);
      expect(allergyRows[0].textContent).toContain('花生');
      expect(allergyRows[0].textContent).toContain('蕁麻疹');
      const badge = within(allergyRows[0]).getByText('嚴重');
      expect(badge.className).toContain('badge');
      expect(badge.className).toContain('dark:');
      expect(within(allergyRows[1]).queryByText(/輕微|中度|嚴重/)).toBeNull();

      const conditionRows = rows(conditionSection());
      expect(conditionRows).toHaveLength(2);
      expect(within(conditionRows[0]).getByText('自 2015 年')).toBeTruthy();
      expect(conditionRows[1].textContent).not.toContain('自');

      expect(rows(noteSection())).toHaveLength(4);
      expect(within(noteSection()).getAllByRole('checkbox', { name: '已詢問' })).toHaveLength(2);
    });

    it('preserves line breaks in notes', () => {
      const text = '第一行\n第二行';
      renderProfile({ initial: withData({ notes: [{ id: 'n-9', date: '2026-10-01', kind: 'note', text }] }) });
      const paragraph = within(noteSection()).getByRole('listitem').querySelector('p');
      expect(paragraph?.textContent).toBe(text);
      expect(paragraph?.className).toContain('whitespace-pre-wrap');
      expect(paragraph?.className).toContain('break-words');
    });

    it('hides forms, the filter toolbar and delete controls when printing', () => {
      renderProfile({ initial: FULL });
      for (const label of ['新增過敏史', '新增病史', '新增筆記或回診問題']) {
        expect(screen.getByLabelText(label).className).toContain('print:hidden');
      }
      expect(screen.getByLabelText('筆記篩選').parentElement?.className).toContain('print:hidden');
      const deletes = screen.getAllByRole('button', { name: /^刪除/ });
      expect(deletes).toHaveLength(8);
      expect(deletes.every(button => button.className.includes('print:hidden'))).toBe(true);
    });
  });

  describe('allergies', () => {
    it('adds an allergy and resets the form', async () => {
      const updates = renderProfile();
      const section = allergySection();
      enter(control(section, /過敏原名稱/), '  花生  ');
      enter(control(section, /反應描述/), '蕁麻疹');
      enter(control(section, /嚴重度/), 'severe');
      await press(within(section).getByRole('button', { name: '新增過敏史' }));

      expect(updates).toHaveLength(1);
      const saved = updates[0].profile.allergies;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ name: '花生', reaction: '蕁麻疹', severity: 'severe' });
      expect(saved[0].id).toMatch(/^[\w-]{1,64}$/);

      const row = within(section).getByRole('listitem');
      expect(row.textContent).toContain('花生');
      expect(within(row).getByText('嚴重')).toBeTruthy();
      expect(control(section, /過敏原名稱/).value).toBe('');
      expect(control(section, /反應描述/).value).toBe('');
      expect(control(section, /嚴重度/).value).toBe('');
      expect(within(section).queryByRole('alert')).toBeNull();
    });

    it('omits blank optional fields from the saved allergy', async () => {
      const updates = renderProfile();
      const section = allergySection();
      enter(control(section, /過敏原名稱/), '花生');
      await press(within(section).getByRole('button', { name: '新增過敏史' }));
      expect(Object.keys(updates[0].profile.allergies[0]).sort()).toEqual(['id', 'name']);
    });

    it.each([
      { title: 'a blank name', name: '   ', reaction: '', message: '請輸入過敏原名稱' },
      { title: 'a name over 120 characters', name: 'x'.repeat(121), reaction: '', message: '名稱不可超過 120 字' },
      { title: 'a reaction over 300 characters', name: '花生', reaction: 'x'.repeat(301), message: '反應描述不可超過 300 字' },
    ])('rejects $title without saving', async ({ name, reaction, message }) => {
      const updates = renderProfile();
      const section = allergySection();
      enter(control(section, /過敏原名稱/), name);
      enter(control(section, /反應描述/), reaction);
      await press(within(section).getByRole('button', { name: '新增過敏史' }));

      expect(within(section).getByRole('alert').textContent).toBe(message);
      expect(updates).toHaveLength(0);
      expect(rows(section)).toHaveLength(0);

      enter(control(section, /過敏原名稱/), '塵蟎');
      expect(within(section).queryByRole('alert')).toBeNull();
    });

    it('rejects a duplicate allergy name regardless of case and surrounding spaces', async () => {
      const updates = renderProfile({ initial: FULL });
      const section = allergySection();
      enter(control(section, /過敏原名稱/), '  penicillin ');
      await press(within(section).getByRole('button', { name: '新增過敏史' }));

      expect(within(section).getByRole('alert').textContent).toBe('已有相同名稱的項目');
      expect(updates).toHaveLength(0);
      expect(control(section, /過敏原名稱/).value).toBe('  penicillin ');
      expect(rows(section)).toHaveLength(2);
    });
  });

  describe('conditions', () => {
    it('adds a condition with a start year and resets the form', async () => {
      const updates = renderProfile();
      const section = conditionSection();
      expect(control(section, /起病年份/).getAttribute('inputmode')).toBe('numeric');
      enter(control(section, /疾病名稱/), ' 高血壓 ');
      enter(control(section, /起病年份/), '2015');
      await press(within(section).getByRole('button', { name: '新增病史' }));

      expect(updates).toHaveLength(1);
      expect(updates[0].profile.conditions[0]).toMatchObject({ name: '高血壓', sinceYear: 2015 });
      expect(within(within(section).getByRole('listitem')).getByText('自 2015 年')).toBeTruthy();
      expect(control(section, /疾病名稱/).value).toBe('');
      expect(control(section, /起病年份/).value).toBe('');
    });

    it('accepts the current year and omits a blank year', async () => {
      const updates = renderProfile();
      const section = conditionSection();
      enter(control(section, /疾病名稱/), '氣喘');
      enter(control(section, /起病年份/), '2026');
      await press(within(section).getByRole('button', { name: '新增病史' }));
      enter(control(section, /疾病名稱/), '濕疹');
      await press(within(section).getByRole('button', { name: '新增病史' }));

      expect(updates).toHaveLength(2);
      expect(updates[0].profile.conditions[0].sinceYear).toBe(2026);
      expect(Object.keys(updates[1].profile.conditions[1]).sort()).toEqual(['id', 'name']);
    });

    it.each([
      { title: 'a blank name', name: '', year: '', message: '請輸入疾病名稱' },
      { title: 'a malformed year', name: '高血壓', year: '20x5', message: '年份格式不正確' },
      { title: 'a year before 1900', name: '高血壓', year: '1899', message: '年份不能早於 1900' },
      { title: 'a year after the current one', name: '高血壓', year: '2027', message: '年份不能晚於今年' },
    ])('rejects $title without saving', async ({ name, year, message }) => {
      const updates = renderProfile();
      const section = conditionSection();
      enter(control(section, /疾病名稱/), name);
      enter(control(section, /起病年份/), year);
      await press(within(section).getByRole('button', { name: '新增病史' }));

      expect(within(section).getByRole('alert').textContent).toBe(message);
      expect(updates).toHaveLength(0);
      expect(rows(section)).toHaveLength(0);
    });

    it('rejects a duplicate condition name', async () => {
      const updates = renderProfile({ initial: FULL });
      const section = conditionSection();
      enter(control(section, /疾病名稱/), ' 高血壓 ');
      await press(within(section).getByRole('button', { name: '新增病史' }));

      expect(within(section).getByRole('alert').textContent).toBe('已有相同名稱的項目');
      expect(updates).toHaveLength(0);
    });
  });

  describe('notes', () => {
    it('adds a future-dated question, keeps the date and type, and clears the text', async () => {
      const updates = renderProfile();
      const section = noteSection();
      const text = '下次回診要問血糖目標';

      const date = control(section, /日期/);
      expect(date.value).toBe('2026-10-31');
      expect(date.getAttribute('max')).toBeNull();
      expect(within(section).getByText('0/2000')).toBeTruthy();

      enter(date, '2026-12-01');
      enter(control(section, /類型/), 'question');
      enter(control(section, /內容/), `  ${text}  `);
      expect(within(section).getByText(`${text.length}/2000`)).toBeTruthy();
      await press(within(section).getByRole('button', { name: '新增回診問題' }));

      expect(updates).toHaveLength(1);
      const saved = updates[0].notes[0];
      expect(saved).toMatchObject({ date: '2026-12-01', kind: 'question', text });
      expect('done' in saved).toBe(false);

      const row = within(section).getByRole('listitem');
      expect(row.textContent).toContain('2026-12-01');
      expect(within(row).getByText('回診問題')).toBeTruthy();
      expect(within(row).getByText('待問')).toBeTruthy();
      expect(row.textContent).toContain(text);

      expect(control(section, /內容/).value).toBe('');
      expect(control(section, /日期/).value).toBe('2026-12-01');
      expect(control(section, /類型/).value).toBe('question');
      expect(within(section).getByText('0/2000')).toBeTruthy();
      expect(within(section).getByRole('status').textContent).toBe('待問 1 題');
    });

    it('shows validation errors for notes without saving', async () => {
      const updates = renderProfile();
      const section = noteSection();
      const submit = () => within(section).getByRole('button', { name: '新增筆記' });

      await press(submit());
      expect(within(section).getByRole('alert').textContent).toBe('請輸入內容');

      enter(control(section, /內容/), '有文字');
      expect(within(section).queryByRole('alert')).toBeNull();
      enter(control(section, /日期/), '');
      await press(submit());
      expect(within(section).getByRole('alert').textContent).toBe('請選擇日期');

      enter(control(section, /日期/), '2026-10-31');
      enter(control(section, /內容/), 'x'.repeat(2001));
      expect(within(section).getByText('2001/2000').className).toContain('text-red-600');
      await press(submit());
      expect(within(section).getByRole('alert').textContent).toBe('內容不可超過 2000 字');

      expect(updates).toHaveLength(0);
      expect(rows(section)).toHaveLength(0);
    });

    it('keeps entered values and existing rows when saving fails', async () => {
      const updates = renderProfile({ initial: FULL, fail: true });

      const allergies = allergySection();
      enter(control(allergies, /過敏原名稱/), '塵蟎');
      enter(control(allergies, /反應描述/), '打噴嚏');
      await press(within(allergies).getByRole('button', { name: '新增過敏史' }));
      expect(control(allergies, /過敏原名稱/).value).toBe('塵蟎');
      expect(control(allergies, /反應描述/).value).toBe('打噴嚏');
      expect(rows(allergies)).toHaveLength(2);

      const conditions = conditionSection();
      enter(control(conditions, /疾病名稱/), '氣喘');
      enter(control(conditions, /起病年份/), '2010');
      await press(within(conditions).getByRole('button', { name: '新增病史' }));
      expect(control(conditions, /疾病名稱/).value).toBe('氣喘');
      expect(control(conditions, /起病年份/).value).toBe('2010');
      expect(rows(conditions)).toHaveLength(2);

      const notes = noteSection();
      enter(control(notes, /內容/), '尚未存檔的文字');
      await press(within(notes).getByRole('button', { name: '新增筆記' }));
      expect(control(notes, /內容/).value).toBe('尚未存檔的文字');
      expect(rows(notes)).toHaveLength(4);

      await press(within(notes).getByRole('button', { name: '刪除筆記：飯後散步三十分鐘' }));
      await press(within(notes).getByRole('button', { name: '確認刪除筆記：飯後散步三十分鐘' }));
      expect(rows(notes)).toHaveLength(4);
      expect(within(notes).getByRole('button', { name: '刪除筆記：飯後散步三十分鐘' })).toBeTruthy();

      expect(updates).toHaveLength(4);
    });

    it('counts open questions as they are added and checked', async () => {
      renderProfile({ initial: withData({ notes: [WALK] }) });
      const section = noteSection();
      const status = () => within(section).getByRole('status').textContent;
      expect(status()).toBe('待問 0 題');

      enter(control(section, /類型/), 'question');
      enter(control(section, /內容/), '想問的第一題');
      await press(within(section).getByRole('button', { name: '新增回診問題' }));
      expect(status()).toBe('待問 1 題');

      enter(control(section, /內容/), '想問的第二題');
      await press(within(section).getByRole('button', { name: '新增回診問題' }));
      expect(status()).toBe('待問 2 題');

      await press(within(section).getAllByRole('checkbox', { name: '已詢問' })[0]);
      expect(status()).toBe('待問 1 題');
    });

    it('marks a question as asked and drops the done key when unchecked', async () => {
      const question: PersonalNote = { id: 'q-1', date: '2026-10-20', kind: 'question', text: '詢問用藥時間' };
      const updates = renderProfile({ initial: withData({ notes: [question] }) });
      const section = noteSection();
      const checkbox = within(section).getByRole('checkbox', { name: '已詢問' }) as HTMLInputElement;
      const status = () => within(section).getByRole('status').textContent;
      expect(checkbox.checked).toBe(false);
      expect(status()).toBe('待問 1 題');

      await press(checkbox);
      expect(updates[0].notes[0].done).toBe(true);
      expect(checkbox.checked).toBe(true);
      expect(status()).toBe('待問 0 題');
      expect(within(within(section).getByRole('listitem')).getByText('已問')).toBeTruthy();

      await press(checkbox);
      const unchecked = updates[1].notes[0];
      expect('done' in unchecked).toBe(false);
      expect(unchecked).toStrictEqual(question);
      expect(checkbox.checked).toBe(false);
      expect(status()).toBe('待問 1 題');
      expect(within(within(section).getByRole('listitem')).getByText('待問')).toBeTruthy();
    });

    it('offers the question checkbox only on questions', () => {
      renderProfile({ initial: withData({ notes: [WALK] }) });
      expect(within(noteSection()).queryAllByRole('checkbox')).toHaveLength(0);
    });

    it.each([
      { filter: 'all', expected: ['預約下次回診', '詢問血壓目標', '詢問用藥時間', '飯後散步三十分鐘'] },
      { filter: 'note', expected: ['預約下次回診', '飯後散步三十分鐘'] },
      { filter: 'open', expected: ['詢問用藥時間'] },
      { filter: 'done', expected: ['詢問血壓目標'] },
    ])('filters notes by "$filter" and lists them newest first', ({ filter, expected }) => {
      renderProfile({ initial: FULL });
      const section = noteSection();
      enter(control(section, '筆記篩選'), filter);

      const items = rows(section);
      expect(items).toHaveLength(expected.length);
      for (const [index, text] of expected.entries()) {
        expect(items[index].textContent).toContain(text);
      }
    });

    it('explains when no note matches the filter', () => {
      renderProfile({ initial: withData({ notes: [WALK] }) });
      const section = noteSection();
      enter(control(section, '筆記篩選'), 'open');
      expect(within(section).getByText('沒有符合篩選條件的項目。')).toBeTruthy();
      expect(rows(section)).toHaveLength(0);
    });

    it('switches the filter back to all only when the new note would be hidden', async () => {
      renderProfile({ initial: withData({ notes: [ASK_DOSE] }) });
      const section = noteSection();
      const filter = control(section, '筆記篩選');

      enter(filter, 'open');
      enter(control(section, /內容/), '新的心得');
      await press(within(section).getByRole('button', { name: '新增筆記' }));
      expect(filter.value).toBe('all');
      expect(rows(section)).toHaveLength(2);
      expect(within(section).getByText('新的心得')).toBeTruthy();

      enter(filter, 'open');
      enter(control(section, /類型/), 'question');
      enter(control(section, /內容/), '新的問題');
      await press(within(section).getByRole('button', { name: '新增回診問題' }));
      expect(filter.value).toBe('open');
      expect(rows(section)).toHaveLength(2);
    });
  });

  describe('deleting', () => {
    interface DeleteCase {
      title: string;
      section: () => HTMLElement;
      text: string;
      label: string;
      remaining: (data: PersonalData) => number;
    }

    const DELETE_CASES: DeleteCase[] = [
      {
        title: 'an allergy',
        section: allergySection,
        text: '花生',
        label: '過敏原：花生',
        remaining: data => data.profile.allergies.length,
      },
      {
        title: 'a condition',
        section: conditionSection,
        text: '高血壓',
        label: '病史：高血壓',
        remaining: data => data.profile.conditions.length,
      },
      {
        title: 'a note',
        section: noteSection,
        text: '飯後散步三十分鐘',
        label: '筆記：飯後散步三十分鐘',
        remaining: data => data.notes.length,
      },
    ];

    it.each(DELETE_CASES)('deletes $title only after a second confirmation', async ({ section, text, label, remaining }) => {
      const updates = renderProfile({ initial: FULL });
      const region = section();

      await press(within(region).getByRole('button', { name: `刪除${label}` }));
      expect(within(region).getByText('確定刪除？')).toBeTruthy();
      const cancel = within(region).getByRole('button', { name: `取消刪除${label}` });
      expect(document.activeElement).toBe(cancel);

      await press(cancel);
      expect(within(region).queryByText('確定刪除？')).toBeNull();
      expect(within(region).getByText(text)).toBeTruthy();
      expect(updates).toHaveLength(0);

      await press(within(region).getByRole('button', { name: `刪除${label}` }));
      await press(within(region).getByRole('button', { name: `確認刪除${label}` }));
      expect(updates).toHaveLength(1);
      expect(remaining(updates[0])).toBe(remaining(FULL) - 1);
      expect(within(region).queryByText(text)).toBeNull();
    });

    it('labels delete buttons with a shortened note excerpt', () => {
      const text = '這是一段超過二十個字的長筆記內容需要被截短後放進按鈕名稱';
      renderProfile({ initial: withData({ notes: [{ id: 'n-long', date: '2026-10-01', kind: 'note', text }] }) });
      const excerpt = `${Array.from(text).slice(0, 20).join('')}…`;
      expect(within(noteSection()).getByRole('button', { name: `刪除筆記：${excerpt}` })).toBeTruthy();
    });
  });

  describe('limits', () => {
    interface CapCase {
      title: string;
      initial: () => PersonalData;
      form: string;
      message: string;
      fill: (form: HTMLElement) => void;
    }

    const CAP_CASES: CapCase[] = [
      {
        title: 'allergies',
        initial: () =>
          withData({
            allergies: Array.from({ length: 200 }, (_, index): Allergy => ({ id: `al-${index}`, name: `項目${index}` })),
          }),
        form: '新增過敏史',
        message: '過敏史已達上限（200 筆）',
        fill: form => enter(control(form, /過敏原名稱/), '新的過敏原'),
      },
      {
        title: 'conditions',
        initial: () =>
          withData({
            conditions: Array.from({ length: 200 }, (_, index): Condition => ({ id: `co-${index}`, name: `項目${index}` })),
          }),
        form: '新增病史',
        message: '病史已達上限（200 筆）',
        fill: form => enter(control(form, /疾病名稱/), '新的疾病'),
      },
      {
        title: 'notes',
        initial: () =>
          withData({
            notes: Array.from(
              { length: 2000 },
              (_, index): PersonalNote => ({ id: `n-${index}`, date: '2026-01-01', kind: 'note', text: `重點${index}` }),
            ),
          }),
        form: '新增筆記或回診問題',
        message: '筆記已達上限（2000 筆）',
        fill: form => enter(control(form, /內容/), '新的重點'),
      },
    ];

    it.each(CAP_CASES)('blocks adding more $title once the limit is reached', ({ initial, form: formLabel, message, fill }) => {
      const updates = renderProfile({ initial: initial() });
      const form = screen.getByLabelText(formLabel);

      expect(screen.getByText(message)).toBeTruthy();
      expect((within(form).getByRole('button') as HTMLButtonElement).disabled).toBe(true);

      fill(form);
      fireEvent.submit(form);
      expect(updates).toHaveLength(0);
    });
  });

  describe('permissions and data flow', () => {
    it.each([
      { title: 'the vault is locked', options: { canEdit: false } },
      { title: 'a save is in progress', options: { saving: true } },
    ])('disables every editing control while $title', ({ options }) => {
      renderProfile({ initial: FULL, ...options });

      expect(formControls().every(element => element.disabled)).toBe(true);

      const buttons = screen.getAllByRole('button') as HTMLButtonElement[];
      expect(buttons).toHaveLength(11);
      expect(buttons.every(button => button.disabled)).toBe(true);

      const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
      expect(checkboxes).toHaveLength(2);
      expect(checkboxes.every(checkbox => checkbox.disabled)).toBe(true);

      expect(control(noteSection(), '筆記篩選').disabled).toBe(false);
    });

    it('applies additions to the latest data instead of the rendered snapshot', async () => {
      const server = withData({
        allergies: [{ id: 'al-server', name: '塵蟎' }],
        conditions: [{ id: 'co-server', name: '氣喘' }],
        notes: [{ id: 'n-server', date: '2026-09-01', kind: 'note', text: '另一台裝置新增的筆記' }],
      });
      const results = renderWithServerData(emptyPersonal(), server);

      enter(control(allergySection(), /過敏原名稱/), '花生');
      await press(within(allergySection()).getByRole('button', { name: '新增過敏史' }));
      enter(control(conditionSection(), /疾病名稱/), '高血壓');
      await press(within(conditionSection()).getByRole('button', { name: '新增病史' }));
      enter(control(noteSection(), /內容/), '新的筆記');
      await press(within(noteSection()).getByRole('button', { name: '新增筆記' }));

      expect(results).toHaveLength(3);
      expect(results[0].profile.allergies.map(item => item.name)).toEqual(['塵蟎', '花生']);
      expect(results[1].profile.conditions.map(item => item.name)).toEqual(['氣喘', '高血壓']);
      expect(results[2].notes.map(item => item.text)).toEqual(['另一台裝置新增的筆記', '新的筆記']);
    });

    it('applies deletions and checkbox changes to the latest data', async () => {
      const extra: PersonalNote = { id: 'n-extra', date: '2026-09-01', kind: 'question', text: '另一台裝置新增的問題' };
      const server = withData({
        allergies: [PEANUT, { id: 'al-server', name: '塵蟎' }],
        notes: [ASK_DOSE, extra],
      });
      const results = renderWithServerData(withData({ allergies: [PEANUT], notes: [ASK_DOSE] }), server);

      await press(within(allergySection()).getByRole('button', { name: '刪除過敏原：花生' }));
      await press(within(allergySection()).getByRole('button', { name: '確認刪除過敏原：花生' }));
      await press(within(noteSection()).getByRole('checkbox', { name: '已詢問' }));

      expect(results).toHaveLength(2);
      expect(results[0].profile.allergies.map(item => item.id)).toEqual(['al-server']);
      expect(results[1].notes.map(note => note.id)).toEqual(['n-2', 'n-extra']);
      expect(results[1].notes.find(note => note.id === 'n-2')?.done).toBe(true);
      expect(results[1].notes.find(note => note.id === 'n-extra')?.done).toBeUndefined();
    });
  });
});
