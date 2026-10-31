import type { ClientEncryptedRecords } from './api';
import { normalizeStoredRecords, sourceChunkIds, type StoredRecords } from './recordStore';
import { base64ToBytes, bytesToBase64, MAX_ENVELOPE_ATTACHMENT_IDS, MAX_IMPORT_BYTES, UUID_PATTERN } from './medicalAttachments';

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
): Promise<ClientEncryptedRecords> {
  return encryptRecordsWithKey(records, await prepareVaultKey(passphrase, previous));
}

export function recordAttachmentIds(records: StoredRecords): string[] {
  return attachmentIdsOf(normalizeStoredRecords(records));
}

function attachmentIdsOf(records: StoredRecords): string[] {
  return [...new Set([...Object.keys(records.attachments), ...sourceChunkIds(records)])].sort();
}

export async function encryptRecordsWithKey(records: StoredRecords, prepared: VaultKey): Promise<ClientEncryptedRecords> {
  const normalized = normalizeStoredRecords(records);
  const bytes = encoder.encode(JSON.stringify(normalized));
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error('加密病歷索引超過 32 MiB 上限，未覆寫既有資料；請先備份並縮小匯出範圍');
  const envelope = await encryptWithVaultKey(bytes, prepared.key, prepared);
  return { ...envelope, attachmentIds: attachmentIdsOf(normalized), revision: crypto.randomUUID() };
}

export async function decryptRecords(
  envelope: ClientEncryptedRecords,
  passphrase: string,
): Promise<StoredRecords> {
  validateVaultPassphrase(passphrase);
  validateEnvelope(envelope);
  const key = await deriveVaultKey(passphrase, base64ToBytes(envelope.salt), envelope.iterations);
  const plaintext = await decryptVaultBytes(envelope, key);
  if (plaintext.byteLength > MAX_IMPORT_BYTES) throw new Error('加密病歷內容超過允許大小');
  const records = normalizeStoredRecords(JSON.parse(decoder.decode(plaintext)));
  const ids = recordAttachmentIds(records);
  if (JSON.stringify(ids) !== JSON.stringify([...(envelope.attachmentIds ?? [])].sort())) throw new Error('附件清單與加密病歷不一致，已停止載入');
  return records;
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
