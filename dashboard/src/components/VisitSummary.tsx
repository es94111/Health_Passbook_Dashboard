import { useId, useMemo, type ReactNode } from 'react';
import { abnormalLabSeriesSummaries, computeAllLabSeriesSummaries, labReference } from '../lib/clinicalLabSeries';
import { formatLocalDate, useNow } from '../lib/clock';
import { computeDiagnosisGroups, sortDiagnosisGroups } from '../lib/diagnosisGroups';
import { computeFreshness, latestRecordDate } from '../lib/freshness';
import { ALLERGY_SEVERITY_LABEL, openQuestions } from '../lib/healthProfile';
import { RECENT_WINDOW_DAYS, computeAllMedicationSummaries, formatLabValue } from '../lib/keySummary';
import {
  MEASUREMENT_KIND_LABEL,
  MEASUREMENT_KINDS,
  MEASUREMENT_UNIT,
  describeSummary,
  summarizeMeasurements,
} from '../lib/measurements';
import { REFILL_DISCLAIMER, describeRefillTiming, sortRefillsByUrgency, type RefillState } from '../lib/refills';
import type { NHIData } from '../parsers/types';
import { usePersonal } from '../personalContext';
import type { Allergy, AllergySeverity } from '../personalData';

const LIMITS = {
  medications: 20,
  refills: 10,
  abnormal: 12,
  diagnoses: 5,
  visits: 6,
  stays: 3,
  visitDiagnoses: 3,
} as const;

const DASH = '—';

const ABNORMAL_META = {
  high: {
    label: '偏高',
    badge: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
    value: 'text-red-600 dark:text-red-400',
  },
  low: {
    label: '偏低',
    badge: 'bg-blue-100 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
    value: 'text-blue-600 dark:text-blue-400',
  },
} as const;

const STATE_BADGE: Record<RefillState, string> = {
  overdue: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  open: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  notYet: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  finished: 'bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300',
};

const SEVERITY_BADGE: Record<AllergySeverity, string> = {
  mild: 'bg-amber-50 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300',
  moderate: 'bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200',
  severe: 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-300',
};

const SEVERITY_RANK: Record<AllergySeverity, number> = { severe: 0, moderate: 1, mild: 2 };
const UNRATED_RANK = 3;

const MUTED_CLASS = 'text-sm text-gray-500 dark:text-gray-400';
const LIST_CLASS = 'divide-y divide-gray-100 dark:divide-gray-700';
const SUBHEAD_CLASS = 'mb-1 text-xs font-medium text-gray-500 dark:text-gray-400';
const HEAD_ROW_CLASS = 'border-b border-gray-200 dark:border-gray-700 text-xs text-gray-500 dark:text-gray-400';
const NAME_CLASS = 'text-sm font-medium text-gray-800 dark:text-gray-100 break-words';
const META_CLASS = 'text-xs text-gray-500 dark:text-gray-400';

const isValidDate = (date: Date): boolean => Number.isFinite(date.getTime());
const day = (date: Date): string => (isValidDate(date) ? formatLocalDate(date) : DASH);

