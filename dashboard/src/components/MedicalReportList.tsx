import { useState } from 'react';
import type { MedicalAttachment, MedicalReport } from '../parsers/types';

interface Props { reports: MedicalReport[] }

function saveAttachment(attachment: MedicalAttachment): void {
  const bytes = atob(attachment.data);
  const buffer = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) buffer[i] = bytes.charCodeAt(i);
  const blob = new Blob([buffer], { type: attachment.contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const extension = attachment.contentType === 'application/pdf' ? '.pdf' :
    attachment.contentType === 'image/png' ? '.png' :
    attachment.contentType === 'image/webp' ? '.webp' : '.jpg';
  a.download = 'medical-attachment' + extension;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export default function MedicalReportList({ reports }: Props) {
  const [query, setQuery] = useState('');
  const sorted = [...reports].sort((a, b) => b.date.getTime() - a.date.getTime());
  const filtered = sorted.filter(r => [r.title, r.text, r.hospital]
    .some(v => v.toLocaleLowerCase().includes(query.toLocaleLowerCase())));
  return (
    <section className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <h2 className="font-semibold text-gray-900 dark:text-gray-100 mb-2">醫療報告與影像</h2>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-3">
        僅顯示 FHIR 匯出檔內已有的附件；Bridge 提供的 JPG 為預覽圖，不是原始 DICOM。
        外部附件網址不會自動連線或下載。
      </p>
      <input className="input w-full mb-4" aria-label="搜尋醫療報告" placeholder="搜尋報告或院所"
        value={query} onChange={e => setQuery(e.target.value)} />
      {filtered.length === 0 ? <p className="text-sm text-gray-500">沒有符合條件的醫療報告</p> : (
        <div className="space-y-3">
          {filtered.map((r, index) => (
            <article key={index} className="rounded-lg border border-gray-200 dark:border-gray-700 p-3">
              <div className="flex flex-wrap gap-x-3 gap-y-1 items-center mb-2">
                <h3 className="font-medium text-gray-900 dark:text-gray-100">{r.title}</h3>
                <span className="text-sm text-gray-500">{r.date.toLocaleDateString('zh-TW')} · {r.hospital}</span>
              </div>
              {r.text && <p className="text-sm whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">{r.text}</p>}
              {r.attachments.length > 0 && (
                <div className="mt-3 grid gap-3 md:grid-cols-2">
                  {r.attachments.map((attachment, i) => (
                    <div key={i} className="border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                      <p className="text-xs text-gray-500 mb-2 break-words">{attachment.title}</p>
                      {attachment.contentType.startsWith('image/') &&
                        <img className="max-h-80 w-full object-contain bg-gray-50 dark:bg-gray-900 rounded"
                          src={`data:${attachment.contentType};base64,${attachment.data}`} loading="lazy"
                          alt={attachment.title} />}
                      <button type="button" className="text-sm text-teal-700 dark:text-teal-400 underline mt-2"
                        onClick={() => saveAttachment(attachment)}>
                        下載{attachment.contentType === 'application/pdf' ? ' PDF' : '圖片'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
