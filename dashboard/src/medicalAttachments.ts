import type { MedicalAttachment } from './parsers/types';
import { array, object, sha256, string } from './parsers/fhir-common';

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
export const MAX_ATTACHMENTS = 512;
/** Largest record index stored inline in one manifest envelope; larger indexes are sharded. */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024;
/** Largest single file accepted by the two-pass streaming import. */
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024 * 1024;
/** Raw source is uploaded as independently encrypted 8 MiB chunks. */
export const SOURCE_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_SOURCE_CHUNKS = 2048;
/** The merged record index is stored as independently encrypted shards of this size. */
export const RECORD_SHARD_BYTES = 8 * 1024 * 1024;
export const MAX_RECORD_SHARDS = 1024;
/** 8 GiB of normalized record text; the practical ceiling is the browser's memory. */
export const MAX_RECORD_BYTES = MAX_RECORD_SHARDS * RECORD_SHARD_BYTES;
/** Attachments (512) + source chunks (2048) + record shards (1024) share one reference list. */
export const MAX_ENVELOPE_ATTACHMENT_IDS = 4096;
export const SUPPORTED_ATTACHMENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface AttachmentMetadata {
  id: string;
  digest: string;
  contentType: MedicalAttachment['contentType'];
  size: number;
}

export interface PendingAttachment extends AttachmentMetadata {
  data: string;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  // Keep this linear: a nested-quantifier pattern overflows the stack on multi-megabyte payloads.
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error('附件 Base64 格式不正確，未儲存任何病歷變更');
  }
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((padding ? value.slice(0, -padding) : value).includes('=')) throw new Error('附件 Base64 格式不正確，未儲存任何病歷變更');
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (bytesToBase64(bytes) !== value) throw new Error('附件 Base64 編碼不正確');
  return bytes;
}

export function attachmentType(value: unknown): MedicalAttachment['contentType'] | null {
  const mime = string(value).toLowerCase().split(';')[0].trim();
  return SUPPORTED_ATTACHMENT_TYPES.includes(mime as MedicalAttachment['contentType']) ? mime as MedicalAttachment['contentType'] : null;
}

export function validateAttachmentBytes(bytes: Uint8Array, contentType: MedicalAttachment['contentType']): void {
  if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('單一附件必須介於 1 byte 與 12 MiB，請縮小匯出影像');
  const starts = (...signature: number[]) => signature.every((byte, i) => bytes[i] === byte);
  const valid = contentType === 'image/jpeg' ? starts(0xff, 0xd8, 0xff)
    : contentType === 'image/png' ? starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
      : contentType === 'image/webp' ? starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
        : starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (!valid) throw new Error('附件內容與宣告類型不符，已中止匯入');
}

export interface AttachmentSeparator {
  metadata: Record<string, AttachmentMetadata>;
  warnings: Set<string>;
  /** Separates one value at a time so a huge source file can be streamed. */
  separate(value: unknown): Promise<{ json: unknown; pending: PendingAttachment[] }>;
}

