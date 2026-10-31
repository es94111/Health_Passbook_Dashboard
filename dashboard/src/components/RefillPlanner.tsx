import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { Visit } from '../parsers/types';
import { formatLocalDate, useNow } from '../lib/clock';
import { listMedications } from '../lib/keySummary';
import {
  EMPTY_REFILL_FORM,
  REFILL_DISCLAIMER,
  REFILL_WINDOW_DAYS,
  describeRefillTiming,
  sortRefillsByUrgency,
  validateRefillPlan,
  type RefillFormInput,
  type RefillState,
} from '../lib/refills';
import { PERSONAL_LIMITS, newPersonalId } from '../personalData';
import { usePersonal } from '../personalContext';
import PersonalNotice from './PersonalNotice';

interface FieldConfig {
  key: keyof RefillFormInput;
  label: string;
  required?: boolean;
  placeholder?: string;
  hint?: string;
  numeric?: boolean;
  mono?: boolean;
  type?: 'text' | 'date';
  wide?: boolean;
}

const FIELDS: FieldConfig[] = [
  { key: 'drugName', label: '藥品名稱', required: true },
  { key: 'drugCode', label: '藥品代碼', mono: true },
  { key: 'hospital', label: '醫院' },
  { key: 'prescribedDate', label: '處方開立日', required: true, type: 'date', mono: true },
  { key: 'daysPerFill', label: '每次天數', required: true, numeric: true, mono: true, placeholder: '例：28' },
  { key: 'fills', label: '連續處方總次數', required: true, numeric: true, mono: true, placeholder: '例：3' },
  { key: 'taken', label: '已領藥次數', required: true, numeric: true, mono: true, hint: '含第 1 次領藥' },
  { key: 'note', label: '備註', wide: true },
];

const STATE_BADGE: Record<RefillState, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  open: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  notYet: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  finished: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
};

const INTRO = `以「處方開立日＋已領藥次數×每次天數」推估藥量用完日，並從用完日前 ${REFILL_WINDOW_DAYS} 天起提示可以領下一次藥。本功能僅供提醒，非醫囑；${REFILL_DISCLAIMER}。`;

const DISABLED_STYLE = 'disabled:opacity-50 disabled:cursor-not-allowed';

