import { useId, useMemo, useState } from 'react';
import PersonalNotice from './PersonalNotice';
import { formatLocalDate, useNow } from '../lib/clock';
import {
  ALLERGY_SEVERITIES,
  ALLERGY_SEVERITY_LABEL,
  LIMIT_MESSAGE,
  NOTE_FILTERS,
  NOTE_FILTER_LABEL,
  NOTE_KINDS,
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
} from '../lib/healthProfile';
import type { NoteFilter } from '../lib/healthProfile';
import { usePersonal } from '../personalContext';
import { PERSONAL_LIMITS, PERSONAL_TEXT_LIMITS, newPersonalId } from '../personalData';
import type { Allergy, AllergySeverity, Condition, NoteKind, PersonalNote } from '../personalData';

const MUTED_CLASS = 'text-sm text-gray-500 dark:text-gray-400';
const ERROR_CLASS = 'text-sm text-red-600 dark:text-red-400';
const LIMIT_CLASS = 'text-sm text-amber-700 dark:text-amber-400';
const LIST_CLASS = 'divide-y divide-gray-100 dark:divide-gray-700';

const SEVERITY_BADGE: Record<AllergySeverity, string> = {
  mild: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  moderate: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
  severe: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
};

const KIND_BADGE: Record<NoteKind, string> = {
  note: 'bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200',
  question: 'bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300',
};

const OPEN_BADGE = 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300';
const MUTED_BADGE = 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300';

function snippet(text: string): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length > 20 ? `${chars.slice(0, 20).join('')}…` : chars.join('');
}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="ml-0.5 text-red-600 dark:text-red-400">
      *
    </span>
  );
}

function EmptyState({ children }: { children: string }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-6 text-center">
      <p className={MUTED_CLASS}>{children}</p>
    </div>
  );
}

function DeleteControl({ label, disabled, onDelete }: { label: string; disabled: boolean; onDelete: () => void }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        type="button"
        className="btn-secondary print:hidden disabled:opacity-50 disabled:cursor-not-allowed"
        aria-label={`刪除${label}`}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        刪除
      </button>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-2 print:hidden">
      <span className="text-sm font-medium text-red-600 dark:text-red-400">確定刪除？</span>
      <button
        type="button"
        className="btn-danger"
        aria-label={`確認刪除${label}`}
        disabled={disabled}
        onClick={() => {
          setConfirming(false);
          onDelete();
        }}
      >
        確認
      </button>
      <button
        type="button"
        className="btn-secondary"
        aria-label={`取消刪除${label}`}
        autoFocus
        onClick={() => setConfirming(false)}
      >
        取消
      </button>
    </span>
  );
}

