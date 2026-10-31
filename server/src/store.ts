import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { withDataAccess } from './dataAccess.js';
import {
  EncryptedDataError,
  isAttachmentId,
  isSafeUserId,
  isRevision,
  isClientEncryptedRecords,
  type ClientEncryptedRecords,
} from './clientEncryption.js';
export { isClientEncryptedRecords, type ClientEncryptedRecords } from './clientEncryption.js';
import {
  deriveUsersKey,
  deriveRecordsKey,
  deriveSettingsKey,
  deriveLogsKey,
  readMaybeEncrypted,
  writeEncrypted,
} from './crypto.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LOGS_FILE = path.join(DATA_DIR, 'login-logs.json');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

// ── Per-file write lock ────────────────────────────────────────────────────────
// Serializes read-modify-write operations on the same file so concurrent
// requests (two uploads, two logins writing login logs, …) can't lose updates.
// Internal helpers must NOT call withLock (it would deadlock on the same key).

const fileLocks = new Map<string, Promise<unknown>>();

function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return withDataAccess(async () => {
    const prev = fileLocks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const settled = run.then(() => undefined, () => undefined);
    fileLocks.set(name, settled);
    try {
      return await run;
    } finally {
      if (fileLocks.get(name) === settled) fileLocks.delete(name);
    }
  });
}

// ── User preferences ──────────────────────────────────────────────────────────

export type DateRangePreset = 'all' | '3m' | '6m' | '1y' | '3y';

/** Per-user dashboard preferences. Persisted on the User record. */
export interface UserPreferences {
  pinnedLabItems: string[];      // lab subItem names the user tracks long-term
  pinnedMedications: string[];   // drug codes the user tracks long-term
  hiddenSections: string[];      // dashboard section keys the user has hidden
  defaultDateRange: DateRangePreset;
  lastActiveTab: string | null;  // last selected dashboard tab (restored on load)
  acknowledgedAlerts: string[];  // alert ids the user has dismissed
}

export const DEFAULT_PREFERENCES: UserPreferences = {
  pinnedLabItems: [],
  pinnedMedications: [],
  hiddenSections: [],
  defaultDateRange: 'all',
  lastActiveTab: null,
  acknowledgedAlerts: [],
};

// Caps to keep the encrypted record bounded regardless of client behaviour
const MAX_PINS = 50;
const MAX_HIDDEN = 30;
const MAX_ACK_ALERTS = 200;
const DATE_RANGE_PRESETS: DateRangePreset[] = ['all', '3m', '6m', '1y', '3y'];

/** Merge stored preferences (possibly missing/partial) with defaults. */
export function normalizePreferences(p?: Partial<UserPreferences>): UserPreferences {
  return { ...DEFAULT_PREFERENCES, ...(p ?? {}) };
}

// ── User types ────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  username: string;
  passwordHash: string;   // empty string for Google-only users
  isAdmin: boolean;
  createdAt: string;
  encryptionSalt: string; // 32-byte hex — derived to produce per-user records key
  googleId?: string;      // Google sub claim (stable unique identifier)
  googleEmail?: string;   // Google email, for display / lookup
  displayName?: string;   // user-facing name (max 50 chars)
  themeMode?: 'light' | 'dark' | 'system';
  avatarUrl?: string;     // sourced from Google profile on link/login
  preferences?: UserPreferences;
}

/** Public profile DTO returned by /me endpoints (never leaks passwordHash / salt). */
export interface PublicProfile {
  userId: string;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
  themeMode: 'light' | 'dark' | 'system';
  googleEmail: string | null;
  avatarUrl: string | null;
  hasPassword: boolean;
  hasGoogle: boolean;
  createdAt: string;
  preferences: UserPreferences;
}

export function toPublicProfile(user: User): PublicProfile {
  return {
    userId: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    isAdmin: user.isAdmin,
    themeMode: user.themeMode ?? 'system',
    googleEmail: user.googleEmail ?? null,
    avatarUrl: user.avatarUrl ?? null,
    hasPassword: Boolean(user.passwordHash),
    hasGoogle: Boolean(user.googleId),
    createdAt: user.createdAt,
    preferences: normalizePreferences(user.preferences),
  };
}

