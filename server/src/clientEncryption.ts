export interface ClientEncryptedRecords {
  __clientEnc: true;
  v: 1;
  alg: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  iv: string;
  data: string;
  attachmentIds?: string[];
  revision?: string;
}

export const MAX_ATTACHMENT_IDS = 512;
export const MAX_ATTACHMENT_CIPHERTEXT_LENGTH = 18 * 1024 * 1024;
const MAX_MANIFEST_CIPHERTEXT_LENGTH = 50 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ENVELOPE_FIELDS = new Set([
  '__clientEnc', 'v', 'alg', 'kdf', 'iterations', 'salt', 'iv', 'data', 'attachmentIds', 'revision',
]);

export class EncryptedDataError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = 'EncryptedDataError';
  }
}

export function isAttachmentId(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

// Historical user IDs need not be UUIDs, but may never introduce path segments.
export function isSafeUserId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

export function isRevision(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x20\x7f]/.test(value);
}

function base64Size(value: unknown, maxLength: number): number | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.length % 4 !== 0) {
    return null;
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes.length : null;
}

export function isClientEncryptedRecords(
  value: unknown,
  attachment = false,
): value is ClientEncryptedRecords {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  if (Object.keys(envelope).some((field) => !ENVELOPE_FIELDS.has(field))) return false;
  if (
    envelope.__clientEnc !== true || envelope.v !== 1 ||
    envelope.alg !== 'AES-GCM' || envelope.kdf !== 'PBKDF2-SHA256' ||
    typeof envelope.iterations !== 'number' || !Number.isSafeInteger(envelope.iterations) ||
    envelope.iterations < 100_000 || envelope.iterations > 1_000_000
  ) return false;

  const saltSize = base64Size(envelope.salt, 88);
  // Existing vaults use 16-byte salts; retain compatibility with longer salts.
  if (saltSize === null || saltSize < 16 || saltSize > 64 || base64Size(envelope.iv, 16) !== 12) return false;
  const ciphertextSize = base64Size(
    envelope.data,
    attachment ? MAX_ATTACHMENT_CIPHERTEXT_LENGTH : MAX_MANIFEST_CIPHERTEXT_LENGTH,
  );
  if (ciphertextSize === null || ciphertextSize < 16) return false; // includes the GCM tag
  if ('revision' in envelope && !isRevision(envelope.revision)) return false;
  if ('attachmentIds' in envelope) {
    if (attachment || !Array.isArray(envelope.attachmentIds) || envelope.attachmentIds.length > MAX_ATTACHMENT_IDS) return false;
    if (!envelope.attachmentIds.every(isAttachmentId)) return false;
    if (new Set(envelope.attachmentIds).size !== envelope.attachmentIds.length) return false;
  }
  return true;
}
