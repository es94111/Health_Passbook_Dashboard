import { useMemo, useState } from 'react';
import type { MedicationRecord } from '../parsers/types';
import { clinicalDate, clinicalDateTime, keyedRecords, originLabel, recordIdentity } from '../lib/clinicalRecords';
import ClinicalRecordDetails from './ClinicalRecordDetails';

const CATEGORIES: MedicationRecord['category'][] = ['處方', '領藥', '用藥紀錄'];

export default function MedicationList({ medications }: { medications: MedicationRecord[] }) {
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
