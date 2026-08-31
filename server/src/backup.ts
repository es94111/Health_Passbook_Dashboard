/**
 * Admin backup bundle: export (decrypt to plaintext JSON) and import (validate,
 * fully replace, re-encrypt with the current environment key).
 *
 * The backup file contains server-side data in PLAINTEXT (users incl. password
 * hashes, settings, login logs) and health records as opaque client-encrypted
 * envelopes. The master key is never included — import re-encrypts everything
 * with the current environment's master key, which makes key migration automatic:
 * restoring on a machine with a different ENCRYPTION_KEY "just works".
 */

import type {
  User,
  AppSettings,
  LoginLog,
  StoredRecords,
  ClientEncryptedRecords,
} from './store.js';
import {
  DEFAULT_SETTINGS,
  isClientEncryptedRecords,
  normalizeStoredRecords,
  getUsers,
  getSettings,
  getAllLoginLogs,
  getHealthDataForClient,
  getRecords,
  replaceUsers,
  replaceSettings,
  replaceLoginLogs,
  writeRecordsEnvelope,
  writeLegacyRecords,
  listRecordFileIds,
  deleteRecordsFile,
  snapshotDataFiles,
  addLoginLog,
} from './store.js';

// ── Backup file schema ────────────────────────────────────────────────────────

export const BACKUP_FORMAT = 'nhi-dashboard-backup';
export const BACKUP_VERSION = 1;

export type BackupRecordKind = 'client-encrypted' | 'legacy' | 'corrupt';

export interface BackupRecordEntry {
  userId: string;
  username: string; // redundant, for human inspection
  kind: BackupRecordKind;
  envelope: ClientEncryptedRecords | null; // kind === 'client-encrypted'
  legacyRecords: StoredRecords | null;     // kind === 'legacy'
  error?: string;                          // kind === 'corrupt'
}

export interface BackupCounts {
  users: number;
  withRecords: number;
  legacyRecords: number;
  loginLogs: number;
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  counts: BackupCounts;
  data: {
    users: User[];
    settings: AppSettings;
    loginLogs: LoginLog[];
  };
  records: BackupRecordEntry[];
}

export interface ImportStats {
  users: number;
  settings: boolean;
  loginLogs: number;
  recordsRestored: number;
  orphanRecordsDeleted: number;
  warnings: string[];
}

interface ValidatedBackup {
  bundle: BackupFile;
  warnings: string[];
}

