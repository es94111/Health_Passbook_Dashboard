import type { ClientEncryptedRecords } from './api';

export type RecordType = 'r1' | 'r2' | 'r3' | 'r6' | 'r7' | 'r8';

export interface StoredRecords {
  r1: Record<string, object>;
  r2: Record<string, object>;
  r3: Record<string, object>;
  r6: Record<string, object>;
  r7: Record<string, object>;
  r8: Record<string, object>;
}

export type MergeStats = Record<RecordType, { added: number; skipped: number }>;

const RECORD_TYPES: RecordType[] = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8'];
const KDF_ITERATIONS = 250_000;
export const VAULT_PASSPHRASE_MIN_LENGTH = 12;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function emptyRecords(): StoredRecords {
  return { r1: {}, r2: {}, r3: {}, r6: {}, r7: {}, r8: {} };
}

export function flattenRecords(stored: StoredRecords): Record<string, object[]> {
  return {
    r1: Object.values(stored.r1),
    r2: Object.values(stored.r2),
    r3: Object.values(stored.r3),
    r6: Object.values(stored.r6),
    r7: Object.values(stored.r7),
    r8: Object.values(stored.r8),
  };
}

export function mergeNHIJson(existing: StoredRecords, json: object): { records: StoredRecords; stats: MergeStats } {
  const records: StoredRecords = {
    r1: { ...existing.r1 },
    r2: { ...existing.r2 },
    r3: { ...existing.r3 },
    r6: { ...existing.r6 },
    r7: { ...existing.r7 },
    r8: { ...existing.r8 },
  };
  const stats = Object.fromEntries(RECORD_TYPES.map((type) => [type, { added: 0, skipped: 0 }])) as MergeStats;
  const source = extractSource(json);

  for (const type of RECORD_TYPES) {
    const arr = source[type];
    if (!Array.isArray(arr)) continue;
    let incoming = arr.filter((rec): rec is Record<string, unknown> => typeof rec === 'object' && rec !== null);
    if (type === 'r1') {
      incoming = incoming.filter((rec) => rec['r1.7'] !== 'XXXX');
    }

    for (const rec of incoming) {
      const key = dedupKey(type, rec);
      if (key in records[type]) {
        stats[type].skipped += 1;
      } else {
        records[type][key] = rec;
        stats[type].added += 1;
      }
    }
  }

  return { records, stats };
}

export async function encryptRecords(
  records: StoredRecords,
  passphrase: string,
  previous?: ClientEncryptedRecords | null,
): Promise<ClientEncryptedRecords> {
  validateVaultPassphrase(passphrase);
  const salt = previous ? base64ToBytes(previous.salt) : randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveVaultKey(passphrase, salt, previous?.iterations ?? KDF_ITERATIONS);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: copyBytes(iv) },
    key,
    copyBytes(encoder.encode(JSON.stringify(records))),
  );

  return {
    __clientEnc: true,
    v: 1,
    alg: 'AES-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations: previous?.iterations ?? KDF_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptRecords(
  envelope: ClientEncryptedRecords,
  passphrase: string,
): Promise<StoredRecords> {
  validateVaultPassphrase(passphrase);
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const key = await deriveVaultKey(passphrase, salt, envelope.iterations);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: copyBytes(iv) },
    key,
    copyBytes(base64ToBytes(envelope.data)),
  );
  return normalizeStoredRecords(JSON.parse(decoder.decode(plaintext)));
}

export function validateVaultPassphrase(passphrase: string): void {
  if (passphrase.length < VAULT_PASSPHRASE_MIN_LENGTH) {
    throw new Error(`資料加密密碼至少需要 ${VAULT_PASSPHRASE_MIN_LENGTH} 個字元`);
  }
}

function extractSource(json: object): Record<string, unknown> {
  const root = json as Record<string, unknown>;
  const myHealthBank = root.myhealthbank as Record<string, unknown> | undefined;
  const bdata = myHealthBank?.bdata as Record<string, unknown> | undefined;
  return bdata ?? root;
}

function normalizeStoredRecords(value: unknown): StoredRecords {
  const root = typeof value === 'object' && value !== null ? value as Partial<StoredRecords> : {};
  const normalized = emptyRecords();
  for (const type of RECORD_TYPES) {
    const records = root[type];
    normalized[type] = typeof records === 'object' && records !== null && !Array.isArray(records)
      ? records as Record<string, object>
      : {};
  }
  return normalized;
}

function field(rec: Record<string, unknown>, key: string): string {
  const value = rec[key];
  return value != null ? String(value) : '';
}

function dedupKey(type: RecordType, rec: Record<string, unknown>): string {
  switch (type) {
    case 'r1':
      return `${field(rec, 'r1.4')}_${field(rec, 'r1.5')}_${field(rec, 'r1.7')}`;
    case 'r2':
      return `${field(rec, 'r2.4')}_${field(rec, 'r2.5')}_${field(rec, 'r2.6')}`;
    case 'r3':
      return `${field(rec, 'r3.4')}_${field(rec, 'r3.5')}_${field(rec, 'r3.7')}`;
    case 'r6':
      return `${field(rec, 'r6.1')}_${field(rec, 'r6.3')}`;
    case 'r7':
      return `${field(rec, 'r7.4')}_${field(rec, 'r7.5')}_${field(rec, 'r7.7')}_${field(rec, 'r7.10')}`;
    case 'r8':
      return `${field(rec, 'r8.4')}_${field(rec, 'r8.5')}_${field(rec, 'r8.8')}`;
  }
}

async function deriveVaultKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}