// ── NHI record types (mirrored from frontend) ─────────────────────────────────

export interface StoredRecords {
  // raw arrays from the NHI JSON, keyed by dedup key
  r1: Record<string, object>;   // outpatient visits
  r2: Record<string, object>;   // hospitalizations
  r3: Record<string, object>;   // dental
  r6: Record<string, object>;   // vaccinations
  r7: Record<string, object>;   // lab results
  r8: Record<string, object>;   // checkup reports
}

const RECORD_TYPES = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8'] as const;
type RecordType = typeof RECORD_TYPES[number];

function emptyRecords(): StoredRecords {
  return { r1: {}, r2: {}, r3: {}, r6: {}, r7: {}, r8: {} };
}

function normalizeRecordMap(type: RecordType, value: unknown): Record<string, object> {
  if (Array.isArray(value)) {
    const records: Record<string, object> = {};
    for (const rec of value) {
      if (typeof rec === 'object' && rec !== null && !Array.isArray(rec)) {
        records[dedupKey(type, rec as Record<string, unknown>)] = rec;
      }
    }
    return records;
  }

  if (typeof value !== 'object' || value === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, object] =>
        typeof entry[0] === 'string' &&
        typeof entry[1] === 'object' &&
        entry[1] !== null &&
        !Array.isArray(entry[1]),
    ),
  );
}

export function normalizeStoredRecords(value: unknown): StoredRecords {
  const root = typeof value === 'object' && value !== null
    ? value as Partial<Record<keyof StoredRecords, unknown>>
    : {};

  return {
    r1: normalizeRecordMap('r1', root.r1),
    r2: normalizeRecordMap('r2', root.r2),
    r3: normalizeRecordMap('r3', root.r3),
    r6: normalizeRecordMap('r6', root.r6),
    r7: normalizeRecordMap('r7', root.r7),
    r8: normalizeRecordMap('r8', root.r8),
  };
}

// ── Login log types ───────────────────────────────────────────────────────────

export interface LoginLog {
  id: string;
  userId: string | null;         // null when username not found
  username: string;              // as entered by user
  isAdmin: boolean;
  method: 'password' | 'google';
  success: boolean;
  failReason?: string;           // set on failure
  ip: string;
  country?: string;              // filled async via IP lookup
  timestamp: string;
  action?: string;               // audit actions, e.g. 'admin-export' | 'admin-import'
  note?: string;                 // audit detail, e.g. backup stats summary
}

const MAX_LOGS = 1000;

// ── App settings ──────────────────────────────────────────────────────────────

export interface AppSettings {
  publicRegistration: boolean;
  allowedRegistrationEmails: string[];  // each line one email/domain; empty = no restriction
  adminIpAllowlist: string[];           // merged with ENV_ADMIN_IP_ALLOWLIST at runtime
}

export const DEFAULT_SETTINGS: AppSettings = {
  publicRegistration: true,
  allowedRegistrationEmails: [],
  adminIpAllowlist: [],
};

// ── File helpers ──────────────────────────────────────────────────────────────

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
}

// ── User store ────────────────────────────────────────────────────────────────

async function readUsers(): Promise<User[]> {
  return withDataAccess(readUsersUnlocked);
}

async function readUsersUnlocked(): Promise<User[]> {
  const key = deriveUsersKey();
  const { data, wasMigrated } = await readMaybeEncrypted<User[]>(USERS_FILE, key, []);
  if (wasMigrated && data.length > 0) {
    // Backfill encryptionSalt for users created before encryption was added
    let changed = false;
    for (const u of data) {
      if (!u.encryptionSalt) {
        u.encryptionSalt = crypto.randomBytes(32).toString('hex');
        changed = true;
        console.log(`[store] 為使用者 ${u.username} 補建 encryptionSalt`);
      }
    }
    await ensureDataDir();
    await writeEncrypted(USERS_FILE, key, data);
    if (changed) {
      console.log('[store] users.json 已從明文遷移至加密格式（含 encryptionSalt）');
    } else {
      console.log('[store] users.json 已從明文遷移至加密格式');
    }
  }
  return data;
}

