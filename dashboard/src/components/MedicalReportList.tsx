import { useMemo, useState } from 'react';
import type { MedicalReport } from '../parsers/types';
import { clinicalDate, clinicalDateTime, keyedRecords, originLabel, recordIdentity } from '../lib/clinicalRecords';
import ClinicalRecordDetails from './ClinicalRecordDetails';
import MedicalAttachmentItem, { type AttachmentLoader } from './MedicalAttachmentItem';

interface Props {
  reports: MedicalReport[];
  loadAttachment?: AttachmentLoader;
}

export default function MedicalReportList({ reports, loadAttachment }: Props) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => keyedRecords([...reports].sort((a, b) => clinicalDateTime(b.date) - clinicalDateTime(a.date)), recordIdentity), [reports]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter(({ record }) => [record.title, record.text, record.hospital, record.id,
    ...record.relatedResources, ...(record.origins ?? []).map(originLabel), ...record.attachments.map(attachment => attachment.title)]
    .some(value => value.toLocaleLowerCase().includes(normalizedQuery)));
  return (
    <section className="card" aria-label="醫療報告與影像">
      <h2 className="section-title mb-2">醫療報告與影像</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        僅使用匯入檔案內可取得的附件；點選預覽或下載後才讀取附件。
        JPG／PNG／WebP 為影像預覽，不是原始 DICOM；PDF 僅提供下載。
        外部附件網址不會連線或下載。
      </p>
      <input className="input w-full mb-4" aria-label="搜尋醫療報告" placeholder="搜尋報告、院所或資源 ID"
        value={query} onChange={event => setQuery(event.target.value)} />
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-3" role="status">顯示 {filtered.length} / {reports.length} 份報告</p>
      {filtered.length === 0 ? <p className="text-sm text-gray-500 dark:text-gray-400">{reports.length === 0 ? '尚無醫療報告' : '沒有符合條件的醫療報告'}</p> : (
        <div className="space-y-4">
          {filtered.map(({ key, record: report }) => (
            <article key={key} aria-label={report.title || '未命名報告'} className="min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
              <div className="flex flex-wrap gap-x-3 gap-y-1 items-center mb-2">
                <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">{report.title || '未命名報告'}</h3>
                <span className="text-sm text-gray-500 dark:text-gray-400">{clinicalDate(report.date)} · {report.hospital || '院所未提供'}</span>
              </div>
              {report.text && <p className="text-sm whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{report.text}</p>}
              {report.externalAttachmentCount > 0 && <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">另有 {report.externalAttachmentCount} 個外部附件，未取得且不會自動下載。</p>}
              {report.attachments.length > 0 && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {keyedRecords(report.attachments, attachment => JSON.stringify([attachment.id, attachment.contentType, attachment.title, attachment.data])).map(({ key: attachmentKey, record: attachment }) => (
                    <MedicalAttachmentItem key={attachmentKey} attachment={attachment} loadAttachment={loadAttachment} ownerIdentity={key} />
                  ))}
                </div>
              )}
              <ClinicalRecordDetails id={report.id} origins={report.origins} relatedResources={report.relatedResources} rawResource={report.rawResource} />
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