const HEX64_RE = /^[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

// ── Export ────────────────────────────────────────────────────────────────────

/**
 * Build the backup bundle from current data. A single user's unreadable records
 * file does not fail the whole export — it is marked kind='corrupt' with an
 * error message so the admin gets as much data back as possible.
 */
export async function buildBackupBundle(): Promise<BackupFile> {
  const users = await getUsers();
  const settings = await getSettings();
  const loginLogs = await getAllLoginLogs();

  const records: BackupRecordEntry[] = [];
  let withRecords = 0;
  let legacyRecords = 0;

  for (const user of users) {
    try {
      const { envelope, needsClientEncryptionMigration } = await getHealthDataForClient(user.id);
      if (envelope) {
        records.push({
          userId: user.id,
          username: user.username,
          kind: 'client-encrypted',
          envelope,
          legacyRecords: null,
        });
        withRecords += 1;
      } else if (needsClientEncryptionMigration) {
        // Records exist in legacy (server-side plaintext) format — export them so
        // import can rewrite them in the current encrypted format.
        const legacy = await getRecords(user.id);
        records.push({
          userId: user.id,
          username: user.username,
          kind: 'legacy',
          envelope: null,
          legacyRecords: legacy,
        });
        withRecords += 1;
        legacyRecords += 1;
      }
      // No records file → user is listed under data.users only.
    } catch (err) {
      records.push({
        userId: user.id,
        username: user.username,
        kind: 'corrupt',
        envelope: null,
        legacyRecords: null,
        error: (err as Error).message ?? '紀錄檔讀取失敗',
      });
      withRecords += 1;
    }
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: {
      users: users.length,
      withRecords,
      legacyRecords,
      loginLogs: loginLogs.length,
    },
    data: { users, settings, loginLogs },
    records,
  };
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateUser(raw: unknown, seenIds: Set<string>, seenUsernames: Set<string>, userName: string): User {
  if (!isRecord(raw)) throw new Error(`使用者資料格式錯誤：${userName}`);
  const username = typeof raw.username === 'string' ? raw.username : '';
  const label = username || userName;

  if (typeof raw.id !== 'string' || raw.id.length === 0) {
    throw new Error(`使用者「${label}」缺少 id`);
  }
  if (seenIds.has(raw.id)) throw new Error(`使用者「${label}」的 id 重複`);
  if (typeof raw.username !== 'string' || raw.username.length < 3 || raw.username.length > 32) {
    throw new Error(`使用者「${label}」的帳號長度需在 3-32 字元之間`);
  }
  if (seenUsernames.has(raw.username)) throw new Error(`帳號「${raw.username}」重複`);
  if (typeof raw.isAdmin !== 'boolean') throw new Error(`使用者「${label}」缺少 isAdmin`);
  if (typeof raw.passwordHash !== 'string') throw new Error(`使用者「${label}」缺少 passwordHash（Google-only 帳號可為空字串）`);
  if (typeof raw.encryptionSalt !== 'string' || !HEX64_RE.test(raw.encryptionSalt)) {
    throw new Error(`使用者「${label}」缺少有效的 encryptionSalt（應為 64 個 hex 字元）`);
  }
  if (!isDateString(raw.createdAt)) throw new Error(`使用者「${label}」的 createdAt 無效`);
  for (const key of ['googleId', 'googleEmail', 'displayName', 'themeMode', 'avatarUrl']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'string') {
      throw new Error(`使用者「${label}」的 ${key} 必須為字串`);
    }
  }
  if (raw.preferences !== undefined && !isRecord(raw.preferences)) {
    throw new Error(`使用者「${label}」的 preferences 必須為物件`);
  }

  return raw as unknown as User;
}

function validateSettings(raw: unknown, warnings: string[]): AppSettings {
  if (raw === undefined) {
    warnings.push('備份檔缺少系統設定，還原時將使用預設值');
    return { ...DEFAULT_SETTINGS };
  }
  if (!isRecord(raw)) throw new Error('系統設定格式錯誤');

  const settings: AppSettings = { ...DEFAULT_SETTINGS };
  if (raw.publicRegistration !== undefined) {
    if (typeof raw.publicRegistration !== 'boolean') throw new Error('publicRegistration 必須為 boolean');
    settings.publicRegistration = raw.publicRegistration;
  }
  const listFields = ['allowedRegistrationEmails', 'adminIpAllowlist'] as const;
  for (const field of listFields) {
    const value = raw[field];
    if (value === undefined) {
      warnings.push(`系統設定缺少 ${field}，還原時將使用空清單`);
      continue;
    }
    if (!isStringArray(value)) throw new Error(`${field} 必須為字串陣列`);
    settings[field] = value.map((e) => e.trim()).filter(Boolean);
  }
  return settings;
}

function validateLoginLogs(raw: unknown, warnings: string[]): LoginLog[] {
  if (raw === undefined) {
    warnings.push('備份檔缺少登入記錄，還原後登入記錄將為空');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('登入記錄必須為陣列');

  const logs: LoginLog[] = [];
  let dropped = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) { dropped += 1; continue; }
    const method = entry.method;
    if (
      typeof entry.id !== 'string' ||
      typeof entry.username !== 'string' ||
      typeof entry.isAdmin !== 'boolean' ||
      (method !== 'password' && method !== 'google') ||
      typeof entry.success !== 'boolean' ||
      typeof entry.ip !== 'string' ||
      !isDateString(entry.timestamp)
    ) {
      dropped += 1;
      continue;
    }
    logs.push({
      id: entry.id,
      userId: typeof entry.userId === 'string' ? entry.userId : null,
      username: entry.username,
      isAdmin: entry.isAdmin,
      method,
      success: entry.success,
      failReason: typeof entry.failReason === 'string' ? entry.failReason : undefined,
      ip: entry.ip,
      country: typeof entry.country === 'string' ? entry.country : undefined,
      timestamp: entry.timestamp,
      action: typeof entry.action === 'string' ? entry.action : undefined,
      note: typeof entry.note === 'string' ? entry.note : undefined,
    });
  }
  if (dropped > 0) warnings.push(`登入記錄有 ${dropped} 筆格式不符已略過`);
  return logs;
}

