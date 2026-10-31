import { fetchEncryptedAttachment, type ClientEncryptedRecords } from './api';
import { normalizeStoredRecords, sourceChunkIds, type SourceChunk, type StoredRecords } from './recordStore';
import {
  base64ToBytes, bytesToBase64, MAX_ENVELOPE_ATTACHMENT_IDS, MAX_IMPORT_BYTES, MAX_RECORD_SHARDS,
  RECORD_SHARD_BYTES, UUID_PATTERN,
} from './medicalAttachments';
import {
  isRecordShardHeader, joinShards, serializeRecords, shardId, type RecordShardHeader, type RecordShardUpload,
} from './recordShards';
import { sha256 } from './parsers/fhir-common';

export { emptyRecords, flattenRecords, normalizeStoredRecords, sourceChunkIds } from './recordStore';
export type { StoredRecords, RecordType, MergeStats, SourceArchive, SourceChunk } from './recordStore';
export { mergeNHIJson, mergePreparedImport, inspectImportIdentity, patientIdentityDecision, PatientConfirmationRequired } from './recordImport';
export type { PreparedMergeInput } from './recordImport';

const KDF_ITERATIONS = 250_000;
export const VAULT_PASSPHRASE_MIN_LENGTH = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface VaultKey {
  key: CryptoKey;
  salt: string;
  iterations: number;
}

/** Derive the vault key once so the manifest and every uploaded chunk can reuse it. */
export async function prepareVaultKey(passphrase: string, previous?: ClientEncryptedRecords | null): Promise<VaultKey> {
  validateVaultPassphrase(passphrase);
  if (previous) validateEnvelope(previous);
  const salt = previous ? base64ToBytes(previous.salt) : randomBytes(16);
  const iterations = previous?.iterations ?? KDF_ITERATIONS;
  const key = await deriveVaultKey(passphrase, salt, iterations);
  return { key, salt: bytesToBase64(salt), iterations };
}

export async function encryptRecords(
  records: StoredRecords,
  passphrase: string,
  previous?: ClientEncryptedRecords | null,
  options: EncryptRecordsOptions = {},
): Promise<ClientEncryptedRecords> {
  const prepared = await prepareVaultKey(passphrase, previous);
  return encryptRecordsWithKey(records, prepared, { ...options, previous });
}

export function recordAttachmentIds(records: StoredRecords, shardIds: string[] = []): string[] {
  return attachmentIdsOf(normalizeStoredRecords(records), shardIds);
}

function attachmentIdsOf(records: StoredRecords, shardIds: string[] = []): string[] {
  return [...new Set([...Object.keys(records.attachments), ...sourceChunkIds(records), ...shardIds])].sort();
}

export interface EncryptRecordsOptions {
  previous?: ClientEncryptedRecords | null;
  signal?: AbortSignal;
  /** Uploads one encrypted index shard; required once the index outgrows the inline budget. */
  uploadShard?: (shard: RecordShardUpload) => Promise<void>;
  /** Overrides the sharding thresholds (used by tests and future tuning). */
  limits?: { inlineBytes?: number; shardBytes?: number };
}

/**
 * Encrypts the record index. Indexes that fit in one manifest stay inline (v1 behaviour);
 * larger ones are split into content-addressed shards that each fit the attachment budget.
 */
export async function encryptRecordsWithKey(
  records: StoredRecords,
  prepared: VaultKey,
  options: EncryptRecordsOptions = {},
): Promise<ClientEncryptedRecords> {
  const normalized = normalizeStoredRecords(records);
  const inlineBytes = options.limits?.inlineBytes ?? MAX_IMPORT_BYTES;
  const shardBytes = options.limits?.shardBytes ?? RECORD_SHARD_BYTES;
  const stream = serializeRecords(normalized, shardBytes);
  const buffered: Uint8Array<ArrayBuffer>[] = [];
  let bufferedBytes = 0;
  let done = false;
  while (!done && bufferedBytes <= inlineBytes) {
    const next = stream.next();
    if (next.done) {
      done = true;
      break;
    }
    buffered.push(next.value);
    bufferedBytes += next.value.length;
  }
  if (done) {
    const envelope = await encryptWithVaultKey(joinShards(buffered, bufferedBytes), prepared.key, prepared);
    return { ...envelope, attachmentIds: attachmentIdsOf(normalized), revision: crypto.randomUUID() };
  }
  if (!options.uploadShard) throw new Error('病歷索引已超過單一分片容量，請重新整理頁面後再匯入');

  const known = await previousShardIds(prepared, options.previous);
  const shards: SourceChunk[] = [];
  let total = 0;
  const store = async (bytes: Uint8Array<ArrayBuffer>) => {
    options.signal?.throwIfAborted();
    const digest = await sha256(bytes);
    const id = shardId(digest);
    if (!known.has(id)) {
      await options.uploadShard!({ id, digest, bytes });
      known.add(id);
    }
    shards.push({ id, digest, size: bytes.length });
    total += bytes.length;
    if (shards.length > MAX_RECORD_SHARDS) throw new Error('病歷文字內容超過 8 GiB 上限，請縮小日期範圍後分批匯入');
  };
  for (const piece of buffered) await store(piece);
  for (let next = stream.next(); !next.done; next = stream.next()) await store(next.value);

  const header: RecordShardHeader = { kind: 'records-shards', version: 1, size: total, shards };
  const envelope = await encryptWithVaultKey(encoder.encode(JSON.stringify(header)), prepared.key, prepared);
  options.signal?.throwIfAborted();
  return { ...envelope, attachmentIds: attachmentIdsOf(normalized, shards.map(shard => shard.id)), revision: crypto.randomUUID() };
}

