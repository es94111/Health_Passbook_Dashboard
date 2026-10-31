import { fetchEncryptedAttachment, type ClientEncryptedRecords } from './api';
import { decryptVaultBytes } from './cryptoVault';
import { base64ToBytes, bytesToBase64, restoreAttachmentData, validateAttachmentBytes } from './medicalAttachments';
import { parseNHIJson } from './parsers/nhi-parser';
import { canonicalJson, sha256 } from './parsers/fhir-common';
import { flattenRecords, type SourceChunk, type StoredRecords } from './recordStore';

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function createVaultSession(records: StoredRecords, envelope: ClientEncryptedRecords, key: CryptoKey) {
  const data = parseNHIJson(flattenRecords(records));
  const read = async (id: string): Promise<Uint8Array<ArrayBuffer>> => {
    const metadata = records.attachments[id];
    if (!metadata) throw new Error('附件不在此病歷的加密索引中');
    const { envelope: attachment } = await fetchEncryptedAttachment(id);
    if (attachment.salt !== envelope.salt || attachment.iterations !== envelope.iterations || (attachment.attachmentIds?.length ?? 0) > 0) {
      throw new Error('附件加密參數與目前病歷不一致');
    }
    const bytes = await decryptVaultBytes(attachment, key);
    validateAttachmentBytes(bytes, metadata.contentType);
    if (bytes.length !== metadata.size || await sha256(bytes) !== metadata.digest) throw new Error('附件完整性檢查失敗，請由備份還原');
    return bytes;
  };
  data.loadAttachment = async attachment => {
    if (attachment.id) {
      const metadata = records.attachments[attachment.id];
      if (!metadata || metadata.contentType !== attachment.contentType) throw new Error('附件類型與加密索引不一致');
      return new Blob([await read(attachment.id)], { type: metadata.contentType });
    }
    const bytes = base64ToBytes(attachment.data ?? '');
    validateAttachmentBytes(bytes, attachment.contentType);
    return new Blob([bytes], { type: attachment.contentType });
  };
  const readChunk = async (chunk: SourceChunk): Promise<Uint8Array<ArrayBuffer>> => {
    const { envelope: attachment } = await fetchEncryptedAttachment(chunk.id);
    if (attachment.salt !== envelope.salt || attachment.iterations !== envelope.iterations || (attachment.attachmentIds?.length ?? 0) > 0) {
      throw new Error('附件加密參數與目前病歷不一致');
    }
    const bytes = await decryptVaultBytes(attachment, key);
    if (bytes.length !== chunk.size || await sha256(bytes) !== chunk.digest) throw new Error('來源檔完整性檢查失敗，已停止下載');
    return bytes;
  };
  data.downloadSource = async sourceId => {
    const archive = records.sources[sourceId];
    if (!archive) throw new Error('找不到此加密來源檔');
    const filename = `health-passbook-${archive.format.toLowerCase()}-${sourceId.slice(0, 8)}.json`;
    if (archive.chunks) {
      if (await sha256(canonicalJson({ format: archive.format, chunks: archive.chunks })) !== sourceId) throw new Error('來源檔完整性檢查失敗，已停止下載');
      const parts: Uint8Array<ArrayBuffer>[] = [];
      for (const chunk of archive.chunks) parts.push(await readChunk(chunk));
      downloadBlob(new Blob(parts, { type: 'application/json' }), filename);
      return;
    }
    if (!archive.data) throw new Error('找不到此加密來源檔');
    const pending = new Map<string, Promise<string>>();
    const restored = await restoreAttachmentData(archive.data, id => {
      if (!pending.has(id)) pending.set(id, read(id).then(bytesToBase64));
      return pending.get(id)!;
    });
    if (await sha256(canonicalJson(restored)) !== sourceId) throw new Error('來源檔完整性檢查失敗，已停止下載');
    downloadBlob(new Blob([JSON.stringify(restored, null, 2)], { type: 'application/json' }), filename);
  };
  return data;
}
