import { useMemo, useState } from 'react';
import type { MedicationRecord, Visit } from '../parsers/types';
import { clinicalDate, clinicalDateTime, keyedRecords, originLabel, recordIdentity } from '../lib/clinicalRecords';
import { RECENT_WINDOW_DAYS, computeAllMedicationSummaries, formatDay, type MedicationSummary } from '../lib/keySummary';
import ClinicalRecordDetails from './ClinicalRecordDetails';

const CATEGORIES: MedicationRecord['category'][] = ['處方', '領藥', '用藥紀錄'];

function FhirMedicationSection({ medications }: { medications: MedicationRecord[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const items = useMemo(() => keyedRecords([...medications].sort((a, b) => clinicalDateTime(b.date) - clinicalDateTime(a.date)), recordIdentity), [medications]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter(({ record }) => (!category || record.category === category)
    && [record.name, record.dosage, record.hospital, record.source, record.status, record.id, ...(record.origins ?? []).map(originLabel)]
      .some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
  return (
    <section className="card" aria-label="用藥紀錄">
      <h2 className="section-title mb-2">用藥紀錄</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">依 Bridge 匯出的處方、領藥與用藥紀錄分別呈現；歷史紀錄與原始狀態不等同目前實際服藥清單，請勿據此自行調整用藥。</p>
      <div className="flex flex-col sm:flex-row gap-3 mb-3">
        <input className="input flex-1 min-w-0" aria-label="搜尋用藥紀錄" placeholder="搜尋藥品、用法或院所"
          value={query} onChange={event => setQuery(event.target.value)} />
        <select className="input" aria-label="用藥紀錄類型" value={category} onChange={event => setCategory(event.target.value)}>
          <option value="">全部類型</option>
          {CATEGORIES.map(value => <option key={value} value={value}>{value}</option>)}
        </select>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3" role="status">顯示 {filtered.length} / {medications.length} 筆紀錄</p>
      {filtered.length === 0 ? <p className="text-gray-500 dark:text-gray-400 text-sm">{medications.length === 0 ? '尚無用藥資料' : '沒有符合條件的用藥紀錄'}</p> : (
        <div className="space-y-3">
          {filtered.map(({ key, record: medication }) => (
            <article key={key} aria-label={medication.name || '未命名藥品'} className="min-w-0 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">{medication.name || '未命名藥品'}</h3>
                <span className="badge bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">{medication.category}</span>
              </div>
              <div className="mt-1 text-sm text-gray-500 dark:text-gray-400 break-words">{clinicalDate(medication.date)} · {medication.hospital || '院所未提供'} · {medication.source}</div>
              {medication.dosage && <p className="text-sm text-gray-700 dark:text-gray-300 mt-2 whitespace-pre-wrap break-words">{medication.dosage}</p>}
              {medication.status && <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">原始狀態：{medication.status}</p>}
              <ClinicalRecordDetails id={medication.id} origins={medication.origins} rawResource={medication.rawResource} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function NhiMedicationSection({ drugs }: { drugs: MedicationSummary[] }) {
  const [query, setQuery] = useState('');
  const [recentOnly, setRecentOnly] = useState(false);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = drugs.filter(drug => (!recentOnly || drug.recentCount > 0)
    && `${drug.name} ${drug.code}`.toLocaleLowerCase().includes(normalizedQuery));
  return (
    <section className="card" aria-label="健保醫令用藥（推估）">
      <h2 className="section-title mb-2">健保醫令用藥（推估）</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">由門診醫令的藥品代碼彙整，僅代表曾被開立，無法確認實際領藥、用法與用藥天數；是否仍在服用請以醫師、藥師為準。</p>
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 mb-3">
        <input className="input flex-1 min-w-0" aria-label="搜尋健保醫令用藥" placeholder="搜尋藥名或藥品代碼"
          value={query} onChange={event => setQuery(event.target.value)} />
        <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
          <span className="relative flex items-center">
            <input type="checkbox" checked={recentOnly} onChange={event => setRecentOnly(event.target.checked)} className="sr-only peer" />
            <div className="w-8 h-4 bg-gray-200 dark:bg-gray-700 rounded-full peer-checked:bg-teal-600 peer-focus-visible:ring-2 peer-focus-visible:ring-teal-400 transition-colors" />
            <div className="absolute left-0.5 top-0.5 w-3 h-3 bg-white rounded-full shadow peer-checked:translate-x-4 transition-transform" />
          </span>
          <span className="text-xs text-gray-500 dark:text-gray-400">僅顯示近 {RECENT_WINDOW_DAYS} 天有開立的藥品（以資料最新就診日計）</span>
        </label>
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3" role="status">顯示 {filtered.length} / {drugs.length} 種藥品</p>
      {filtered.length === 0 ? <p className="text-gray-500 dark:text-gray-400 text-sm">沒有符合條件的藥品</p> : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left text-gray-700 dark:text-gray-300">
            <caption className="sr-only">健保醫令用藥彙整</caption>
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-700">
                <th scope="col" className="p-2.5 whitespace-nowrap font-medium">藥品</th>
                <th scope="col" className="p-2.5 whitespace-nowrap font-medium">最近開立</th>
                <th scope="col" className="p-2.5 whitespace-nowrap font-medium">開立次數</th>
                <th scope="col" className="p-2.5 whitespace-nowrap font-medium">近 {RECENT_WINDOW_DAYS} 天</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(drug => (
                <tr key={drug.code} className="border-b border-gray-100 dark:border-gray-700/60 align-top">
                  <th scope="row" className="p-2.5 font-normal text-left break-words">
                    <span className="text-gray-900 dark:text-gray-100">{drug.name}</span>
                    <span className="block font-mono text-xs text-gray-500 dark:text-gray-400">{drug.code}</span>
                  </th>
                  <td className="p-2.5 font-mono whitespace-nowrap">{formatDay(drug.lastDate)}</td>
                  <td className="p-2.5 font-mono">{drug.count}</td>
                  <td className={`p-2.5 font-mono ${drug.recentCount > 0 ? '' : 'text-gray-400 dark:text-gray-500'}`}>{drug.recentCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function MedicationList({ medications, visits }: { medications: MedicationRecord[]; visits?: Visit[] }) {
  const nhiDrugs = useMemo(() => (visits ? computeAllMedicationSummaries(visits) : []), [visits]);
  return (
    <div className="space-y-6">
      {nhiDrugs.length > 0 && <NhiMedicationSection drugs={nhiDrugs} />}
      {(medications.length > 0 || nhiDrugs.length === 0) && <FhirMedicationSection medications={medications} />}
    </div>
  );
}
