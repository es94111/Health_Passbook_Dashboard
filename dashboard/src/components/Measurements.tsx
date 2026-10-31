import { useId, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatLocalDate, parseLocalDate, useNow } from '../lib/clock';
import {
  CHART_RANGE_OPTIONS,
  EMPTY_VALUE,
  GLUCOSE_CONTEXT_LABEL,
  GLUCOSE_CONTEXTS,
  MEASUREMENT_KIND_LABEL,
  MEASUREMENT_KINDS,
  MEASUREMENT_UNIT,
  buildTrendPoints,
  describeSummary,
  filterByChartRange,
  formatMeasurementMoment,
  formatMeasurementValue,
  isChartRange,
  isGlucoseContext,
  splitByKind,
  summarizeMeasurements,
  validateBloodPressure,
  validateGlucose,
  validateWeight,
} from '../lib/measurements';
import type { ChartRange, MeasurementsSummary, NewMeasurement, ValidationResult } from '../lib/measurements';
import { usePersonal } from '../personalContext';
import { PERSONAL_LIMITS, newPersonalId } from '../personalData';
import type { GlucoseContext, Measurement, MeasurementKind } from '../personalData';
import PersonalNotice from './PersonalNotice';

const PAGE_SIZE = 30;
const MAX_DOT_POINTS = 60;
const DISABLED_STYLE = 'disabled:opacity-50 disabled:cursor-not-allowed';

interface FormState {
  systolic: string;
  diastolic: string;
  pulse: string;
  value: string;
  context: GlucoseContext | '';
  date: string;
  time: string;
  note: string;
}

const CLEARED_FIELDS = { systolic: '', diastolic: '', pulse: '', value: '', time: '', note: '' };
const BLANK_FORM: FormState = { ...CLEARED_FIELDS, context: '', date: '' };

interface FieldProps {
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  type?: 'text' | 'date' | 'time';
  inputMode?: 'numeric' | 'decimal';
  max?: string;
}

function Field({ id, label, value, disabled, onChange, type = 'text', inputMode, max }: FieldProps) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        autoComplete="off"
        max={max}
        className="input w-full"
        value={value}
        disabled={disabled}
        onChange={event => onChange(event.target.value)}
      />
    </div>
  );
}