async function writeUsers(users: User[]): Promise<void> {
  await ensureDataDir();
  const key = deriveUsersKey();
  await writeEncrypted(USERS_FILE, key, users);
}

export async function getUsers(): Promise<User[]> {
  return readUsers();
}

export async function getUserById(id: string): Promise<User | undefined> {
  const users = await readUsers();
  return users.find((u) => u.id === id);
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  const users = await readUsers();
  return users.find((u) => u.username === username);
}

export async function getUserByGoogleId(googleId: string): Promise<User | undefined> {
  const users = await readUsers();
  return users.find((u) => u.googleId === googleId);
}

export function createUser(user: Omit<User, 'encryptionSalt'>): Promise<void> {
  assertUserId(user.id);
  return withLock('users', async () => {
    const users = await readUsers();
    const fullUser: User = {
      ...user,
      encryptionSalt: crypto.randomBytes(32).toString('hex'),
    };
    users.push(fullUser);
    await writeUsers(users);
  });
}

export function updateUser(id: string, patch: Partial<Omit<User, 'id' | 'encryptionSalt'>>): Promise<User | null> {
  return withLock('users', async () => {
    const users = await readUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return null;
    users[idx] = { ...users[idx], ...patch };
    await writeUsers(users);
    return users[idx];
  });
}

/**
 * Merge a partial preferences patch onto the user's stored preferences.
 * Unknown keys are ignored; arrays are sanitised (string-only, deduped, capped);
 * defaultDateRange is validated against the allowed presets.
 * Returns the merged preferences, or null if the user does not exist.
 */
export function updateUserPreferences(
  id: string,
  patch: Partial<UserPreferences>,
): Promise<UserPreferences | null> {
  return withLock('users', async () => {
    const users = await readUsers();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) return null;

    const current = normalizePreferences(users[idx].preferences);
    const next: UserPreferences = { ...current };

    const cleanArray = (v: unknown, cap: number): string[] | undefined => {
      if (!Array.isArray(v)) return undefined;
      const strings = v.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean);
      return [...new Set(strings)].slice(0, cap);
    };

    if ('pinnedLabItems' in patch) {
      const a = cleanArray(patch.pinnedLabItems, MAX_PINS);
      if (a) next.pinnedLabItems = a;
    }
    if ('pinnedMedications' in patch) {
      const a = cleanArray(patch.pinnedMedications, MAX_PINS);
      if (a) next.pinnedMedications = a;
    }
    if ('hiddenSections' in patch) {
      const a = cleanArray(patch.hiddenSections, MAX_HIDDEN);
      if (a) next.hiddenSections = a;
    }
    if ('acknowledgedAlerts' in patch) {
      // Keep the most recent acks (client appends to the end)
      const a = cleanArray(patch.acknowledgedAlerts, Number.MAX_SAFE_INTEGER);
      if (a) next.acknowledgedAlerts = a.slice(-MAX_ACK_ALERTS);
    }
    if ('defaultDateRange' in patch) {
      if (DATE_RANGE_PRESETS.includes(patch.defaultDateRange as DateRangePreset)) {
        next.defaultDateRange = patch.defaultDateRange as DateRangePreset;
      }
    }
    if ('lastActiveTab' in patch) {
      const t = patch.lastActiveTab;
      next.lastActiveTab = typeof t === 'string' ? t.slice(0, 40) : null;
    }

    users[idx] = { ...users[idx], preferences: next };
    await writeUsers(users);
    return next;
  });
}

export function deleteUser(id: string): Promise<boolean> {
  return withLock('users', async () => {
    const users = await readUsers();
    const filtered = users.filter((u) => u.id !== id);
    if (filtered.length === users.length) return false;
    await writeUsers(filtered);
    await withLock(`records:${id}`, async () => {
      await deleteRecordsFile(id);
      await fs.rm(userAttachmentsDir(id), { recursive: true, force: true });
    });
    return true;
  });
}

