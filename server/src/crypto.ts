/**
 * Encryption utilities for user health data.
 *
 * Strategy: AES-256-GCM with per-entity keys derived via HKDF-SHA256 from a
 * master key.  The master key is loaded from the ENCRYPTION_KEY environment
 * variable (64-char hex = 32 bytes).  If the variable is absent, a random key
 * is auto-generated and persisted to server/data/.key so the server can restart
 * without losing access to existing encrypted files.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';

const KEY_FILE = path.join(process.cwd(), 'data', '.key');

// ── Encrypted envelope format ─────────────────────────────────────────────────

export interface EncryptedEnvelope {
  __enc: true;
  iv: string;   // 12-byte nonce, hex
  tag: string;  // 16-byte GCM auth tag, hex
  data: string; // ciphertext, hex
}

export function isEncryptedEnvelope(obj: unknown): obj is EncryptedEnvelope {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    (obj as Record<string, unknown>).__enc === true
  );
}

// ── Master key management ─────────────────────────────────────────────────────

let _masterKey: Buffer | null = null;

/**
 * Load or auto-generate the master encryption key.
 * Must be called once at server startup before any store operations.
 */
export async function loadMasterKey(): Promise<void> {
  if (process.env.ENCRYPTION_KEY) {
    const hex = process.env.ENCRYPTION_KEY.trim();
    if (hex.length !== 64) {
      throw new Error('ENCRYPTION_KEY 必須為 64 個 hex 字元（32 bytes）。生成指令：openssl rand -hex 32');
    }
    _masterKey = Buffer.from(hex, 'hex');
    console.log('[crypto] 使用環境變數 ENCRYPTION_KEY');
    return;
  }

  // Try to load from persisted key file
  try {
    const raw = await fs.readFile(KEY_FILE, 'utf-8');
    const hex = raw.trim();
    if (hex.length !== 64) throw new Error('格式錯誤');
    _masterKey = Buffer.from(hex, 'hex');
    console.log(`[crypto] 從金鑰檔案載入主金鑰：${KEY_FILE}`);
  } catch {
    // Auto-generate a new master key and persist it
    _masterKey = crypto.randomBytes(32);
    await fs.mkdir(path.dirname(KEY_FILE), { recursive: true });
    await fs.writeFile(KEY_FILE, _masterKey.toString('hex'), { encoding: 'utf-8', mode: 0o600 });
    console.warn('[crypto] ⚠  自動產生新的主金鑰，已儲存至：' + KEY_FILE);
    console.warn('[crypto] ⚠  請妥善備份此金鑰檔案！遺失將導致所有健康資料永久無法解密。');
  }
}

function getMasterKey(): Buffer {
  if (!_masterKey) {
    throw new Error('主金鑰尚未載入，請先呼叫 loadMasterKey()');
  }
  return _masterKey;
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Derive a 256-bit file-specific key via HKDF-SHA256.
 *
 * @param salt  Per-entity salt (random bytes stored alongside the entity).
 * @param info  Context label distinguishing key purposes.
 */
export function deriveKey(salt: Buffer, info: string): Buffer {
  return Buffer.from(
    crypto.hkdfSync('sha256', getMasterKey(), salt, Buffer.from(info), 32) as ArrayBuffer,
  );
}

// Fixed derivation parameters for the users file (no per-user salt needed —
// the master key itself is the secret; HKDF info string differentiates it from
// record file keys).
const USERS_SALT = Buffer.alloc(32, 0);
const USERS_INFO = 'nhi-users-file-v1';
const RECORDS_INFO = 'nhi-health-records-v1';

export function deriveUsersKey(): Buffer {
  return deriveKey(USERS_SALT, USERS_INFO);
}

export function deriveRecordsKey(saltHex: string): Buffer {
  return deriveKey(Buffer.from(saltHex, 'hex'), RECORDS_INFO);
}

// ── AES-256-GCM encrypt / decrypt ─────────────────────────────────────────────

export function encryptJson(key: Buffer, obj: unknown): EncryptedEnvelope {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(obj), 'utf-8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: true,
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    data: ciphertext.toString('hex'),
  };
}

export function decryptJson(key: Buffer, envelope: EncryptedEnvelope): unknown {
  const iv = Buffer.from(envelope.iv, 'hex');
  const tag = Buffer.from(envelope.tag, 'hex');
  const ciphertext = Buffer.from(envelope.data, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plain.toString('utf-8'));
}

// ── Convenience: read encrypted JSON file with migration support ───────────────

/**
 * Read a JSON file that may be either encrypted (new format) or plaintext (old
 * format).  If plaintext is detected the data is returned as-is — the caller is
 * responsible for re-writing it in encrypted form to complete the migration.
 *
 * Returns { data, wasMigrated } where wasMigrated=true means the file was
 * plaintext and should be re-written encrypted.
 */
export async function readMaybeEncrypted<T>(
  file: string,
  key: Buffer,
  fallback: T,
): Promise<{ data: T; wasMigrated: boolean }> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf-8');
  } catch {
    return { data: fallback, wasMigrated: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { data: fallback, wasMigrated: false };
  }

  if (isEncryptedEnvelope(parsed)) {
    // Normal encrypted read
    const data = decryptJson(key, parsed) as T;
    return { data, wasMigrated: false };
  }

  // Plaintext (legacy) — return data and signal migration needed
  return { data: parsed as T, wasMigrated: true };
}

export async function writeEncrypted(file: string, key: Buffer, obj: unknown): Promise<void> {
  const envelope = encryptJson(key, obj);
  await fs.writeFile(file, JSON.stringify(envelope), 'utf-8');
}
