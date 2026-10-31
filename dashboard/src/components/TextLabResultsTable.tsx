import type { TextLabResult } from '../parsers/types';
import { clinicalDate, clinicalDateTime, keyedRecords } from '../lib/clinicalRecords';
import { labReadingKey, labSource } from '../lib/clinicalLabSeries';
import { RecordOrigins } from './ClinicalRecordDetails';

export default function TextLabResultsTable({ records }: { records: TextLabResult[] }) {
  const sorted = [...records].sort((a, b) => clinicalDateTime(b.date) - clinicalDateTime(a.date));
  return (
    <section className="mt-5" aria-label="文字／定性檢驗結果">
      <h3 className="text-base font-semibold text-gray-800 dark:text-gray-100 mb-1">文字／定性檢驗結果</h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">保留原始文字、比較符號與定性結果，不轉換為數值或加入趨勢圖。</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left text-gray-700 dark:text-gray-300">
          <caption className="sr-only">文字與定性檢驗逐筆紀錄</caption>
          <thead><tr className="border-b border-gray-200 dark:border-gray-700">
            {['日期', '檢驗項目', '結果', '單位', '參考值', '院所／來源'].map(heading => <th key={heading} scope="col" className="p-2.5 whitespace-nowrap font-medium">{heading}</th>)}
          </tr></thead>
          <tbody>{keyedRecords(sorted, labReadingKey).map(({ key, record }) => (
            <tr key={key} className="border-b border-gray-100 dark:border-gray-700/60 align-top">
              <td className="p-2.5 whitespace-nowrap font-mono text-xs">{clinicalDate(record.date)}</td>
              <td className="p-2.5 min-w-32 break-words">{record.subItem}<span className="block text-xs text-gray-500 dark:text-gray-400">{record.testGroup}</span></td>
              <td className="p-2.5 whitespace-pre-wrap break-words min-w-32 font-mono">{record.text}</td>
              <td className="p-2.5 font-mono text-xs">{record.unit || '未提供'}</td>
              <td className="p-2.5 whitespace-pre-wrap break-words">{record.refText || '未提供'}</td>
              <td className="p-2.5 min-w-40 break-all">
                <p>{record.hospital || '院所未提供'} · {labSource(record) || '來源未提供'}</p>
                <RecordOrigins origins={record.origins} />
              </td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}