function validateRecords(
  raw: unknown,
  users: User[],
  warnings: string[],
): BackupRecordEntry[] {
  if (raw === undefined) {
    warnings.push('備份檔缺少健康紀錄區塊，還原後所有使用者將沒有健康資料');
    return [];
  }
  if (!Array.isArray(raw)) throw new Error('健康紀錄必須為陣列');

  const userById = new Map(users.map((u) => [u.id, u]));
  const seen = new Set<string>();
  const records: BackupRecordEntry[] = [];

  for (const entry of raw) {
    if (!isRecord(entry)) throw new Error('健康紀錄條目格式錯誤');

    const userId = entry.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new Error('健康紀錄條目缺少 userId');
    }
    if (seen.has(userId)) throw new Error(`使用者 ${userId} 的健康紀錄重複`);
    const user = userById.get(userId);
    if (!user) {
      warnings.push(`備份中有健康紀錄對應不到使用者（userId=${userId}），將予以略過`);
      continue;
    }
    const kind = entry.kind;

    if (kind === 'client-encrypted') {
      if (!isClientEncryptedRecords(entry.envelope)) {
        throw new Error(`使用者「${user.username}」的加密信封格式錯誤`);
      }
      // Note: envelope.salt (client PBKDF2 salt) is unrelated to the server-side
      // encryptionSalt — the envelope is opaque and restored verbatim. The
      // server-side file key is derived from the user's own encryptionSalt.
      records.push({ userId, username: user.username, kind, envelope: entry.envelope, legacyRecords: null });
    } else if (kind === 'legacy') {
      if (!isRecord(entry.legacyRecords)) {
        throw new Error(`使用者「${user.username}」的舊格式健康紀錄缺失或格式錯誤`);
      }
      records.push({
        userId,
        username: user.username,
        kind,
        envelope: null,
        legacyRecords: normalizeStoredRecords(entry.legacyRecords),
      });
    } else if (kind === 'corrupt') {
      if (entry.envelope !== null || entry.legacyRecords !== null) {
        throw new Error(`使用者「${user.username}」的 corrupt 紀錄不應攜帶資料`);
      }
      records.push({
        userId,
        username: user.username,
        kind,
        envelope: null,
        legacyRecords: null,
        error: typeof entry.error === 'string' ? entry.error : undefined,
      });
    } else {
      throw new Error(`使用者「${user.username}」的紀錄 kind 無法識別（${String(kind)}）`);
    }
    seen.add(userId);
  }
  return records;
}

/** Strictly validate an unknown parsed backup file. Throws with a Chinese message on any hard error. */
export function validateBackupBundle(raw: unknown): ValidatedBackup {
  const warnings: string[] = [];

  if (!isRecord(raw)) throw new Error('備份檔格式錯誤');
  if (raw.format !== BACKUP_FORMAT) throw new Error('不是本系統的備份檔');
  if (raw.version !== BACKUP_VERSION) throw new Error(`備份檔版本不支援（version ${String(raw.version)}）`);
  if (!isDateString(raw.exportedAt)) throw new Error('備份檔缺少有效的匯出時間');

  if (!isRecord(raw.data)) throw new Error('備份檔缺少資料區塊');
  const rawUsers = raw.data.users;
  if (!Array.isArray(rawUsers)) throw new Error('備份檔的使用者清單格式錯誤');
  if (rawUsers.length === 0) throw new Error('備份檔不含任何使用者，還原會導致系統無法登入，已拒絕');

  const seenIds = new Set<string>();
  const seenUsernames = new Set<string>();
  const users = rawUsers.map((u, i) => validateUser(u, seenIds, seenUsernames, `#${i + 1}`));

  const settings = validateSettings(raw.data.settings, warnings);
  const loginLogs = validateLoginLogs(raw.data.loginLogs, warnings);
  const records = validateRecords(raw.records, users, warnings);

  const hasAdmin = users.some((u) => u.isAdmin);
  if (!hasAdmin) warnings.push('備份檔中沒有管理員帳號，還原後將無法進入管理功能');

  return {
    bundle: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      exportedAt: raw.exportedAt,
      counts: {
        users: users.length,
        withRecords: records.filter((r) => r.kind !== 'corrupt').length,
        legacyRecords: records.filter((r) => r.kind === 'legacy').length,
        loginLogs: loginLogs.length,
      },
      data: { users, settings, loginLogs },
      records,
    },
    warnings,
  };
}