export async function userCount(): Promise<number> {
  const users = await readUsers();
  return users.length;
}

export async function adminCount(): Promise<number> {
  const users = await readUsers();
  return users.filter((u) => u.isAdmin).length;
}

// ── Health records store ──────────────────────────────────────────────────────

function assertUserId(userId: string): void {
  if (!isSafeUserId(userId)) throw new EncryptedDataError('Invalid user ID');
}

function recordsFile(userId: string): string {
  assertUserId(userId);
  return path.join(DATA_DIR, `records-${userId}.json`);
}

function userAttachmentsDir(userId: string): string {
  assertUserId(userId);
  return path.join(ATTACHMENTS_DIR, userId);
}

function attachmentFile(userId: string, id: string): string {
  if (!isAttachmentId(id)) throw new EncryptedDataError('Invalid attachment ID');
  return path.join(userAttachmentsDir(userId), `${id}.json`);
}

async function recordsKey(userId: string): Promise<{ key: ReturnType<typeof deriveRecordsKey>; user: User }> {
  assertUserId(userId);
  const user = await getUserById(userId);
  if (!user) throw new EncryptedDataError('User no longer exists', 404);
  return { key: deriveRecordsKey(user.encryptionSalt), user };
}

function envelopeRevision(envelope: ClientEncryptedRecords): string {
  return envelope.revision ?? crypto.createHash('sha256').update(envelope.data).digest('hex');
}

async function readHealthData(userId: string): Promise<{
  envelope: ClientEncryptedRecords | null;
  needsClientEncryptionMigration: boolean;
}> {
  const { key } = await recordsKey(userId);
  const file = recordsFile(userId);
  const { data, wasMigrated } = await readMaybeEncrypted<ClientEncryptedRecords | StoredRecords | null>(file, key, null);
  if (data === null) {
    return { envelope: null, needsClientEncryptionMigration: false };
  }
  if (isClientEncryptedRecords(data)) {
    if (wasMigrated) await writeEncrypted(file, key, data);
    return { envelope: { ...data, revision: envelopeRevision(data) }, needsClientEncryptionMigration: false };
  }
  if (typeof data === 'object' && '__clientEnc' in data) {
    throw new EncryptedDataError('Stored encrypted health records are invalid', 500);
  }
  if (wasMigrated) {
    await ensureDataDir();
    await writeEncrypted(file, key, normalizeStoredRecords(data));
  }
  return { envelope: null, needsClientEncryptionMigration: true };
}

export async function getClientEncryptedRecords(userId: string): Promise<ClientEncryptedRecords | null> {
  const data = await getHealthDataForClient(userId);
  return data.envelope;
}

export function getHealthDataForClient(userId: string): ReturnType<typeof readHealthData> {
  return withLock(`records:${userId}`, () => readHealthData(userId));
}

export function getLegacyRecordsForClientEncryption(userId: string): Promise<StoredRecords> {
  return withLock(`records:${userId}`, async () => {
    const { key } = await recordsKey(userId);
    const file = recordsFile(userId);
    const { data, wasMigrated } = await readMaybeEncrypted<ClientEncryptedRecords | StoredRecords | null>(file, key, null);
    if (data === null) return emptyRecords();
    if (typeof data === 'object' && '__clientEnc' in data) {
      throw new EncryptedDataError('Health records are already client-side encrypted.');
    }

    const records = normalizeStoredRecords(data);
    if (wasMigrated) {
      await ensureDataDir();
      await writeEncrypted(file, key, records);
    }
    return records;
  });
}

async function readAttachmentEnvelope(userId: string, id: string, key: Buffer): Promise<ClientEncryptedRecords | null> {
  const { data, wasMigrated } = await readMaybeEncrypted<unknown>(attachmentFile(userId, id), key, null);
  if (data === null) return null;
  if (wasMigrated || !isClientEncryptedRecords(data, true)) {
    throw new EncryptedDataError('Stored encrypted attachment is invalid', 500);
  }
  return data;
}

