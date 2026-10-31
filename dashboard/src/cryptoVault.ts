import type { ClientEncryptedRecords } from './api';
import { normalizeStoredRecords, type StoredRecords } from './recordStore';
import { base64ToBytes, bytesToBase64, MAX_IMPORT_BYTES, UUID_PATTERN } from './medicalAttachments';

export { emptyRecords, flattenRecords, normalizeStoredRecords } from './recordStore';
export type { StoredRecords, RecordType, MergeStats } from './recordStore';
export { mergeNHIJson, inspectImportIdentity, PatientConfirmationRequired } from './recordImport';

const KDF_ITERATIONS = 250_000;
export const VAULT_PASSPHRASE_MIN_LENGTH = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function encryptRecords(
  records: StoredRecords,
  passphrase: string,
  previous?: ClientEncryptedRecords | null,
): Promise<ClientEncryptedRecords> {
  const normalized = normalizeStoredRecords(records);
  const bytes = encoder.encode(JSON.stringify(normalized));
  if (bytes.length > MAX_IMPORT_BYTES) throw new Error('加密病歷索引超過 32 MiB 上限，未覆寫既有資料；請先備份並縮小匯出範圍');
  const envelope = await encryptVaultBytes(bytes, passphrase, previous);
  return { ...envelope, attachmentIds: Object.keys(normalized.attachments).sort(), revision: crypto.randomUUID() };
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
  const ids = Object.keys(records.attachments).sort();
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
  if (envelope.attachmentIds !== undefined && (!Array.isArray(envelope.attachmentIds) || envelope.attachmentIds.length > 512 ||
      new Set(envelope.attachmentIds).size !== envelope.attachmentIds.length || envelope.attachmentIds.some(id => typeof id !== 'string' || !UUID_PATTERN.test(id)))) throw new Error('附件清單格式不正確');
}

export async function encryptVaultBytes(bytes: Uint8Array, passphrase: string, previous?: ClientEncryptedRecords | null): Promise<ClientEncryptedRecords> {
  validateVaultPassphrase(passphrase);
  if (previous) validateEnvelope(previous);
  const salt = previous ? base64ToBytes(previous.salt) : randomBytes(16);
  const iterations = previous?.iterations ?? KDF_ITERATIONS;
  const key = await deriveVaultKey(passphrase, salt, iterations);
  return encryptWithVaultKey(bytes, key, { salt: bytesToBase64(salt), iterations });
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