function MeasurementForm({ kind, now, today }: { kind: MeasurementKind; now: Date; today: string }) {
  const { personal, canEdit, saving, update } = usePersonal();
  const baseId = useId();
  const [form, setForm] = useState<FormState>(() => ({ ...BLANK_FORM, date: today }));
  const [error, setError] = useState<string | null>(null);
  const disabled = !canEdit || saving;
  const label = MEASUREMENT_KIND_LABEL[kind];

  function setField(patch: Partial<FormState>) {
    setError(null);
    setForm(previous => ({ ...previous, ...patch }));
  }

  function validate(): ValidationResult<NewMeasurement> {
    const { date, time, note } = form;
    if (kind === 'bp') {
      return validateBloodPressure(
        { date, time, note, systolic: form.systolic, diastolic: form.diastolic, pulse: form.pulse },
        now,
      );
    }
    if (kind === 'glucose') {
      return validateGlucose({ date, time, note, value: form.value, context: form.context }, now);
    }
    return validateWeight({ date, time, note, value: form.value }, now);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled) return;
    const result = validate();
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (personal.measurements.length >= PERSONAL_LIMITS.measurements) {
      setError(`量測紀錄已達上限（${PERSONAL_LIMITS.measurements} 筆）`);
      return;
    }
    setError(null);
    const created = result.value;
    const saved = await update(latest => ({
      ...latest,
      measurements: [...latest.measurements, { id: newPersonalId(), ...created }],
    }));
    if (saved) setForm(previous => ({ ...previous, ...CLEARED_FIELDS }));
  }

  return (
    <form
      aria-label={`新增${label}紀錄`}
      noValidate
      className="mt-4 rounded-lg border border-gray-200 dark:border-gray-700 p-4 print:hidden"
      onSubmit={event => {
        void handleSubmit(event);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {kind === 'bp' ? (
          <>
            <Field
              id={`${baseId}-systolic`}
              label="收縮壓（mmHg）"
              inputMode="numeric"
              value={form.systolic}
              disabled={disabled}
              onChange={value => setField({ systolic: value })}
            />
            <Field
              id={`${baseId}-diastolic`}
              label="舒張壓（mmHg）"
              inputMode="numeric"
              value={form.diastolic}
              disabled={disabled}
              onChange={value => setField({ diastolic: value })}
            />
            <Field
              id={`${baseId}-pulse`}
              label="脈搏（次/分，選填）"
              inputMode="numeric"
              value={form.pulse}
              disabled={disabled}
              onChange={value => setField({ pulse: value })}
            />
          </>
        ) : null}
        {kind === 'glucose' ? (
          <>
            <Field
              id={`${baseId}-value`}
              label="血糖值（mg/dL）"
              inputMode="decimal"
              value={form.value}
              disabled={disabled}
              onChange={value => setField({ value })}
            />
            <div>
              <label htmlFor={`${baseId}-context`} className="label">
                情境
              </label>
              <select
                id={`${baseId}-context`}
                className="input w-full"
                value={form.context}
                disabled={disabled}
                onChange={event => {
                  const next = event.target.value;
                  setField({ context: isGlucoseContext(next) ? next : '' });
                }}
              >
                <option value="" disabled>
                  請選擇情境
                </option>
                {GLUCOSE_CONTEXTS.map(option => (
                  <option key={option} value={option}>
                    {GLUCOSE_CONTEXT_LABEL[option]}
                  </option>
                ))}
              </select>
            </div>
          </>
        ) : null}
        {kind === 'weight' ? (
          <Field
            id={`${baseId}-value`}
            label="體重（kg）"
            inputMode="decimal"
            value={form.value}
            disabled={disabled}
            onChange={value => setField({ value })}
          />
        ) : null}
        <Field
          id={`${baseId}-date`}
          label="日期"
          type="date"
          max={today}
          value={form.date}
          disabled={disabled}
          onChange={value => setField({ date: value })}
        />
        <Field
          id={`${baseId}-time`}
          label="時間（選填）"
          type="time"
          value={form.time}
          disabled={disabled}
          onChange={value => setField({ time: value })}
        />
        <Field
          id={`${baseId}-note`}
          label="備註（選填）"
          value={form.note}
          disabled={disabled}
          onChange={value => setField({ note: value })}
        />
      </div>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : null}
      <div className="mt-3">
        <button type="submit" className="btn-primary" disabled={disabled}>
          新增
        </button>
      </div>
    </form>
  );
}

interface SummaryCellProps {
  title: string;
  value: string;
  unit: string;
  hint?: string | null;
}

function SummaryCell({ title, value, unit, hint }: SummaryCellProps) {
  return (
    <div className="rounded-xl border border-gray-100 dark:border-gray-700 bg-gray-50 dark:bg-gray-900/40 p-3">
      <dt className="text-xs text-gray-500 dark:text-gray-400">{title}</dt>
      <dd className="mt-1 font-mono text-lg font-semibold text-gray-800 dark:text-gray-100">
        {value}
        {value !== EMPTY_VALUE ? (
          <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">{unit}</span>
        ) : null}
      </dd>
      {hint ? <dd className="text-xs text-gray-500 dark:text-gray-400">{hint}</dd> : null}
    </div>
  );
}

function SummaryCards({ kind, summary }: { kind: MeasurementKind; summary: MeasurementsSummary }) {
  const display = describeSummary(summary, kind);
  const unit = MEASUREMENT_UNIT[kind];
  return (
    <dl className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
      <SummaryCell title="最新一筆" value={display.latestValue} unit={unit} hint={display.latestMoment} />
      <SummaryCell title="7 日平均" value={display.avg7} unit={unit} />
      <SummaryCell title="30 日平均" value={display.avg30} unit={unit} />
      <SummaryCell title="總筆數" value={String(display.count)} unit="筆" />
    </dl>
  );
}