export function getEncryptedAttachment(userId: string, id: string): Promise<ClientEncryptedRecords | null> {
  attachmentFile(userId, id);
  return withLock(`records:${userId}`, async () => {
    const { key } = await recordsKey(userId);
    return readAttachmentEnvelope(userId, id, key);
  });
}

export function saveEncryptedAttachment(userId: string, id: string, envelope: ClientEncryptedRecords): Promise<void> {
  const file = attachmentFile(userId, id);
  if (!isClientEncryptedRecords(envelope, true)) throw new EncryptedDataError('Invalid encrypted attachment envelope');
  return withLock(`records:${userId}`, async () => {
    const { key } = await recordsKey(userId);
    const existing = await readAttachmentEnvelope(userId, id, key);
    if (existing) {
      if (
        existing.iterations !== envelope.iterations || existing.salt !== envelope.salt ||
        existing.iv !== envelope.iv || existing.data !== envelope.data || existing.revision !== envelope.revision
      ) throw new EncryptedDataError('Attachment ID already exists with different encrypted content', 409);
      return;
    }
    await fs.mkdir(userAttachmentsDir(userId), { recursive: true, mode: 0o700 });
    await writeEncrypted(file, key, envelope);
  });
}

export function saveClientEncryptedRecords(
  userId: string,
  envelope: ClientEncryptedRecords,
  expectedRevision?: string | null,
): Promise<void> {
  if (!isClientEncryptedRecords(envelope)) throw new EncryptedDataError('Invalid client encrypted health records envelope');
  if (expectedRevision !== undefined && expectedRevision !== null && !isRevision(expectedRevision)) {
    throw new EncryptedDataError('Invalid expected revision');
  }
  return withLock(`records:${userId}`, async () => {
    const { key } = await recordsKey(userId);
    if (expectedRevision !== undefined) {
      const current = await readHealthData(userId);
      if ((current.envelope?.revision ?? null) !== expectedRevision) {
        throw new EncryptedDataError('Health records changed; reload before importing again', 409);
      }
    }
    for (const id of envelope.attachmentIds ?? []) {
      try {
        if (!await readAttachmentEnvelope(userId, id, key)) throw new Error('Missing attachment');
      } catch {
        throw new EncryptedDataError('Missing or invalid encrypted attachment reference');
      }
    }
    await ensureDataDir();
    await writeEncrypted(recordsFile(userId), key, envelope);
  });
}

export function getRecords(userId: string): Promise<StoredRecords> {
  return withDataAccess(() => readRecords(userId));
}

async function readRecords(userId: string): Promise<StoredRecords> {
  const { key } = await recordsKey(userId);
  const file = recordsFile(userId);
  const { data, wasMigrated } = await readMaybeEncrypted<StoredRecords>(file, key, emptyRecords());
  if (wasMigrated) {
    await ensureDataDir();
    await writeEncrypted(file, key, data);
    console.log(`[store] records-${userId}.json 已從明文遷移至加密格式`);
  }
  return data;
}