export default function RefillPlanner({ visits, now }: { visits?: Visit[]; now?: Date }) {
  const { personal, canEdit, saving, update } = usePersonal();
  const today = useNow(now);
  const uid = useId();
  const [form, setForm] = useState<RefillFormInput>(EMPTY_REFILL_FORM);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const medications = useMemo(() => listMedications(visits ?? []), [visits]);
  const entries = useMemo(() => sortRefillsByUrgency(personal.refills, today), [personal.refills, today]);
  const disabled = !canEdit || saving;

  function setField(key: keyof RefillFormInput, value: string) {
    setForm(current => ({ ...current, [key]: value }));
    setError(null);
  }

  function importMedication(code: string) {
    const option = medications.find(item => item.code === code);
    if (!option) return;
    setForm(current => ({
      ...current,
      drugName: option.name,
      drugCode: option.code,
      prescribedDate: formatLocalDate(option.latestDate),
    }));
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    if (personal.refills.length >= PERSONAL_LIMITS.refills) {
      setError(`連續處方已達上限（${PERSONAL_LIMITS.refills} 筆）`);
      return;
    }
    const result = validateRefillPlan(form, today);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const id = newPersonalId();
    setError(null);
    const saved = await update(current => ({
      ...current,
      refills: [...current.refills, { id, ...result.value }],
    }));
    if (saved) setForm(EMPTY_REFILL_FORM);
  }

  async function markTaken(id: string) {
    if (disabled) return;
    await update(current => ({
      ...current,
      refills: current.refills.map(plan =>
        plan.id === id ? { ...plan, taken: Math.min(plan.taken + 1, plan.fills) } : plan,
      ),
    }));
  }

  async function remove(id: string) {
    if (disabled) return;
    const removed = await update(current => ({
      ...current,
      refills: current.refills.filter(plan => plan.id !== id),
    }));
    if (removed) setConfirmingId(null);
  }

  return (
    <section className="card" aria-label="慢性病連續處方領藥提醒">
      <h2 className="section-title mb-2">慢性病連續處方領藥提醒</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{INTRO}</p>
      <PersonalNotice />

      <form
        aria-label="新增連續處方"
        noValidate
        onSubmit={event => {
          void handleSubmit(event);
        }}
        className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 print:hidden"
      >
        {medications.length > 0 && (
          <select
            aria-label="從健保用藥紀錄帶入"
            className="input w-full sm:col-span-2"
            value=""
            disabled={disabled}
            onChange={event => importMedication(event.target.value)}
          >
            <option value="">從健保用藥紀錄帶入…</option>
            {medications.map(option => (
              <option key={option.code} value={option.code}>
                {`${option.name}（${option.code}，最近 ${formatLocalDate(option.latestDate)}）`}
              </option>
            ))}
          </select>
        )}

        {FIELDS.map(field => {
          const id = `${uid}-${field.key}`;
          const hintId = `${id}-hint`;
          return (
            <div key={field.key} className={field.wide ? 'sm:col-span-2' : undefined}>
              <div className="flex items-baseline gap-1">
                <label htmlFor={id} className="label">
                  {field.label}
                </label>
                {field.required && (
                  <span aria-hidden="true" className="mb-1 text-sm text-red-600 dark:text-red-400">
                    *
                  </span>
                )}
              </div>
              <input
                id={id}
                type={field.type ?? 'text'}
                inputMode={field.numeric ? 'numeric' : undefined}
                value={form[field.key]}
                max={field.type === 'date' ? formatLocalDate(today) : undefined}
                placeholder={field.placeholder}
                aria-required={field.required || undefined}
                aria-describedby={field.hint ? hintId : undefined}
                disabled={disabled}
                onChange={event => setField(field.key, event.target.value)}
                className={field.mono ? 'input w-full font-mono' : 'input w-full'}
              />
              {field.hint && (
                <p id={hintId} className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {field.hint}
                </p>
              )}
            </div>
          );
        })}

        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400 sm:col-span-2">
            {error}
          </p>
        )}
        <div className="sm:col-span-2">
          <button type="submit" className={`btn-primary ${DISABLED_STYLE}`} disabled={disabled}>
            新增
          </button>
        </div>
      </form>

      {entries.length === 0 ? (
        <div className="mt-5 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-6 text-center">
          <p className="text-sm text-gray-500 dark:text-gray-400">尚未登記任何連續處方</p>
        </div>
      ) : (
        <ul aria-label="連續處方清單" className="mt-5 space-y-3">
          {entries.map(({ plan, status }) => {
            const nameId = `${uid}-name-${plan.id}`;
            const timing = describeRefillTiming(status);
            return (
              <li key={plan.id} className="min-w-0 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span id={nameId} className="font-medium text-gray-900 dark:text-gray-100 break-words">
                    {plan.drugName}
                  </span>
                  {plan.drugCode && (
                    <span className="font-mono text-xs text-gray-500 dark:text-gray-400 break-all">{plan.drugCode}</span>
                  )}
                  <span className={`badge ${STATE_BADGE[status.state]}`}>{status.label}</span>
                </div>
                {plan.hospital && (
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 break-words">{plan.hospital}</p>
                )}
                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                  {`已領 ${plan.taken}/${plan.fills} 次 · 每次 ${plan.daysPerFill} 天`}
                </p>
                {status.windowOpensOn && (
                  <p className="text-sm text-gray-700 dark:text-gray-300">
                    最早可領藥日：<span className="font-mono">{formatLocalDate(status.windowOpensOn)}</span>
                  </p>
                )}
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  預估藥量用完日：<span className="font-mono">{formatLocalDate(status.supplyEndsOn)}</span>
                </p>
                {timing && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{timing}</p>}
                {plan.note && (
                  <p className="mt-2 text-sm text-gray-600 dark:text-gray-400 whitespace-pre-wrap break-words">
                    {plan.note}
                  </p>
                )}
                <div className="mt-3 flex flex-wrap items-center gap-2 print:hidden">
                  <button
                    type="button"
                    className={`btn-secondary ${DISABLED_STYLE}`}
                    aria-describedby={nameId}
                    disabled={disabled || status.state === 'finished'}
                    onClick={() => {
                      void markTaken(plan.id);
                    }}
                  >
                    已領藥（+1）
                  </button>
                  {confirmingId === plan.id ? (
                    <span className="inline-flex flex-wrap items-center gap-2">
                      <span className="text-sm text-red-600 dark:text-red-400">確定刪除？</span>
                      <button
                        type="button"
                        className={`btn-danger ${DISABLED_STYLE}`}
                        aria-describedby={nameId}
                        disabled={disabled}
                        onClick={() => {
                          void remove(plan.id);
                        }}
                      >
                        確認
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        aria-describedby={nameId}
                        autoFocus
                        onClick={() => setConfirmingId(null)}
                      >
                        取消
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      className={`btn-secondary ${DISABLED_STYLE}`}
                      aria-describedby={nameId}
                      disabled={disabled}
                      onClick={() => setConfirmingId(plan.id)}
                    >
                      刪除
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