function sortAllergies(allergies: readonly Allergy[]): Allergy[] {
  const rank = (allergy: Allergy) => (allergy.severity ? SEVERITY_RANK[allergy.severity] : UNRATED_RANK);
  return [...allergies].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

function diagnosisNames(diagnoses: readonly { code: string; name: string }[]): string {
  const names = diagnoses.map(diagnosis => diagnosis.name || diagnosis.code).filter(Boolean);
  return [...new Set(names)].slice(0, LIMITS.visitDiagnoses).join('、');
}

function Block({ title, note, wide = false, children }: {
  title: string;
  note?: string;
  wide?: boolean;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className={`rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-4 print:break-inside-avoid${wide ? ' lg:col-span-2' : ''}`}
    >
      <h3 id={titleId} className="text-sm font-semibold text-gray-800 dark:text-gray-100">{title}</h3>
      {note && <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{note}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className={MUTED_CLASS}>{children}</p>;
}

function More({ total, shown }: { total: number; shown: number }) {
  if (total <= shown) return null;
  return <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{`另有 ${total - shown} 項未列出`}</p>;
}

export default function VisitSummary({ data, now }: { data: NHIData; now?: Date }) {
  const { personal } = usePersonal();
  const current = useNow(now);

  const latest = useMemo(() => latestRecordDate(data), [data]);
  const freshness = useMemo(() => computeFreshness(latest, current), [latest, current]);
  const questions = useMemo(() => openQuestions(personal.notes), [personal.notes]);
  const allergies = useMemo(() => sortAllergies(personal.profile.allergies), [personal.profile.allergies]);
  const medications = useMemo(
    () => computeAllMedicationSummaries(data.visits).filter(medication => medication.recentCount > 0),
    [data.visits],
  );
  const refills = useMemo(() => sortRefillsByUrgency(personal.refills, current), [personal.refills, current]);
  const labSummaries = useMemo(
    () => computeAllLabSeriesSummaries(data.labResults, personal.targets),
    [data.labResults, personal.targets],
  );
  const abnormal = useMemo(() => abnormalLabSeriesSummaries(labSummaries), [labSummaries]);
  const measurementRows = useMemo(() => {
    const summary = summarizeMeasurements(personal.measurements, current);
    return MEASUREMENT_KINDS
      .map(kind => ({ kind, ...describeSummary(summary, kind) }))
      .filter(row => row.count > 0);
  }, [personal.measurements, current]);
  const diagnoses = useMemo(
    () => sortDiagnosisGroups(computeDiagnosisGroups(data.visits), 'count'),
    [data.visits],
  );
  const recentVisits = useMemo(
    () => data.visits
      .filter(visit => isValidDate(visit.date))
      .sort((a, b) => b.date.getTime() - a.date.getTime()),
    [data.visits],
  );
  const recentStays = useMemo(
    () => data.hospitalizations
      .filter(stay => isValidDate(stay.admitDate))
      .sort((a, b) => b.admitDate.getTime() - a.admitDate.getTime()),
    [data.hospitalizations],
  );

  return (
    <section aria-label="看診摘要" className="print-sheet space-y-4">
      <header className="card flex flex-wrap items-start justify-between gap-3 print:break-inside-avoid">
        <div className="min-w-0 space-y-1">
          <h2 className="section-title">看診摘要</h2>
          <p className="text-sm text-gray-600 dark:text-gray-300">
            產生日期：<span className="font-mono">{formatLocalDate(current)}</span>
          </p>
          {latest ? (
            <p className="text-sm text-gray-600 dark:text-gray-300">
              資料最新紀錄：<span className="font-mono">{formatLocalDate(latest)}</span>
            </p>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-300">尚無健保資料紀錄</p>
          )}
          {freshness.stale && (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              {`最新紀錄距今 ${freshness.ageDays} 天，內容可能不是最新`}
            </p>
          )}
        </div>
        <button type="button" className="btn-secondary shrink-0 print:hidden" onClick={() => window.print()}>
          列印
        </button>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <Block title="待問問題">
          {questions.length === 0 ? (
            <Empty>沒有待問的問題。可在「健康檔案」記下想問醫師的事。</Empty>
          ) : (
            <ul className={LIST_CLASS}>
              {questions.map(question => (
                <li key={question.id} className="py-2">
                  <p className={`font-mono ${META_CLASS}`}>{question.date}</p>
                  <p className="text-sm text-gray-800 dark:text-gray-100 whitespace-pre-wrap break-words">
                    {question.text}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title="過敏與病史">
          <div className="space-y-4">
            <div>
              <h4 className={SUBHEAD_CLASS}>過敏</h4>
              {allergies.length === 0 ? (
                <Empty>尚未記錄過敏史（未記錄不代表沒有過敏）</Empty>
              ) : (
                <ul className={LIST_CLASS}>
                  {allergies.map(allergy => (
                    <li key={allergy.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                      <span className={NAME_CLASS}>{allergy.name}</span>
                      {allergy.severity && (
                        <span className={`badge ${SEVERITY_BADGE[allergy.severity]}`}>
                          {ALLERGY_SEVERITY_LABEL[allergy.severity]}
                        </span>
                      )}
                      {allergy.reaction && (
                        <span className={`${META_CLASS} break-words`}>{allergy.reaction}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h4 className={SUBHEAD_CLASS}>病史／慢性疾病</h4>
              {personal.profile.conditions.length === 0 ? (
                <Empty>尚未記錄病史</Empty>
              ) : (
                <ul className={LIST_CLASS}>
                  {personal.profile.conditions.map(condition => (
                    <li key={condition.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                      <span className={NAME_CLASS}>{condition.name}</span>
                      {condition.sinceYear !== undefined && (
                        <span className={META_CLASS}>{`自 ${condition.sinceYear} 年`}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Block>

        <Block
          title="目前用藥（推估）"
          note={`依健保處方推估（最近一次就診前 ${RECENT_WINDOW_DAYS} 天內開立過）；實際用藥請與醫師、藥師確認`}
        >
          {medications.length === 0 ? (
            <Empty>{`近 ${RECENT_WINDOW_DAYS} 天沒有健保處方紀錄`}</Empty>
          ) : (
            <>
              <ul className={LIST_CLASS}>
                {medications.slice(0, LIMITS.medications).map(medication => (
                  <li key={medication.code} className="py-2">
                    <p className={NAME_CLASS}>
                      {medication.name || medication.code}
                      {medication.name && medication.name !== medication.code && (
                        <span className={`ml-2 font-mono ${META_CLASS}`}>{medication.code}</span>
                      )}
                    </p>
                    <p className={`flex flex-wrap gap-x-3 ${META_CLASS}`}>
                      <span>最近開立 <span className="font-mono">{day(medication.lastDate)}</span></span>
                      <span>{`近 ${RECENT_WINDOW_DAYS} 天 ${medication.recentCount} 次`}</span>
                    </p>
                  </li>
                ))}
              </ul>
              <More total={medications.length} shown={LIMITS.medications} />
            </>
          )}
        </Block>

        <Block
          title="領藥進度"
          note={refills.length > 0 ? `領藥時間由處方開立日推估，僅供提醒，非醫囑；${REFILL_DISCLAIMER}。` : undefined}
        >
          {refills.length === 0 ? (
            <Empty>沒有連續處方的領藥計畫</Empty>
          ) : (
            <>
              <ul className={LIST_CLASS}>
                {refills.slice(0, LIMITS.refills).map(({ plan, status }) => (
                  <li key={plan.id} className="py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className={NAME_CLASS}>{plan.drugName}</span>
                      <span className={`badge ${STATE_BADGE[status.state]}`}>{status.label}</span>
                    </div>
                    <p className={META_CLASS}>
                      {[plan.hospital, describeRefillTiming(status), `已領 ${plan.taken}/${plan.fills} 次`]
                        .filter(Boolean)
                        .join(' · ')}
                    </p>
                  </li>
                ))}
              </ul>
              <More total={refills.length} shown={LIMITS.refills} />
            </>
          )}
        </Block>

        <Block title="異常檢驗" wide>
          {abnormal.length === 0 ? (
            <Empty>{labSummaries.length === 0 ? '尚無檢驗資料' : '最新一次檢驗沒有偏高或偏低的項目'}</Empty>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <caption className="sr-only">最新一次檢驗偏高或偏低的項目</caption>
                  <thead>
                    <tr className={HEAD_ROW_CLASS}>
                      <th scope="col" className="py-2 pr-3 font-medium">項目</th>
                      <th scope="col" className="py-2 pr-3 font-medium">最新值</th>
                      <th scope="col" className="py-2 pr-3 font-medium">前次</th>
                      <th scope="col" className="py-2 pr-3 font-medium">狀態</th>
                      <th scope="col" className="py-2 pr-3 font-medium">參考</th>
                      <th scope="col" className="py-2 font-medium">日期</th>
                    </tr>
                  </thead>
                  <tbody className={LIST_CLASS}>
                    {abnormal.slice(0, LIMITS.abnormal).map(summary => {
                      const meta = summary.status === 'high' ? ABNORMAL_META.high : ABNORMAL_META.low;
                      return (
                        <tr key={summary.key}>
                          <th scope="row" className="py-2 pr-3 text-left font-medium text-gray-800 dark:text-gray-100 break-words">
                            {summary.subItem}
                          </th>
                          <td className={`py-2 pr-3 font-mono tabular-nums font-semibold ${meta.value}`}>
                            {formatLabValue(summary.latestValue)}
                            {summary.unit && (
                              <span className={`ml-1 font-sans font-normal ${META_CLASS}`}>{summary.unit}</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono tabular-nums text-gray-600 dark:text-gray-300">
                            {summary.previousValue === null ? DASH : formatLabValue(summary.previousValue)}
                          </td>
                          <td className="py-2 pr-3">
                            <span className={`badge ${meta.badge}`}>{meta.label}</span>
                            {summary.worsening && (
                              <span className="ml-2 text-xs text-red-600 dark:text-red-400">較上次惡化</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 text-xs text-gray-600 dark:text-gray-300">
                            {labReference(summary) + (summary.targetApplied ? '（個人目標）' : '')}
                          </td>
                          <td className={`py-2 font-mono ${META_CLASS}`}>{day(summary.latestDate)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <More total={abnormal.length} shown={LIMITS.abnormal} />
            </>
          )}
        </Block>

        <Block title="自我量測">
          {measurementRows.length === 0 ? (
            <Empty>尚無自我量測紀錄</Empty>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">自我量測摘要</caption>
                <thead>
                  <tr className={HEAD_ROW_CLASS}>
                    <th scope="col" className="py-2 pr-3 font-medium">項目</th>
                    <th scope="col" className="py-2 pr-3 font-medium">最近一次</th>
                    <th scope="col" className="py-2 pr-3 font-medium">7 天平均</th>
                    <th scope="col" className="py-2 font-medium">30 天平均</th>
                  </tr>
                </thead>
                <tbody className={LIST_CLASS}>
                  {measurementRows.map(row => (
                    <tr key={row.kind}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-gray-800 dark:text-gray-100">
                        {`${MEASUREMENT_KIND_LABEL[row.kind]}（${MEASUREMENT_UNIT[row.kind]}）`}
                      </th>
                      <td className="py-2 pr-3">
                        <span className="font-mono tabular-nums font-semibold text-gray-800 dark:text-gray-100">
                          {row.latestValue}
                        </span>
                        {row.latestMoment && (
                          <span className={`block font-mono ${META_CLASS}`}>{row.latestMoment}</span>
                        )}
                      </td>
                      <td className="py-2 pr-3 font-mono tabular-nums text-gray-700 dark:text-gray-200">{row.avg7}</td>
                      <td className="py-2 font-mono tabular-nums text-gray-700 dark:text-gray-200">{row.avg30}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Block>

        <Block title="主要診斷">
          {diagnoses.length === 0 ? (
            <Empty>尚無門診診斷紀錄</Empty>
          ) : (
            <>
              <ul className={LIST_CLASS}>
                {diagnoses.slice(0, LIMITS.diagnoses).map(group => (
                  <li key={group.root} className="py-2">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="badge font-mono bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">
                        {group.root}
                      </span>
                      <span className={NAME_CLASS}>{group.name}</span>
                    </div>
                    <p className={`flex flex-wrap gap-x-3 ${META_CLASS}`}>
                      <span>{`${group.visitCount} 次就診`}</span>
                      <span>最近 <span className="font-mono">{day(group.lastDate)}</span></span>
                    </p>
                  </li>
                ))}
              </ul>
              <More total={diagnoses.length} shown={LIMITS.diagnoses} />
            </>
          )}
        </Block>

        <Block title="近期門診">
          {recentVisits.length === 0 ? (
            <Empty>尚無門診紀錄</Empty>
          ) : (
            <>
              <ul className={LIST_CLASS}>
                {recentVisits.slice(0, LIMITS.visits).map((visit, index) => (
                  <li key={`${formatLocalDate(visit.date)}-${index}`} className="py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`font-mono ${META_CLASS}`}>{formatLocalDate(visit.date)}</span>
                      <span className={NAME_CLASS}>{visit.hospital || '院所未提供'}</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300 break-words">
                      {diagnosisNames(visit.diagnoses) || '診斷未提供'}
                    </p>
                  </li>
                ))}
              </ul>
              <More total={recentVisits.length} shown={LIMITS.visits} />
            </>
          )}
        </Block>

        <Block title="近期住院">
          {recentStays.length === 0 ? (
            <Empty>尚無住院紀錄</Empty>
          ) : (
            <>
              <ul className={LIST_CLASS}>
                {recentStays.slice(0, LIMITS.stays).map((stay, index) => (
                  <li key={`${formatLocalDate(stay.admitDate)}-${index}`} className="py-2">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className={`font-mono ${META_CLASS}`}>
                        {`${formatLocalDate(stay.admitDate)} ~ ${day(stay.dischargeDate)}`}
                      </span>
                      <span className={NAME_CLASS}>{stay.hospital || '院所未提供'}</span>
                    </div>
                    <p className="text-xs text-gray-600 dark:text-gray-300 break-words">
                      {diagnosisNames(stay.diagnoses) || '診斷未提供'}
                    </p>
                  </li>
                ))}
              </ul>
              <More total={recentStays.length} shown={LIMITS.stays} />
            </>
          )}
        </Block>
      </div>

      <p className="text-xs text-gray-500 dark:text-gray-400 print:break-inside-avoid">
        本摘要由匯入的健保資料與自行輸入的紀錄整理而成，僅供看診參考，不能取代醫師診斷。
      </p>
    </section>
  );
}