export function mergeRecords(
  userId: string,
  incoming: Partial<Record<string, object[]>>,
): Promise<Record<string, { added: number; skipped: number }>> {
  return withLock(`records:${userId}`, async () => {
    const { key } = await recordsKey(userId);
    const existing = await getRecords(userId);
    const stats: Record<string, { added: number; skipped: number }> = {};

    for (const type of RECORD_TYPES) {
      const records = (incoming[type] as object[] | undefined) ?? [];
      let added = 0;
      let skipped = 0;

      for (const rec of records) {
        const k = dedupKey(type, rec as Record<string, unknown>);
        if (k in existing[type]) {
          skipped++;
        } else {
          existing[type][k] = rec;
          added++;
        }
      }

      stats[type] = { added, skipped };
    }

    await writeEncrypted(recordsFile(userId), key, existing);
    return stats;
  });
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

// ── Backup primitives (used by admin backup import / export) ──────────────────
// These are low-level helpers for the admin backup feature (server/src/backup.ts).
// Callers hold withDataMaintenance for a consistent export or an exclusive
// restore, including snapshot rollback. These helpers deliberately bypass locks.

/** Replace the entire users file (no read-modify-write, no lock). */
export async function replaceUsers(users: User[]): Promise<void> {
  for (const user of users) assertUserId(user.id);
  await ensureDataDir();
  await writeEncrypted(USERS_FILE, deriveUsersKey(), users);
}

/** Replace the entire settings file. */
export async function replaceSettings(settings: AppSettings): Promise<void> {
  await ensureDataDir();
  await writeEncrypted(SETTINGS_FILE, deriveSettingsKey(), settings);
}

/** Replace the entire login-logs file. */
export async function replaceLoginLogs(logs: LoginLog[]): Promise<void> {
  await ensureDataDir();
  await writeEncrypted(LOGS_FILE, deriveLogsKey(), logs);
}

/** Full (unpruned, unsorted) login logs — backup export uses all entries. */
export async function getAllLoginLogs(): Promise<LoginLog[]> {
  return readLogs();
}

/**
 * Write a client-encrypted records envelope for a user, deriving the server-side
 * file key from the *given* salt rather than the stored user record. Used by
 * backup import where users.json has not been written yet and the salt must come
 * from the backup itself.
 */
export async function writeRecordsEnvelope(
  userId: string,
  saltHex: string,
  envelope: ClientEncryptedRecords,
): Promise<void> {
  if (!isClientEncryptedRecords(envelope)) {
    throw new Error('Invalid client encrypted health records envelope');
  }
  await ensureDataDir();
  const key = deriveRecordsKey(saltHex);
  await writeEncrypted(recordsFile(userId), key, envelope);
}

/** Restore an attachment using the backup user's salt, before its manifest. */
export async function writeAttachmentEnvelope(
  userId: string,
  saltHex: string,
  id: string,
  envelope: ClientEncryptedRecords,
): Promise<void> {
  const file = attachmentFile(userId, id);
  if (!isClientEncryptedRecords(envelope, true)) throw new EncryptedDataError('Invalid encrypted attachment envelope');
  await fs.mkdir(userAttachmentsDir(userId), { recursive: true, mode: 0o700 });
  await writeEncrypted(file, deriveRecordsKey(saltHex), envelope);
}

/** Remove attachments absent from a fully restored set of manifests. */
export async function pruneAttachments(
  references: Map<string, Set<string>> | ((userId: string) => Promise<Set<string> | undefined>),
): Promise<void> {
  let entries;
  try {
    entries = await fs.readdir(ATTACHMENTS_DIR, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const entry of entries) {
    const dir = path.join(ATTACHMENTS_DIR, entry.name);
    const ids = typeof references === 'function' ? await references(entry.name) : references.get(entry.name);
    if (!entry.isDirectory() || !ids?.size) {
      await fs.rm(dir, { recursive: true, force: true });
      continue;
    }
    const keep = new Set([...ids].map((id) => `${id}.json`));
    for (const name of await fs.readdir(dir)) {
      if (!keep.has(name)) await fs.rm(path.join(dir, name), { recursive: true, force: true });
    }
  }
}

/** Write legacy (not yet client-encrypted) records using the given salt. */
export async function writeLegacyRecords(
  userId: string,
  saltHex: string,
  records: StoredRecords,
): Promise<void> {
  await ensureDataDir();
  const key = deriveRecordsKey(saltHex);
  await writeEncrypted(recordsFile(userId), key, normalizeStoredRecords(records));
}

/** All userIds that currently have a records file on disk. */
export async function listRecordFileIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(DATA_DIR);
    return entries
      .map((name) => /^records-(.+)\.json$/.exec(name)?.[1])
      .filter((id): id is string => isSafeUserId(id));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** Delete a user's records file (ENOENT ignored). */
export async function deleteRecordsFile(userId: string): Promise<void> {
  await fs.unlink(recordsFile(userId)).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  });
}

