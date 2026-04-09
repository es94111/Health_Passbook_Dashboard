import fs from 'fs/promises';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  isAdmin: boolean;
  createdAt: string;
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

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(file, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, data: unknown): Promise<void> {
  await ensureDataDir();
  await fs.writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

// ── User store ────────────────────────────────────────────────────────────────

export async function getUsers(): Promise<User[]> {
  return readJson<User[]>(USERS_FILE, []);
}

export async function getUserById(id: string): Promise<User | undefined> {
  const users = await getUsers();
  return users.find((u) => u.id === id);
}

export async function getUserByUsername(username: string): Promise<User | undefined> {
  const users = await getUsers();
  return users.find((u) => u.username === username);
}

export async function createUser(user: User): Promise<void> {
  const users = await getUsers();
  users.push(user);
  await writeJson(USERS_FILE, users);
}

export async function deleteUser(id: string): Promise<boolean> {
  const users = await getUsers();
  const filtered = users.filter((u) => u.id !== id);
  if (filtered.length === users.length) return false;
  await writeJson(USERS_FILE, filtered);
  // Also remove their health records
  const recordFile = recordsFile(id);
  await fs.unlink(recordFile).catch(() => undefined);
  return true;
}

export async function userCount(): Promise<number> {
  const users = await getUsers();
  return users.length;
}

// ── Health records store ──────────────────────────────────────────────────────

function recordsFile(userId: string): string {
  return path.join(DATA_DIR, `records-${userId}.json`);
}

export async function getRecords(userId: string): Promise<StoredRecords> {
  return readJson<StoredRecords>(recordsFile(userId), emptyRecords());
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
  const existing = await getRecords(userId);
  const stats: Record<string, { added: number; skipped: number }> = {};

  const types = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8'] as const;

  for (const type of types) {
    const records = (incoming[type] as object[] | undefined) ?? [];
    let added = 0;
    let skipped = 0;

    for (const rec of records) {
      const key = dedupKey(type, rec as Record<string, unknown>);
      if (key in existing[type]) {
        skipped++;
      } else {
        existing[type][key] = rec;
        added++;
      }
    }

    stats[type] = { added, skipped };
  }

  await writeJson(recordsFile(userId), existing);
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