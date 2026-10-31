import { useMemo, useState } from 'react';
import type { MedicalReport } from '../parsers/types';
import { clinicalDate, clinicalDateTime, keyedRecords, originLabel, recordIdentity } from '../lib/clinicalRecords';
import ClinicalRecordDetails from './ClinicalRecordDetails';
import MedicalAttachmentItem, { type AttachmentLoader } from './MedicalAttachmentItem';

interface Props {
  reports: MedicalReport[];
  loadAttachment?: AttachmentLoader;
}

const STATUS_LABELS: Record<string, string> = {
  registered: '已登記',
  partial: '部分結果',
  preliminary: '初步報告',
  final: '已定稿',
  amended: '已修正',
  corrected: '已更正',
  appended: '已補充',
  cancelled: '已取消',
  'entered-in-error': '錯誤輸入',
  unknown: '狀態未知',
  available: '可取得',
  completed: '已完成',
  current: '目前有效',
  superseded: '已被取代',
};

const STATUS_STYLES: Record<string, string> = {
  final: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  available: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  completed: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-300',
  preliminary: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  partial: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  amended: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  corrected: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  appended: 'bg-amber-50 text-amber-700 dark:bg-amber-950/50 dark:text-amber-300',
  cancelled: 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  'entered-in-error': 'bg-red-50 text-red-700 dark:bg-red-950/50 dark:text-red-300',
  superseded: 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

export default function ImagingReportList({ reports, loadAttachment }: Props) {
  const [query, setQuery] = useState('');
  const [modality, setModality] = useState('');
  const items = useMemo(
    () => keyedRecords([...reports].sort((a, b) => clinicalDateTime(b.date) - clinicalDateTime(a.date)), recordIdentity),
    [reports],
  );
  const modalities = useMemo(
    () => [...new Set(items.flatMap(({ record }) => record.imaging?.modalities ?? []))].sort((a, b) => a.localeCompare(b, 'zh-TW')),
    [items],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = items.filter(({ record }) => {
    if (modality && !(record.imaging?.modalities ?? []).includes(modality)) return false;
    if (!normalizedQuery) return true;
    const imaging = record.imaging;
    return [
      record.title,
      record.text,
      record.hospital,
      record.id,
      ...record.relatedResources,
      ...(record.origins ?? []).map(originLabel),
      ...record.attachments.map(attachment => attachment.title),
      ...(imaging?.modalities ?? []),
      ...(imaging?.bodySites ?? []),
      imaging?.studyDescription ?? '',
      ...(imaging?.series ?? []).flatMap(series => [series.description, series.modality, series.bodySite]),
    ].some(value => value.toLocaleLowerCase().includes(normalizedQuery));
  });

  return (
    <section className="card" aria-label="影像報告">
      <h2 className="section-title mb-2">影像報告</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        彙整 ImagingStudy、影像類 DiagnosticReport、Media 與影像類 DocumentReference，顯示檢查類型、部位、系列與影像張數。
        僅使用匯入檔案內可取得的附件；JPG／PNG／WebP 為影像預覽，不是原始 DICOM；PDF 僅提供下載。外部附件網址不會連線或下載。
      </p>
      <input className="input w-full" aria-label="搜尋影像報告" placeholder="搜尋檢查類型、部位、系列、院所或資源 ID"
        value={query} onChange={event => setQuery(event.target.value)} />
      {modalities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="檢查類型篩選">
          <button type="button" aria-pressed={modality === ''} onClick={() => setModality('')}
            className={`badge cursor-pointer border transition-colors ${modality === '' ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/50 dark:text-teal-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'}`}>
            全部
          </button>
          {modalities.map(item => (
            <button key={item} type="button" aria-pressed={modality === item} onClick={() => setModality(item)}
              className={`badge cursor-pointer border transition-colors ${modality === item ? 'border-teal-500 bg-teal-50 text-teal-700 dark:border-teal-500 dark:bg-teal-950/50 dark:text-teal-300' : 'border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700'}`}>
              {item}
            </button>
          ))}
        </div>
      )}
      <p className="mt-3 mb-3 text-xs text-gray-500 dark:text-gray-400" role="status">
        顯示 {filtered.length} / {reports.length} 份影像報告
      </p>
      {filtered.length === 0 ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {reports.length === 0 ? '尚無影像報告' : '沒有符合條件的影像報告'}
        </p>
      ) : (
        <div className="space-y-4">
          {filtered.map(({ key, record: report }) => {
            const imaging = report.imaging;
            const status = imaging?.status ?? '';
            const modalities = imaging?.modalities ?? [];
            const bodySites = imaging?.bodySites ?? [];
            const series = imaging?.series ?? [];
            const instanceCount = imaging?.instanceCount ?? 0;
            return (
              <article key={key} aria-label={report.title || '未命名影像報告'} className="min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-medium text-gray-900 dark:text-gray-100 break-words">{report.title || '未命名影像報告'}</h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">{clinicalDate(report.date)} · {report.hospital || '院所未提供'}</p>
                  </div>
                  {status && (
                    <span className={`badge ${STATUS_STYLES[status] || 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'}`}>
                      {statusLabel(status)}
                    </span>
                  )}
                </div>
                {modalities.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {modalities.map(item => (
                      <span key={item} className="badge bg-teal-50 text-teal-700 dark:bg-teal-950/50 dark:text-teal-300">{item}</span>
                    ))}
                  </div>
                )}
                {report.text && <p className="mt-3 text-sm whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{report.text}</p>}
                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-xs text-gray-500 dark:text-gray-400">檢查部位</dt>
                    <dd className="break-words text-gray-800 dark:text-gray-200">{bodySites.length > 0 ? bodySites.join('、') : '未提供'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500 dark:text-gray-400">系列與影像</dt>
                    <dd className="text-gray-800 dark:text-gray-200">{series.length} 系列 · {instanceCount > 0 ? `${instanceCount} 張` : '張數未提供'}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-gray-500 dark:text-gray-400">檢查描述</dt>
                    <dd className="break-words text-gray-800 dark:text-gray-200">{imaging?.studyDescription || '未提供'}</dd>
                  </div>
                </dl>
                {series.length > 0 && (
                  <div className="mt-3">
                    <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400">系列明細</h4>
                    <ul className="mt-1 divide-y divide-gray-100 dark:divide-gray-700">
                      {series.map(item => (
                        <li key={`${item.number}-${item.modality}-${item.description}-${item.bodySite}`} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5 text-sm">
                          <span className="font-mono text-xs text-gray-400 dark:text-gray-500">#{item.number}</span>
                          <span className="font-medium text-gray-800 dark:text-gray-200">{item.description || '未命名系列'}</span>
                          {item.modality && <span className="text-gray-600 dark:text-gray-400">{item.modality}</span>}
                          {item.bodySite && <span className="text-gray-500 dark:text-gray-400">{item.bodySite}</span>}
                          <span className="ml-auto text-xs text-gray-500 dark:text-gray-400">{item.instances > 0 ? `${item.instances} 張` : '張數未提供'}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {report.externalAttachmentCount > 0 && (
                  <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">另有 {report.externalAttachmentCount} 個外部附件，未取得且不會自動下載。</p>
                )}
                {report.attachments.length > 0 && (
                  <div className="mt-3">
                    <h4 className="text-xs font-medium text-gray-500 dark:text-gray-400">報告與影像附件（{report.attachments.length}）</h4>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      {keyedRecords(report.attachments, attachment => JSON.stringify([attachment.id, attachment.contentType, attachment.title, attachment.data])).map(({ key: attachmentKey, record: attachment }) => (
                        <MedicalAttachmentItem key={attachmentKey} attachment={attachment} loadAttachment={loadAttachment} ownerIdentity={key} />
                      ))}
                    </div>
                  </div>
                )}
                <ClinicalRecordDetails id={report.id} origins={report.origins} relatedResources={report.relatedResources} rawResource={report.rawResource} />
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