export function createAttachmentSeparator(existing: Record<string, AttachmentMetadata>): AttachmentSeparator {
  const metadata = { ...existing };
  const warnings = new Set<string>();
  const byDigest = new Map(Object.values(metadata).map(item => [`${item.contentType}:${item.digest}`, item]));
  const separate = async (value: unknown): Promise<{ json: unknown; pending: PendingAttachment[] }> => {
    const pending: PendingAttachment[] = [];
    const visit = async (input: unknown): Promise<unknown> => {
      if (Array.isArray(input)) return Promise.all(input.map(visit));
      if (input === null || typeof input !== 'object') return input;
      const inputObject = object(input);
      if (Object.keys(inputObject).some(key => key.startsWith('__vault'))) throw new Error('匯入檔含有保留的附件欄位，請使用原始 Bridge 匯出檔');
      const result = Object.fromEntries(await Promise.all(Object.entries(inputObject).map(async ([key, child]) => [key, await visit(child)])));
      const mime = attachmentType(inputObject.contentType);
      if (typeof inputObject.data === 'string' && inputObject.data.length && mime) {
        if (inputObject.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) throw new Error('單一附件超過 12 MiB 上限');
        const bytes = base64ToBytes(inputObject.data);
        validateAttachmentBytes(bytes, mime);
        if (Object.hasOwn(inputObject, 'size') && (!Number.isSafeInteger(inputObject.size) || inputObject.size !== bytes.length)) throw new Error('附件大小與宣告 size 不符');
        const digest = await sha256(bytes);
        let item = byDigest.get(`${mime}:${digest}`);
        if (!item) {
          if (Object.keys(metadata).length >= MAX_ATTACHMENTS) throw new Error('附件數量超過 512 個上限，既有資料未變更');
          item = { id: crypto.randomUUID(), digest, contentType: mime, size: bytes.length };
          byDigest.set(`${mime}:${digest}`, item);
          metadata[item.id] = item;
          pending.push({ ...item, data: inputObject.data });
        }
        delete result.data;
        result.__vaultAttachment = item.id;
        result.__vaultOriginalSize = Object.hasOwn(inputObject, 'size');
        result.size = bytes.length;
      } else if (typeof inputObject.data === 'string' && inputObject.contentType && !mime) {
        warnings.add('部分附件類型不支援預覽；原始內容仍保留於加密來源檔');
      }
      if (typeof inputObject.url === 'string' && /^(?:https?:|data:|file:|javascript:)/i.test(inputObject.url)) {
        warnings.add('外部附件未連線或下載；僅保留來源資訊');
      }
      return result;
    };
    return { json: await visit(value), pending };
  };
  return { metadata, warnings, separate };
}

export async function separateAttachments(
  json: object,
  existing: Record<string, AttachmentMetadata>,
): Promise<{ json: object; metadata: Record<string, AttachmentMetadata>; pending: PendingAttachment[]; warnings: string[] }> {
  const separator = createAttachmentSeparator(existing);
  const { json: separated, pending } = await separator.separate(json);
  return { json: separated as object, metadata: separator.metadata, pending, warnings: [...separator.warnings] };
}

export async function restoreAttachmentData(
  value: unknown,
  load: (id: string) => Promise<string>,
): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map(item => restoreAttachmentData(item, load)));
  if (value === null || typeof value !== 'object') return value;
  const input = object(value);
  const result = Object.fromEntries(await Promise.all(Object.entries(input)
    .filter(([key]) => key !== '__vaultAttachment')
    .map(async ([key, child]) => [key, await restoreAttachmentData(child, load)])));
  if (typeof input.__vaultAttachment === 'string') {
    result.data = await load(input.__vaultAttachment);
    if (input.__vaultOriginalSize === false) delete result.size;
  }
  delete result.__vaultOriginalSize;
  return result;
}

export function normalizeMedicalAttachment(value: unknown): MedicalAttachment | null {
  const attachment = object(value);
  const contentType = attachmentType(attachment.contentType);
  if (!contentType) return null;
  const id = string(attachment.__vaultAttachment);
  const data = string(attachment.data);
  if (id && !UUID_PATTERN.test(id)) return null;
  if (!id && !data) return null;
  if (data) {
    try {
      if (data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4) return null;
      validateAttachmentBytes(base64ToBytes(data), contentType);
    } catch { return null; }
  }
  return { id: id || undefined, title: string(attachment.title) || '醫療附件', contentType, data: data || undefined,
    size: typeof attachment.size === 'number' ? attachment.size : undefined };
}

export function countExternalAttachments(values: unknown[]): number {
  return array(values).filter(value => {
    const attachment = object(value);
    return string(attachment.url) && !string(attachment.__vaultAttachment) && !string(attachment.data);
  }).length;
}
