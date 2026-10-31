import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { MedicalAttachment } from '../parsers/types';

export type AttachmentLoader = (attachment: MedicalAttachment) => Promise<Blob>;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp', 'application/pdf': '.pdf',
};

interface AttachmentContext {
  attachment: MedicalAttachment;
  loadAttachment?: AttachmentLoader;
  ownerIdentity: string;
}

interface AttachmentScope {
  context: AttachmentContext;
  previewUrl: string | null;
  downloadUrls: Map<string, ReturnType<typeof setTimeout>>;
}

interface ActionState {
  context: AttachmentContext;
  status: 'loading' | 'ready' | 'error';
  url?: string;
}

async function attachmentBlob(attachment: MedicalAttachment, loadAttachment?: AttachmentLoader): Promise<Blob> {
  if (!Object.hasOwn(EXTENSIONS, attachment.contentType)) throw new Error('unsupported');
  let blob: Blob;
  if (attachment.id) {
    if (!loadAttachment) throw new Error('unavailable');
    blob = await loadAttachment(attachment);
  } else {
    if (!attachment.data) throw new Error('unavailable');
    const bytes = Uint8Array.from(atob(attachment.data), character => character.charCodeAt(0));
    blob = new Blob([bytes], { type: attachment.contentType });
  }
  if (!(blob instanceof Blob) || blob.type.toLowerCase() !== attachment.contentType) throw new Error('unsupported');
  return blob;
}

function releasePreview(scope: AttachmentScope) {
  if (scope.previewUrl) URL.revokeObjectURL(scope.previewUrl);
  scope.previewUrl = null;
}

export default function MedicalAttachmentItem({ attachment, loadAttachment, ownerIdentity }: {
  attachment: MedicalAttachment;
  loadAttachment?: AttachmentLoader;
  ownerIdentity: string;
}) {
  const context = useMemo<AttachmentContext>(() => ({ attachment, loadAttachment, ownerIdentity }),
    [attachment, loadAttachment, ownerIdentity]);
  const scopeRef = useRef<AttachmentScope | null>(null);
  const [previewState, setPreviewState] = useState<ActionState | null>(null);
  const [downloadState, setDownloadState] = useState<ActionState | null>(null);
  const preview = previewState?.context === context ? previewState : null;
  const download = downloadState?.context === context ? downloadState : null;
  const supported = Object.hasOwn(EXTENSIONS, attachment.contentType);
  const image = supported && attachment.contentType !== 'application/pdf';
  const available = supported && (attachment.id ? Boolean(loadAttachment) : Boolean(attachment.data));
  const previewLabel = preview?.status === 'loading' ? '圖片載入中…' : preview?.status === 'ready' ? '隱藏預覽'
    : preview?.status === 'error' ? '重試預覽' : '預覽圖片';
  const downloadLabel = download?.status === 'loading' ? '下載準備中…' : download?.status === 'error' ? '重試下載'
    : `下載${image ? '圖片' : ' PDF'}`;

  useLayoutEffect(() => {
    const scope: AttachmentScope = { context, previewUrl: null, downloadUrls: new Map() };
    scopeRef.current = scope;
    return () => {
      scopeRef.current = null;
      releasePreview(scope);
      for (const [url, timer] of scope.downloadUrls) {
        clearTimeout(timer);
        URL.revokeObjectURL(url);
      }
      scope.downloadUrls.clear();
    };
  }, [context]);

  async function previewImage() {
    const scope = scopeRef.current;
    if (!scope || scope.context !== context) return;
    if (preview?.status === 'ready') {
      releasePreview(scope);
      setPreviewState(null);
      return;
    }
    setPreviewState({ context, status: 'loading' });
    try {
      const blob = await attachmentBlob(attachment, loadAttachment);
      if (scopeRef.current !== scope) return;
      releasePreview(scope);
      const url = URL.createObjectURL(blob);
      scope.previewUrl = url;
      setPreviewState({ context, status: 'ready', url });
    } catch {
      if (scopeRef.current === scope) setPreviewState({ context, status: 'error' });
    }
  }

  async function downloadAttachment() {
    const scope = scopeRef.current;
    if (!scope || scope.context !== context) return;
    setDownloadState({ context, status: 'loading' });
    try {
      const blob = await attachmentBlob(attachment, loadAttachment);
      if (scopeRef.current !== scope) return;
      const url = URL.createObjectURL(blob);
      const timer = setTimeout(() => {
        URL.revokeObjectURL(url);
        scope.downloadUrls.delete(url);
      }, 1000);
      scope.downloadUrls.set(url, timer);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `medical-attachment${EXTENSIONS[attachment.contentType]}`;
      document.body.appendChild(anchor);
      try { anchor.click(); } finally { anchor.remove(); }
      setDownloadState({ context, status: 'ready' });
    } catch {
      if (scopeRef.current === scope) setDownloadState({ context, status: 'error' });
    }
  }

  return (
    <div className="min-w-0 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
      <p className="text-sm font-medium text-gray-800 dark:text-gray-100 break-words">{attachment.title || '未命名附件'}</p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400 font-mono">
        {attachment.contentType}{attachment.size !== undefined && ` · ${attachment.size.toLocaleString()} bytes`}
      </p>
      {!supported ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-400">不支援此附件格式，不會載入。</p>
        : !available ? <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">此附件無可用的本機資料。</p> : (
          <div className="mt-3 flex flex-wrap gap-2">
            {image && (
              <button type="button" className="btn-secondary" disabled={preview?.status === 'loading'}
                aria-busy={preview?.status === 'loading'} aria-label={`${attachment.title || '未命名附件'}：${previewLabel}`}
                onClick={() => void previewImage()}>
                {previewLabel}
              </button>
            )}
            <button type="button" className="btn-secondary" disabled={download?.status === 'loading'}
              aria-busy={download?.status === 'loading'} aria-label={`${attachment.title || '未命名附件'}：${downloadLabel}`}
              onClick={() => void downloadAttachment()}>
              {downloadLabel}
            </button>
          </div>
        )}
      {preview?.status === 'error' && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">無法預覽此附件，請重試或重新匯入來源檔案。</p>}
      {download?.status === 'error' && <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">無法下載此附件，請重試或重新匯入來源檔案。</p>}
      {download?.status === 'ready' && <p role="status" className="mt-2 text-xs text-gray-500 dark:text-gray-400">已準備附件下載。</p>}
      {image && preview?.status === 'ready' && preview.url && (
        <img src={preview.url} alt={attachment.title || '醫療影像預覽'}
          className="mt-3 max-h-80 w-full rounded bg-gray-50 dark:bg-gray-900 object-contain"
          onError={() => {
            const scope = scopeRef.current;
            if (!scope || scope.context !== context || scope.previewUrl !== preview.url) return;
            releasePreview(scope);
            setPreviewState({ context, status: 'error' });
          }} />
      )}
    </div>
  );
}