function AllergySection() {
  const { personal, canEdit, saving, update } = usePersonal();
  const uid = useId();
  const [name, setName] = useState('');
  const [reaction, setReaction] = useState('');
  const [severity, setSeverity] = useState<AllergySeverity | ''>('');
  const [error, setError] = useState<string | null>(null);

  const allergies = personal.profile.allergies;
  const disabled = !canEdit || saving;
  const atLimit = allergies.length >= PERSONAL_LIMITS.allergies;

  async function handleAdd() {
    if (disabled || atLimit) return;
    const result = validateAllergy({ name, reaction, severity }, allergies);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const entry: Allergy = { id: newPersonalId(), ...result.value };
    const ok = await update(current => ({
      ...current,
      profile: { ...current.profile, allergies: [...current.profile.allergies, entry] },
    }));
    if (ok) {
      setName('');
      setReaction('');
      setSeverity('');
      setError(null);
    }
  }

  function remove(id: string) {
    return update(current => ({
      ...current,
      profile: { ...current.profile, allergies: current.profile.allergies.filter(item => item.id !== id) },
    }));
  }

  return (
    <section className="card" aria-label="過敏史">
      <h2 className="section-title">過敏史</h2>
      <p className={`mt-1 mb-4 ${MUTED_CLASS}`}>記錄藥物、食物或其他過敏原，就診時可快速告知醫師。</p>
      <form
        aria-label="新增過敏史"
        noValidate
        className="mb-4 grid gap-3 sm:grid-cols-3 print:hidden"
        onSubmit={event => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <div>
          <label className="label" htmlFor={`${uid}-name`}>
            過敏原名稱
            <RequiredMark />
          </label>
          <input
            id={`${uid}-name`}
            type="text"
            className="input w-full"
            autoComplete="off"
            aria-required="true"
            placeholder="例如：花生、盤尼西林"
            value={name}
            disabled={disabled}
            onChange={event => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-reaction`}>
            反應描述（選填）
          </label>
          <input
            id={`${uid}-reaction`}
            type="text"
            className="input w-full"
            autoComplete="off"
            placeholder="例如：蕁麻疹、呼吸困難"
            value={reaction}
            disabled={disabled}
            onChange={event => {
              setReaction(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-severity`}>
            嚴重度（選填）
          </label>
          <select
            id={`${uid}-severity`}
            className="input w-full"
            value={severity}
            disabled={disabled}
            onChange={event => {
              setSeverity(parseAllergySeverity(event.target.value));
              setError(null);
            }}
          >
            <option value="">未指定</option>
            {ALLERGY_SEVERITIES.map(value => (
              <option key={value} value={value}>
                {ALLERGY_SEVERITY_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button type="submit" className="btn-primary" disabled={disabled || atLimit}>
            新增過敏史
          </button>
          {atLimit && <p className={LIMIT_CLASS}>{LIMIT_MESSAGE.allergies}</p>}
          {error && (
            <p role="alert" className={ERROR_CLASS}>
              {error}
            </p>
          )}
        </div>
      </form>
      {allergies.length === 0 ? (
        <EmptyState>尚未記錄過敏史。</EmptyState>
      ) : (
        <ul className={LIST_CLASS}>
          {allergies.map(item => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 dark:text-gray-100 break-words">
                  {item.name}
                  {item.severity !== undefined && (
                    <span className={`badge ml-2 align-middle ${SEVERITY_BADGE[item.severity]}`}>
                      {ALLERGY_SEVERITY_LABEL[item.severity]}
                    </span>
                  )}
                </p>
                {item.reaction !== undefined && (
                  <p className="mt-1 text-sm text-gray-600 dark:text-gray-300 whitespace-pre-wrap break-words">
                    {item.reaction}
                  </p>
                )}
              </div>
              <DeleteControl label={`過敏原：${item.name}`} disabled={disabled} onDelete={() => void remove(item.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConditionSection({ now }: { now: Date }) {
  const { personal, canEdit, saving, update } = usePersonal();
  const uid = useId();
  const [name, setName] = useState('');
  const [sinceYear, setSinceYear] = useState('');
  const [error, setError] = useState<string | null>(null);

  const conditions = personal.profile.conditions;
  const disabled = !canEdit || saving;
  const atLimit = conditions.length >= PERSONAL_LIMITS.conditions;

  async function handleAdd() {
    if (disabled || atLimit) return;
    const result = validateCondition({ name, sinceYear }, conditions, now);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const entry: Condition = { id: newPersonalId(), ...result.value };
    const ok = await update(current => ({
      ...current,
      profile: { ...current.profile, conditions: [...current.profile.conditions, entry] },
    }));
    if (ok) {
      setName('');
      setSinceYear('');
      setError(null);
    }
  }

  function remove(id: string) {
    return update(current => ({
      ...current,
      profile: { ...current.profile, conditions: current.profile.conditions.filter(item => item.id !== id) },
    }));
  }

  return (
    <section className="card" aria-label="慢性病／既往病史">
      <h2 className="section-title">慢性病／既往病史</h2>
      <p className={`mt-1 mb-4 ${MUTED_CLASS}`}>記錄慢性病與既往病史；起病年份可留空。</p>
      <form
        aria-label="新增病史"
        noValidate
        className="mb-4 grid gap-3 sm:grid-cols-2 print:hidden"
        onSubmit={event => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <div>
          <label className="label" htmlFor={`${uid}-name`}>
            疾病名稱
            <RequiredMark />
          </label>
          <input
            id={`${uid}-name`}
            type="text"
            className="input w-full"
            autoComplete="off"
            aria-required="true"
            placeholder="例如：高血壓、第二型糖尿病"
            value={name}
            disabled={disabled}
            onChange={event => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-year`}>
            起病年份（選填）
          </label>
          <input
            id={`${uid}-year`}
            type="text"
            inputMode="numeric"
            className="input w-full"
            autoComplete="off"
            placeholder="例如：2015"
            value={sinceYear}
            disabled={disabled}
            onChange={event => {
              setSinceYear(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" className="btn-primary" disabled={disabled || atLimit}>
            新增病史
          </button>
          {atLimit && <p className={LIMIT_CLASS}>{LIMIT_MESSAGE.conditions}</p>}
          {error && (
            <p role="alert" className={ERROR_CLASS}>
              {error}
            </p>
          )}
        </div>
      </form>
      {conditions.length === 0 ? (
        <EmptyState>尚未記錄慢性病或既往病史。</EmptyState>
      ) : (
        <ul className={LIST_CLASS}>
          {conditions.map(item => (
            <li key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-gray-900 dark:text-gray-100 break-words">{item.name}</p>
                {item.sinceYear !== undefined && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{`自 ${item.sinceYear} 年`}</p>
                )}
              </div>
              <DeleteControl label={`病史：${item.name}`} disabled={disabled} onDelete={() => void remove(item.id)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteSection({ today }: { today: string }) {
  const { personal, canEdit, saving, update } = usePersonal();
  const uid = useId();
  const [dateInput, setDateInput] = useState<string | null>(null);
  const [kind, setKind] = useState<NoteKind>('note');
  const [text, setText] = useState('');
  const [filter, setFilter] = useState<NoteFilter>('all');
  const [error, setError] = useState<string | null>(null);

  const notes = personal.notes;
  const date = dateInput ?? today;
  const disabled = !canEdit || saving;
  const atLimit = notes.length >= PERSONAL_LIMITS.notes;
  const textLength = text.trim().length;
  const openCount = useMemo(() => openQuestions(notes).length, [notes]);
  const visible = useMemo(() => sortNotesNewestFirst(filterNotes(notes, filter)), [notes, filter]);

  async function handleAdd() {
    if (disabled || atLimit) return;
    const result = validateNote({ date, kind, text });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const entry: PersonalNote = { id: newPersonalId(), ...result.value };
    const ok = await update(current => ({ ...current, notes: [...current.notes, entry] }));
    if (ok) {
      setText('');
      setError(null);
      if (filterNotes([entry], filter).length === 0) setFilter('all');
    }
  }

  function setDone(id: string, done: boolean) {
    return update(current => ({
      ...current,
      notes: current.notes.map(note => (note.id === id ? withQuestionDone(note, done) : note)),
    }));
  }

  function remove(id: string) {
    return update(current => ({ ...current, notes: current.notes.filter(note => note.id !== id) }));
  }

  return (
    <section className="card" aria-label="筆記與回診問題">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="section-title">筆記與回診問題</h2>
        <span role="status" className={`badge ${openCount > 0 ? OPEN_BADGE : MUTED_BADGE}`}>
          {`待問 ${openCount} 題`}
        </span>
      </div>
      <p className={`mt-1 mb-4 ${MUTED_CLASS}`}>記錄心得或想在回診時詢問醫師的問題；日期可填未來日期（例如下次回診日）。</p>
      <form
        aria-label="新增筆記或回診問題"
        noValidate
        className="mb-4 grid gap-3 sm:grid-cols-2 print:hidden"
        onSubmit={event => {
          event.preventDefault();
          void handleAdd();
        }}
      >
        <div>
          <label className="label" htmlFor={`${uid}-date`}>
            日期
            <RequiredMark />
          </label>
          <input
            id={`${uid}-date`}
            type="date"
            className="input w-full font-mono"
            aria-required="true"
            value={date}
            disabled={disabled}
            onChange={event => {
              setDateInput(event.target.value);
              setError(null);
            }}
          />
        </div>
        <div>
          <label className="label" htmlFor={`${uid}-kind`}>
            類型
          </label>
          <select
            id={`${uid}-kind`}
            className="input w-full"
            value={kind}
            disabled={disabled}
            onChange={event => {
              setKind(parseNoteKind(event.target.value));
              setError(null);
            }}
          >
            {NOTE_KINDS.map(value => (
              <option key={value} value={value}>
                {NOTE_KIND_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
        <div className="sm:col-span-2">
          <label className="label" htmlFor={`${uid}-text`}>
            內容
            <RequiredMark />
          </label>
          <textarea
            id={`${uid}-text`}
            className="input w-full"
            rows={3}
            aria-required="true"
            aria-describedby={`${uid}-count`}
            placeholder={kind === 'question' ? '例如：下次回診想請教醫師的問題' : '記錄想保留的重點'}
            value={text}
            disabled={disabled}
            onChange={event => {
              setText(event.target.value);
              setError(null);
            }}
          />
          <p
            id={`${uid}-count`}
            className={`mt-1 text-right text-xs ${
              textLength > PERSONAL_TEXT_LIMITS.note
                ? 'text-red-600 dark:text-red-400'
                : 'text-gray-500 dark:text-gray-400'
            }`}
          >
            {`${textLength}/${PERSONAL_TEXT_LIMITS.note}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
          <button type="submit" className="btn-primary" disabled={disabled || atLimit}>
            {`新增${NOTE_KIND_LABEL[kind]}`}
          </button>
          {atLimit && <p className={LIMIT_CLASS}>{LIMIT_MESSAGE.notes}</p>}
          {error && (
            <p role="alert" className={ERROR_CLASS}>
              {error}
            </p>
          )}
        </div>
      </form>
      <div className="mb-3 print:hidden">
        <select
          aria-label="筆記篩選"
          className="input w-full sm:w-44"
          value={filter}
          onChange={event => setFilter(parseNoteFilter(event.target.value))}
        >
          {NOTE_FILTERS.map(value => (
            <option key={value} value={value}>
              {NOTE_FILTER_LABEL[value]}
            </option>
          ))}
        </select>
      </div>
      {visible.length === 0 ? (
        <EmptyState>{notes.length === 0 ? '尚未新增筆記或回診問題。' : '沒有符合篩選條件的項目。'}</EmptyState>
      ) : (
        <ul className={LIST_CLASS}>
          {visible.map(note => (
            <li key={note.id} className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{note.date}</span>
                <span className={`badge ${KIND_BADGE[note.kind]}`}>{NOTE_KIND_LABEL[note.kind]}</span>
                {note.kind === 'question' && (
                  <span className={`badge ${note.done === true ? MUTED_BADGE : OPEN_BADGE}`}>
                    {note.done === true ? '已問' : '待問'}
                  </span>
                )}
              </div>
              <p className="mt-1 text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">{note.text}</p>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                {note.kind === 'question' && (
                  <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-300 print:hidden">
                    <input
                      type="checkbox"
                      className="h-4 w-4 accent-teal-600 dark:accent-teal-500"
                      aria-label="已詢問"
                      checked={note.done === true}
                      disabled={disabled}
                      onChange={event => void setDone(note.id, event.target.checked)}
                    />
                    <span>已詢問</span>
                  </label>
                )}
                <DeleteControl
                  label={`${NOTE_KIND_LABEL[note.kind]}：${snippet(note.text)}`}
                  disabled={disabled}
                  onDelete={() => void remove(note.id)}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function HealthProfile({ now }: { now?: Date }) {
  const clock = useNow(now);

  return (
    <div className="space-y-6">
      <PersonalNotice />
      <p className={MUTED_CLASS}>
        自行輸入的健康檔案，經加密保存於你的病歷中；僅供個人整理與就診時參考，不構成診斷或醫療建議。
      </p>
      <AllergySection />
      <ConditionSection now={clock} />
      <NoteSection today={formatLocalDate(clock)} />
    </div>
  );
}