// ── Import (full replace) ─────────────────────────────────────────────────────

/**
 * Validate then fully replace current data with the backup.
 *
 * Safety: a snapshot of all current files is taken into data/pre-import-<ts>/
 * before writing. Write order is records → settings → login-logs → users.json;
 * users.json is written LAST and acts as the commit point — an interrupted import
 * leaves existing users (and sessions) intact, and the error carries the snapshot
 * path for manual restore.
 */
export async function importBackupBundle(raw: unknown): Promise<ImportStats> {
  const { bundle, warnings } = validateBackupBundle(raw);

  let snapshotDir: string | null = null;
  try {
    snapshotDir = await snapshotDataFiles(`pre-import-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  } catch (err) {
    throw new Error(`無法建立匯入前快照，已中止還原：${(err as Error).message}`);
  }

  try {
    const users = bundle.data.users;
    const userSalt = new Map(users.map((u) => [u.id, u.encryptionSalt]));

    // 1. Records files (fail-fast per file; users.json not yet touched)
    for (const record of bundle.records) {
      const salt = userSalt.get(record.userId)!;
      if (record.kind === 'client-encrypted' && record.envelope) {
        await deleteRecordsFile(record.userId);
        await writeRecordsEnvelope(record.userId, salt, record.envelope);
      } else if (record.kind === 'legacy' && record.legacyRecords) {
        await deleteRecordsFile(record.userId);
        await writeLegacyRecords(record.userId, salt, record.legacyRecords);
      } else if (record.kind === 'corrupt') {
        // The original file was unreadable — drop any stale file for this user.
        await deleteRecordsFile(record.userId);
        warnings.push(`使用者「${record.username}」的紀錄在備份時已損毀，未還原任何健康資料`);
      }
    }

    // 2-3. Settings and login logs
    await replaceSettings(bundle.data.settings);
    await replaceLoginLogs(bundle.data.loginLogs);

    // 4. users.json LAST — commit point
    await replaceUsers(users);

    // 5. Purge record files belonging to users that no longer exist
    const userIds = new Set(users.map((u) => u.id));
    const orphans = (await listRecordFileIds()).filter((id) => !userIds.has(id));
    for (const id of orphans) {
      await deleteRecordsFile(id);
    }

    // After replaceLoginLogs, add the audit entry so it survives in the restored logs
    await addLoginLog({
      userId: null,
      username: 'system',
      isAdmin: true,
      method: 'password',
      success: true,
      ip: 'system',
      timestamp: new Date().toISOString(),
      action: 'admin-import',
      note: `users=${users.length} records=${bundle.records.length} orphanDeleted=${orphans.length}`,
    });

    return {
      users: users.length,
      settings: true,
      loginLogs: bundle.data.loginLogs.length,
      recordsRestored: bundle.records.filter((r) => r.kind !== 'corrupt').length,
      orphanRecordsDeleted: orphans.length,
      warnings,
    };
  } catch (err) {
    throw new Error(
      `還原過程中發生錯誤，已寫入的資料可能不完整。匯入前的原始資料已備份於：${snapshotDir}。` +
        `可將該目錄下的檔案複製回 data/ 手動還原。錯誤：${(err as Error).message}`,
    );
  }
}