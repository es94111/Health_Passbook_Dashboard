import type { MedicationRecord } from '../parsers/types';

export default function MedicationList({ medications }: { medications: MedicationRecord[] }) {
  const sorted = [...medications].sort((a, b) => b.date.getTime() - a.date.getTime());
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">FHIR 用藥紀錄</h2>
      <p className="text-sm text-gray-500 mb-3">依 Bridge 匯出的 MedicationRequest／MedicationStatement／MedicationDispense 呈現，不等同目前實際服藥清單。</p>
      {sorted.length === 0 ? <p className="text-gray-500 text-sm">尚無 FHIR 用藥資料</p> : (
        <div className="space-y-2">
          {sorted.map((m, i) => (
            <article key={i} className="border border-gray-200 dark:border-gray-700 rounded-lg p-3">
              <div className="font-medium text-gray-900 dark:text-gray-100">{m.name}</div>
              <div className="text-sm text-gray-500">{m.date.toLocaleDateString('zh-TW')} · {m.hospital} · {m.source}</div>
              {m.dosage && <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 whitespace-pre-wrap">{m.dosage}</p>}
              {m.status && <p className="text-xs text-gray-500 mt-1">狀態：{m.status}</p>}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