async function previousShardIds(prepared: VaultKey, previous?: ClientEncryptedRecords | null): Promise<Set<string>> {
  if (!previous) return new Set();
  try {
    const header: unknown = JSON.parse(decoder.decode(await decryptVaultBytes(previous, prepared.key)));
    return new Set(isRecordShardHeader(header) ? header.shards.map(shard => shard.id) : []);
  } catch {
    return new Set();
  }
}

export type ShardLoader = (shard: SourceChunk) => Promise<Uint8Array<ArrayBuffer>>;

export async function decryptRecords(
  envelope: ClientEncryptedRecords,
  passphrase: string,
  loadShard?: ShardLoader,
  onProgress?: (ratio: number) => void,
): Promise<StoredRecords> {
  validateVaultPassphrase(passphrase);
  validateEnvelope(envelope);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const plaintext = await decryptVaultBytes(envelope, key);
  const header: unknown = JSON.parse(decoder.decode(plaintext));
  const readShard = loadShard ?? (shard => readVaultShard(envelope, key, shard));
  if (isRecordShardHeader(header)) {
    const cache = new Map<string, Uint8Array<ArrayBuffer>>();
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let bytes = 0;
    for (const shard of header.shards) {
      const cached = cache.get(shard.id);
      const part = cached ?? await readShard(shard);
      cache.set(shard.id, part);
      if (part.length !== shard.size || await sha256(part) !== shard.digest) throw new Error('病歷索引分片完整性檢查失敗，已停止載入');
      parts.push(part);
      bytes += part.length;
      onProgress?.(bytes / header.size);
    }
    const records = normalizeStoredRecords(JSON.parse(decoder.decode(joinShards(parts, header.size))));
    if (JSON.stringify(recordAttachmentIds(records, header.shards.map(shard => shard.id))) !==
        JSON.stringify([...(envelope.attachmentIds ?? [])].sort())) throw new Error('附件清單與加密病歷不一致，已停止載入');
    return records;
  }
  if (plaintext.byteLength > MAX_IMPORT_BYTES) throw new Error('加密病歷內容超過允許大小');
  const records = normalizeStoredRecords(header);
  if (JSON.stringify(recordAttachmentIds(records)) !== JSON.stringify([...(envelope.attachmentIds ?? [])].sort())) throw new Error('附件清單與加密病歷不一致，已停止載入');
  return records;
}

async function readVaultShard(vault: ClientEncryptedRecords, key: CryptoKey, shard: SourceChunk): Promise<Uint8Array<ArrayBuffer>> {
  const { envelope } = await fetchEncryptedAttachment(shard.id);
  if (envelope.salt !== vault.salt || envelope.iterations !== vault.iterations || (envelope.attachmentIds?.length ?? 0) > 0) {
    throw new Error('病歷索引分片與目前病歷的加密參數不一致');
  }
  return decryptVaultBytes(envelope, key);
}

export function validateVaultPassphrase(passphrase: string): void {
  if (passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`資料加密密碼至少需要 ${VAULT_PASSPHRASE_MIN_LENGTH} 個字元`);
  }
}

export function validateEnvelope(envelope: ClientEncryptedRecords): void {
  if (!envelope || envelope.__clientEnc !== true || envelope.v !== 1 || envelope.alg !== 'AES-GCM' || envelope.kdf !== 'PBKDF2-SHA256' ||
      !Number.isSafeInteger(envelope.iterations) || envelope.iterations < 100_000 || envelope.iterations > 1_000_000 ||
      typeof envelope.salt !== 'string' || typeof envelope.iv !== 'string' || typeof envelope.data !== 'string' ||
      envelope.salt.length > 88 || envelope.iv.length !== 16 || envelope.data.length > Math.ceil((MAX_IMPORT_BYTES + 16) / 3) * 4) {
    throw new Error('加密封裝格式不正確或超過允許大小');
  }
  const salt = base64ToBytes(envelope.salt);
  if (salt.length < 16 || salt.length > 64 || base64ToBytes(envelope.iv).length !== 12 || base64ToBytes(envelope.data).length < 16) throw new Error('加密封裝參數不正確');
  if (envelope.attachmentIds !== undefined && (!Array.isArray(envelope.attachmentIds) || envelope.attachmentIds.length > MAX_ENVELOPE_ATTACHMENT_IDS ||
      new Set(envelope.attachmentIds).size !== envelope.attachmentIds.length || envelope.attachmentIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)))) throw new Error('附件清單格式不正確');
}

export async function encryptVaultBytes(bytes: Uint8Array, passphrase: string, previous?: ClientEncryptedRecords | null): Promise<ClientEncryptedRecords> {
  const prepared = await prepareVaultKey(passphrase, previous);
  return encryptWithVaultKey(bytes, prepared.key, prepared);
}

export async function encryptWithVaultKey(bytes: Uint8Array, key: CryptoKey, parameters: Pick<ClientEncryptedRecords, 'salt' | 'iterations'>): Promise<ClientEncryptedRecords> {
  const iv = randomBytes(12);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: copyBytes(iv) }, key, copyBytes(bytes));
  return { __clientEnc: true, v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: parameters.iterations,
    salt: parameters.salt, iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(ciphertext)) };
}

export async function decryptVaultBytes(envelope: ClientEncryptedRecords, key: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  validateEnvelope(envelope);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: base64ToBytes(envelope.iv) }, key, base64ToBytes(envelope.data));
  return new Uint8Array(plaintext);
}

export async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    copyBytes(encoder.encode(passphrase)),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: copyBytes(salt), iterations },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
