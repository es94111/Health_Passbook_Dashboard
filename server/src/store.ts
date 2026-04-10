import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
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

function emptyRecords(): StoredRecords {
  return { r1: {}, r2: {}, r3: {}, r6: {}, r7: {}, r8: {} };
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
}

const MAX_LOGS = 1000;

// ── App settings ──────────────────────────────────────────────────────────────

export interface AppSettings {
  publicRegistration: boolean;
  allowedRegistrationEmails: string[];  // each line one email/domain; empty = no restriction
  adminIpAllowlist: string[];           // merged with ENV_ADMIN_IP_ALLOWLIST at runtime
}

const DEFAULT_SETTINGS: AppSettings = {
  publicRegistration: true,
  allowedRegistrationEmails: [],
  adminIpAllowlist: [],
};

// ── File helpers ──────────────────────────────────────────────────────────────

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

// ── User store ────────────────────────────────────────────────────────────────

async function readUsers(): Promise<User[]> {
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

export async function createUser(user: Omit<User, 'encryptionSalt'>): Promise<void> {
  const users = await readUsers();
  const fullUser: User = {
    ...user,
    encryptionSalt: crypto.randomBytes(32).toString('hex'),
  };
  users.push(fullUser);
  await writeUsers(users);
}

export async function updateUser(id: string, patch: Partial<Omit<User, 'id' | 'encryptionSalt'>>): Promise<User | null> {
  const users = await readUsers();
  const idx = users.findIndex((u) => u.id === id);
  if (idx === -1) return null;
  users[idx] = { ...users[idx], ...patch };
  await writeUsers(users);
  return users[idx];
}

export async function deleteUser(id: string): Promise<boolean> {
  const users = await readUsers();
  const filtered = users.filter((u) => u.id !== id);
  if (filtered.length === users.length) return false;
  await writeUsers(filtered);
  // Also remove their health records
  const recordFile = recordsFile(id);
  await fs.unlink(recordFile).catch(() => undefined);
  return true;
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

function recordsFile(userId: string): string {
  return path.join(DATA_DIR, `records-${userId}.json`);
}

async function recordsKey(userId: string): Promise<{ key: ReturnType<typeof deriveRecordsKey>; user: User }> {
  const user = await getUserById(userId);
  if (!user) throw new Error(`使用者 ${userId} 不存在`);
  return { key: deriveRecordsKey(user.encryptionSalt), user };
}

export async function getRecords(userId: string): Promise<StoredRecords> {
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

export async function mergeRecords(
  userId: string,
  incoming: Partial<Record<string, object[]>>,
): Promise<Record<string, { added: number; skipped: number }>> {
  const { key } = await recordsKey(userId);
  const existing = await getRecords(userId);
  const stats: Record<string, { added: number; skipped: number }> = {};

  const types = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8'] as const;

  for (const type of types) {
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

// ── Login logs store ──────────────────────────────────────────────────────────

async function readLogs(): Promise<LoginLog[]> {
  const key = deriveLogsKey();
  const { data } = await readMaybeEncrypted<LoginLog[]>(LOGS_FILE, key, []);
  return data;
}

async function writeLogs(logs: LoginLog[]): Promise<void> {
  await ensureDataDir();
  const key = deriveLogsKey();
  await writeEncrypted(LOGS_FILE, key, logs);
}

export async function addLoginLog(log: Omit<LoginLog, 'id'>): Promise<LoginLog> {
  const logs = await readLogs();
  const entry: LoginLog = { id: crypto.randomUUID(), ...log };
  logs.push(entry);
  // Prune to MAX_LOGS (keep most recent)
  const pruned = logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs;
  await writeLogs(pruned);
  return entry;
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
export async function updateLogCountry(logId: string, country: string): Promise<void> {
  const logs = await readLogs();
  const idx = logs.findIndex((l) => l.id === logId);
  if (idx !== -1) {
    logs[idx] = { ...logs[idx], country };
    await writeLogs(logs);
  }
}

/** Delete specific log entries (admin batch delete). */
export async function deleteLoginLogs(ids: string[]): Promise<number> {
  const idSet = new Set(ids);
  const logs = await readLogs();
  const filtered = logs.filter((l) => !idSet.has(l.id));
  const deleted = logs.length - filtered.length;
  await writeLogs(filtered);
  return deleted;
}

// ── App settings store ────────────────────────────────────────────────────────

async function readSettings(): Promise<AppSettings> {
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

export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await readSettings();
  const updated = { ...current, ...patch };
  await writeSettings(updated);
  return updated;
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