function TrendChart({ kind, items, today }: { kind: MeasurementKind; items: Measurement[]; today: string }) {
  const [range, setRange] = useState<ChartRange>('all');
  const visible = useMemo(() => filterByChartRange(items, range, parseLocalDate(today)), [items, range, today]);
  const points = useMemo(() => buildTrendPoints(visible), [visible]);
  const label = MEASUREMENT_KIND_LABEL[kind];
  const unit = MEASUREMENT_UNIT[kind];
  const isBp = kind === 'bp';
  const first = points[0];
  const last = points[points.length - 1];
  const dot = points.length <= MAX_DOT_POINTS ? { r: 2.5, fill: 'currentColor' } : false;

  return (
    <div className="mt-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label}趨勢</h3>
        <select
          aria-label="圖表範圍"
          className="input print:hidden"
          value={range}
          onChange={event => {
            const next = event.target.value;
            if (isChartRange(next)) setRange(next);
          }}
        >
          {CHART_RANGE_OPTIONS.map(option => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      {visible.length < 2 ? (
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">資料不足 2 筆，無法繪製趨勢圖。</p>
      ) : (
        <>
          <div role="img" aria-label={`${label}趨勢圖`} className="mt-2 text-teal-700 dark:text-teal-400">
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={points} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" opacity={0.15} />
                <XAxis dataKey="index" hide />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 10, fill: 'currentColor' }} width={44} />
                <Tooltip
                  formatter={(value, name) => [`${String(value)} ${unit}`, String(name)]}
                  labelFormatter={pointIndex => points[Number(pointIndex)]?.label ?? ''}
                />
                <Line
                  type="linear"
                  dataKey="primary"
                  name={isBp ? '收縮壓' : label}
                  stroke="currentColor"
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  dot={dot}
                />
                {isBp ? (
                  <Line
                    type="linear"
                    dataKey="secondary"
                    name="舒張壓"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    isAnimationActive={false}
                    dot={dot}
                    className="text-sky-700 dark:text-sky-400"
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {isBp ? (
            <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-600 dark:text-gray-300">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden="true" className="inline-block w-5 border-t-2 border-teal-700 dark:border-teal-400" />
                收縮壓（實線）
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="inline-block w-5 border-t-2 border-dashed border-sky-700 dark:border-sky-400"
                />
                舒張壓（虛線）
              </span>
            </p>
          ) : null}
          <div className="flex justify-between gap-2 text-xs text-gray-500 dark:text-gray-400 mt-1">
            <span className="font-mono">{first?.label}</span>
            <span>共 {points.length} 筆</span>
            <span className="font-mono">{last?.label}</span>
          </div>
        </>
      )}
    </div>
  );
}

interface RecordRowProps {
  item: Measurement;
  kindLabel: string;
  unit: string;
  confirming: boolean;
  disabled: boolean;
  onAskDelete: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}

function RecordRow({ item, kindLabel, unit, confirming, disabled, onAskDelete, onCancel, onConfirm }: RecordRowProps) {
  const moment = formatMeasurementMoment(item);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
      <span className="font-mono text-xs text-gray-500 dark:text-gray-400">{moment}</span>
      <span className="font-mono font-semibold text-gray-800 dark:text-gray-100">
        {formatMeasurementValue(item)}
        <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">{unit}</span>
      </span>
      {item.kind === 'bp' && item.pulse !== undefined ? (
        <span className="text-xs text-gray-600 dark:text-gray-300">
          脈搏 <span className="font-mono">{item.pulse}</span> 次/分
        </span>
      ) : null}
      {item.kind === 'glucose' ? (
        <span className="badge bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
          {GLUCOSE_CONTEXT_LABEL[item.context]}
        </span>
      ) : null}
      <span className="ml-auto print:hidden">
        {confirming ? (
          <span className="inline-flex flex-wrap items-center gap-2">
            <span className="text-sm text-red-600 dark:text-red-400">確定刪除？</span>
            <button type="button" className={`btn-danger ${DISABLED_STYLE}`} disabled={disabled} onClick={onConfirm}>
              確認
            </button>
            <button type="button" className={`btn-secondary ${DISABLED_STYLE}`} disabled={disabled} onClick={onCancel}>
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={`btn-secondary ${DISABLED_STYLE}`}
            aria-label={`刪除 ${moment} 的${kindLabel}紀錄`}
            disabled={disabled}
            onClick={onAskDelete}
          >
            刪除
          </button>
        )}
      </span>
      {item.note ? (
        <p className="basis-full break-words text-sm text-gray-600 dark:text-gray-300">{item.note}</p>
      ) : null}
    </li>
  );
}

function RecordList({ kind, items }: { kind: MeasurementKind; items: Measurement[] }) {
  const { canEdit, saving, update } = usePersonal();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const newestFirst = useMemo(() => [...items].reverse(), [items]);
  const shown = newestFirst.slice(0, limit);
  const label = MEASUREMENT_KIND_LABEL[kind];
  const unit = MEASUREMENT_UNIT[kind];
  const disabled = !canEdit || saving;

  async function remove(id: string) {
    const removed = await update(latest => ({
      ...latest,
      measurements: latest.measurements.filter(measurement => measurement.id !== id),
    }));
    if (removed) setConfirmingId(null);
  }

  return (
    <div className="mt-6">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{label}紀錄</h3>
      <p role="status" className="mt-1 mb-2 text-xs text-gray-500 dark:text-gray-400">
        顯示 {shown.length} / 共 {newestFirst.length} 筆
      </p>
      <ul
        aria-label={`${label}紀錄`}
        className="divide-y divide-gray-100 dark:divide-gray-700 rounded-lg border border-gray-200 dark:border-gray-700"
      >
        {shown.map(item => (
          <RecordRow
            key={item.id}
            item={item}
            kindLabel={label}
            unit={unit}
            confirming={confirmingId === item.id}
            disabled={disabled}
            onAskDelete={() => setConfirmingId(item.id)}
            onCancel={() => setConfirmingId(null)}
            onConfirm={() => {
              void remove(item.id);
            }}
          />
        ))}
      </ul>
      {newestFirst.length > limit ? (
        <div className="mt-3 print:hidden">
          <button type="button" className="btn-secondary" onClick={() => setLimit(value => value + PAGE_SIZE)}>
            顯示更多
          </button>
        </div>
      ) : null}
    </div>
  );
}

export default function Measurements({ now }: { now?: Date }) {
  const { personal, canEdit } = usePersonal();
  const current = useNow(now);
  const today = formatLocalDate(current);
  const [kind, setKind] = useState<MeasurementKind>('bp');
  const split = useMemo(() => splitByKind(personal.measurements), [personal.measurements]);
  const summary = useMemo(
    () => summarizeMeasurements(personal.measurements, parseLocalDate(today)),
    [personal.measurements, today],
  );
  const items: Measurement[] = split[kind];
  const label = MEASUREMENT_KIND_LABEL[kind];

  return (
    <section className="card" aria-label="自我量測">
      <h2 className="section-title mb-2">自我量測</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        自行輸入的量測紀錄，經加密保存於你的病歷中；僅供追蹤參考，不構成診斷或醫療建議。
      </p>
      <PersonalNotice />
      <div
        role="group"
        aria-label="量測類型"
        className="mt-3 inline-flex gap-1 rounded-lg bg-gray-100 dark:bg-gray-800 p-1 print:hidden"
      >
        {MEASUREMENT_KINDS.map(option => (
          <button
            key={option}
            type="button"
            aria-pressed={kind === option}
            onClick={() => setKind(option)}
            className={`px-3 py-1.5 text-sm rounded-md ${
              kind === option
                ? 'bg-teal-600 text-white'
                : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {MEASUREMENT_KIND_LABEL[option]}
          </button>
        ))}
      </div>
      <MeasurementForm key={kind} kind={kind} now={current} today={today} />
      {items.length === 0 ? (
        <div className="mt-4 rounded-xl border border-dashed border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-6 text-center">
          <p className="text-sm text-gray-600 dark:text-gray-300">
            尚無{label}紀錄{canEdit ? '，請使用上方表單新增第一筆。' : '。'}
          </p>
        </div>
      ) : (
        <>
          <SummaryCards kind={kind} summary={summary} />
          <TrendChart key={kind} kind={kind} items={items} today={today} />
          <RecordList key={kind} kind={kind} items={items} />
        </>
      )}
    </section>
  );
}