/** Copy encrypted files, including all attachments, as an import safety net. */
export async function snapshotDataFiles(dirName: string): Promise<string> {
  if (!/^[A-Za-z0-9_-]+$/.test(dirName)) throw new Error('Invalid snapshot directory');
  const snapshotDir = path.join(DATA_DIR, dirName);
  await ensureDataDir();
  await fs.mkdir(snapshotDir, { mode: 0o700 });

  const names = ['users.json', 'settings.json', 'login-logs.json'];
  for (const id of await listRecordFileIds()) names.push(`records-${id}.json`);
  for (const name of names) {
    try {
      await fs.copyFile(path.join(DATA_DIR, name), path.join(snapshotDir, name));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  }
  try {
    await fs.cp(ATTACHMENTS_DIR, path.join(snapshotDir, 'attachments'), { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return snapshotDir;
}

/** Restore the exact encrypted snapshot after a failed import, while exclusive. */
export async function restoreDataSnapshot(snapshotDir: string): Promise<void> {
  const snapshotNames = new Set((await fs.readdir(snapshotDir)).filter((name) =>
    ['users.json', 'settings.json', 'login-logs.json'].includes(name) || /^records-[A-Za-z0-9_-]+\.json$/.test(name),
  ));
  for (const name of snapshotNames) {
    const file = path.join(DATA_DIR, name);
    const staging = `${file}.${crypto.randomUUID()}.restore`;
    try {
      await fs.copyFile(path.join(snapshotDir, name), staging);
      await fs.rename(staging, file);
    } finally {
      await fs.rm(staging, { force: true });
    }
  }
  const currentNames = ['users.json', 'settings.json', 'login-logs.json',
    ...(await listRecordFileIds()).map((id) => `records-${id}.json`)];
  for (const name of currentNames) {
    if (!snapshotNames.has(name)) await fs.rm(path.join(DATA_DIR, name), { force: true });
  }

  const staging = path.join(DATA_DIR, `.attachments-restore-${crypto.randomUUID()}`);
  const displaced = path.join(DATA_DIR, `.attachments-failed-${crypto.randomUUID()}`);
  let hadAttachments = false;
  try {
    try {
      await fs.cp(path.join(snapshotDir, 'attachments'), staging, { recursive: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      await fs.mkdir(staging, { mode: 0o700 });
    }
    try {
      await fs.rename(ATTACHMENTS_DIR, displaced);
      hadAttachments = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    try {
      await fs.rename(staging, ATTACHMENTS_DIR);
    } catch (err) {
      if (hadAttachments) await fs.rename(displaced, ATTACHMENTS_DIR);
      throw err;
    }
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  await fs.rm(displaced, { recursive: true, force: true });
}

// ── Login logs store ──────────────────────────────────────────────────────────

async function readLogs(): Promise<LoginLog[]> {
  return withDataAccess(async () => {
    const key = deriveLogsKey();
    const { data } = await readMaybeEncrypted<LoginLog[]>(LOGS_FILE, key, []);
    return data;
  });
}

async function writeLogs(logs: LoginLog[]): Promise<void> {
  await ensureDataDir();
  const key = deriveLogsKey();
  await writeEncrypted(LOGS_FILE, key, logs);
}

export function addLoginLog(log: Omit<LoginLog, 'id'>): Promise<LoginLog> {
  return withLock('logs', async () => {
    const logs = await readLogs();
    const entry: LoginLog = { id: crypto.randomUUID(), ...log };
    logs.push(entry);
    // Prune to MAX_LOGS (keep most recent)
    const pruned = logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs;
    await writeLogs(pruned);
    return entry;
  });
}

/** Get login logs. userId = undefined → all logs (admin). userId set → user's own successful logins only. */
export async function getLoginLogs(userId?: string, limit = 100): Promise<LoginLog[]> {
  const logs = await readLogs();
  const filtered = userId
    ? logs.filter((l) => l.userId === userId && l.success)
    : logs;
  return filtered.slice(-limit).reverse();
}

/** Update country field async after IP lookup. */
export function updateLogCountry(logId: string, country: string): Promise<void> {
  return withLock('logs', async () => {
    const logs = await readLogs();
    const idx = logs.findIndex((l) => l.id === logId);
    if (idx !== -1) {
      logs[idx] = { ...logs[idx], country };
      await writeLogs(logs);
    }
  });
}

/** Delete specific log entries (admin batch delete). */
export function deleteLoginLogs(ids: string[]): Promise<number> {
  return withLock('logs', async () => {
    const idSet = new Set(ids);
    const logs = await readLogs();
    const filtered = logs.filter((l) => !idSet.has(l.id));
    const deleted = logs.length - filtered.length;
    await writeLogs(filtered);
    return deleted;
  });
}

// ── App settings store ────────────────────────────────────────────────────────

async function readSettings(): Promise<AppSettings> {
  return withDataAccess(readSettingsUnlocked);
}

async function readSettingsUnlocked(): Promise<AppSettings> {
  const key = deriveSettingsKey();
  const { data } = await readMaybeEncrypted<AppSettings>(SETTINGS_FILE, key, DEFAULT_SETTINGS);
  // Merge with defaults to handle missing fields on upgrade
  return { ...DEFAULT_SETTINGS, ...data };
}

async function writeSettings(settings: AppSettings): Promise<void> {
  await ensureDataDir();
  const key = deriveSettingsKey();
  await writeEncrypted(SETTINGS_FILE, key, settings);
}

export async function getSettings(): Promise<AppSettings> {
  return readSettings();
}

export function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return withLock('settings', async () => {
    const current = await readSettings();
    const updated = { ...current, ...patch };
    await writeSettings(updated);
    return updated;
  });
}

/**
 * Check if a given email address is allowed to self-register.
 *
 * Rules (in priority order):
 * 1. No users exist → always allow (first admin account)
 * 2. allowedRegistrationEmails not empty → only listed emails allowed
 * 3. allowedRegistrationEmails empty + publicRegistration true → any email allowed
 * 4. allowedRegistrationEmails empty + publicRegistration false → denied
 */
export async function canSelfRegister(email: string | null): Promise<boolean> {
  const count = await userCount();
  if (count === 0) return true;

  const settings = await readSettings();

  if (settings.allowedRegistrationEmails.length > 0) {
    if (!email) return false;
    return settings.allowedRegistrationEmails
      .map((e) => e.trim().toLowerCase())
      .includes(email.toLowerCase());
  }

  return settings.publicRegistration;
}

// ── Dedup key functions ───────────────────────────────────────────────────────

function field(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return v != null ? String(v) : '';
}

function dedupKey(type: string, rec: Record<string, unknown>): string {
  switch (type) {
    case 'r1': // outpatient: hospital + date + dept
      return `${field(rec, 'r1.4')}_${field(rec, 'r1.5')}_${field(rec, 'r1.7')}`;
    case 'r2': // hospitalization: hospital + admit + discharge
      return `${field(rec, 'r2.4')}_${field(rec, 'r2.5')}_${field(rec, 'r2.6')}`;
    case 'r3': // dental: hospital + date + dept
      return `${field(rec, 'r3.4')}_${field(rec, 'r3.5')}_${field(rec, 'r3.7')}`;
    case 'r6': // vaccination: date + vaccine
      return `${field(rec, 'r6.1')}_${field(rec, 'r6.3')}`;
    case 'r7': // lab result: hospital + date + order + subitem
      return `${field(rec, 'r7.4')}_${field(rec, 'r7.5')}_${field(rec, 'r7.7')}_${field(rec, 'r7.10')}`;
    case 'r8': // checkup: hospital + date + exam code
      return `${field(rec, 'r8.4')}_${field(rec, 'r8.5')}_${field(rec, 'r8.8')}`;
    default:
      return JSON.stringify(rec);
  }
}
