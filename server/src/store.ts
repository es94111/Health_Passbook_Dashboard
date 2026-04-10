import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {
  deriveUsersKey,
  deriveRecordsKey,
  readMaybeEncrypted,
  writeEncrypted,
} from './crypto.js';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
  encryptionSalt: string; // 32-byte hex — derived to produce per-user records key
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
    // Re-encrypt the users file (migration)
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

export async function createUser(user: Omit<User, 'encryptionSalt'>): Promise<void> {
  const users = await readUsers();
  const fullUser: User = {
    ...user,
    encryptionSalt: crypto.randomBytes(32).toString('hex'),
  };
  users.push(fullUser);
  await writeUsers(users);
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

// ── Health records store ──────────────────────────────────────────────────────

function recordsFile(userId: string): string {
  return path.join(DATA_DIR, `records-${userId}.json`);
}

/**
 * Resolve the encryption key for a given user.
 * Handles the migration case where encryptionSalt may be absent on old users
 * (in practice readUsers() already backfills it, but be defensive).
 */
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
    // Re-write as encrypted (lazy migration — happens once per file)
    await ensureDataDir();
    await writeEncrypted(file, key, data);
    console.log(`[store] records-${userId}.json 已從明文遷移至加密格式`);
  }
  return data;
}

/**
 * Merge new NHI JSON into existing stored records.
 * Uses INSERT-OR-IGNORE semantics: existing records are never overwritten.
 * Returns counts of new vs duplicate records per type.
 */
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

/**
 * Flatten StoredRecords back into NHI-style arrays for the frontend parser.
 */
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
