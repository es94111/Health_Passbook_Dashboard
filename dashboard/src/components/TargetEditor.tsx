import { useId, useState, type FormEvent } from 'react';
import { usePersonal } from '../personalContext';
import {
  checkTargetKey, EMPTY_TARGET_FORM, targetToForm, validateLabTarget, withTarget, withoutTarget,
  type LabTargetForm,
} from '../lib/labTargets';
import PersonalNotice from './PersonalNotice';

const DISABLED_STYLE = 'disabled:opacity-50 disabled:cursor-not-allowed';

interface Props {
  seriesKey: string;
  subItem: string;
  unit?: string;
}

/** 單一檢驗項目的個人目標編輯器：下限／上限皆為選填，至少填一項。 */
export default function TargetEditor({ seriesKey, subItem, unit }: Props) {
  const { personal, canEdit, saving, update } = usePersonal();
  const panelId = useId();
  const hintId = `${panelId}-hint`;
  const lowId = `${panelId}-low`;
  const highId = `${panelId}-high`;
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<LabTargetForm>(EMPTY_TARGET_FORM);
  const [error, setError] = useState<string | null>(null);

  const target = Object.hasOwn(personal.targets, seriesKey) ? personal.targets[seriesKey] : undefined;
  const disabled = !canEdit || saving;
  const verb = target ? '編輯' : '設定';

  if (!canEdit && !open) return null;

  function openEditor() {
    setForm(targetToForm(target));
    setError(null);
    setOpen(true);
  }

  function closeEditor() {
    setOpen(false);
    setError(null);
  }

  function change(field: keyof LabTargetForm, value: string) {
    setForm(current => ({ ...current, [field]: value }));
    setError(null);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const result = validateLabTarget(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    const keyError = checkTargetKey(personal.targets, seriesKey);
    if (keyError) {
      setError(keyError);
      return;
    }
    const saved = await update(current => withTarget(current, seriesKey, result.value));
    if (saved) closeEditor();
  }

  async function handleClear() {
    if (disabled) return;
    const saved = await update(current => withoutTarget(current, seriesKey));
    if (saved) closeEditor();
  }

  return (
    <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-2 print:hidden">
      <button
        type="button"
        onClick={open ? closeEditor : openEditor}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${verb}個人目標：${subItem}`}
        className="text-xs text-teal-700 dark:text-teal-400 hover:underline"
      >
        {verb}個人目標
      </button>
      {open && (
        <form
          id={panelId}
          aria-label={`${subItem} 個人目標`}
          noValidate
          onSubmit={event => { void handleSubmit(event); }}
          className="mt-2 space-y-2"
        >
          <PersonalNotice />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor={lowId} className="label">下限（≥）</label>
              <input
                id={lowId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.low}
                disabled={disabled}
                aria-describedby={hintId}
                onChange={event => change('low', event.target.value)}
                className="input w-full font-mono"
              />
            </div>
            <div>
              <label htmlFor={highId} className="label">上限（≤）</label>
              <input
                id={highId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={form.high}
                disabled={disabled}
                aria-describedby={hintId}
                onChange={event => change('high', event.target.value)}
                className="input w-full font-mono"
              />
            </div>
          </div>
          <p id={hintId} className="text-xs text-gray-500 dark:text-gray-400">
            至少填寫一項，另一端可留空。{unit ? `單位：${unit}` : ''}
          </p>
          {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={disabled} className={`btn-primary px-3 py-1.5 text-xs ${DISABLED_STYLE}`}>
              儲存
            </button>
            {target && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => { void handleClear(); }}
                className={`btn-secondary px-3 py-1.5 text-xs ${DISABLED_STYLE}`}
              >
                清除目標
              </button>
            )}
            <button type="button" onClick={closeEditor} className="btn-secondary px-3 py-1.5 text-xs">
              取消
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
