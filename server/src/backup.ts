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

import crypto from 'node:crypto';
import { withDataMaintenance } from './dataAccess.js';
import { assertBackupByteLength, backupJsonByteLength } from './backupLimits.js';
import { isAttachmentId, isSafeUserId } from './clientEncryption.js';
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
  writeAttachmentEnvelope,
  getEncryptedAttachment,
  pruneAttachments,
  restoreDataSnapshot,
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
  attachments?: Record<string, ClientEncryptedRecords>; // exactly the manifest's referenced IDs
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
export function buildBackupBundle(): Promise<BackupFile> {
  return withDataMaintenance(buildBackupBundleUnlocked);
}

async function buildBackupBundleUnlocked(): Promise<BackupFile> {
  const users = await getUsers();
  const settings = await getSettings();
  const loginLogs = await getAllLoginLogs();
  const bundle: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    counts: { users: users.length, withRecords: 0, legacyRecords: 0, loginLogs: loginLogs.length },
    data: { users, settings, loginLogs },
    records: [],
  };
  const metadataBytes = backupJsonByteLength(bundle);
  assertBackupByteLength(metadataBytes);
  let recordBytes = 0;
  const accountBytes = (bytes: number): void => {
    recordBytes += bytes;
    assertBackupByteLength(metadataBytes + recordBytes);
  };
  const appendRecord = (entry: BackupRecordEntry): void => {
    accountBytes(backupJsonByteLength(entry) + (bundle.records.length ? 1 : 0));
    bundle.records.push(entry);
    bundle.counts.withRecords += 1;
  };

  for (const user of users) {
    let health;
    try {
      health = await getHealthDataForClient(user.id);
    } catch {
      appendRecord({
        userId: user.id, username: user.username, kind: 'corrupt',
        envelope: null, legacyRecords: null, error: '加密紀錄檔讀取失敗',
      });
      continue;
    }
    const { envelope, needsClientEncryptionMigration } = health;
    if (envelope) {
      const ids = envelope.attachmentIds ?? [];
      const attachments: Record<string, ClientEncryptedRecords> = {};
      appendRecord({
        userId: user.id, username: user.username, kind: 'client-encrypted',
        envelope, legacyRecords: null,
        ...(ids.length ? { attachments } : {}),
      });
      for (const id of ids) {
        let attachment: ClientEncryptedRecords;
        try {
          const stored = await getEncryptedAttachment(user.id, id);
          if (!stored) throw new Error('Missing attachment');
          attachment = stored;
        } catch {
          // Never produce a seemingly restorable manifest that is missing bytes.
          throw new Error('無法完整匯出備份：健康紀錄參照的加密附件缺失或損毀');
        }
        accountBytes(backupJsonByteLength(id) + 1 + backupJsonByteLength(attachment) +
          (Object.keys(attachments).length ? 1 : 0));
        attachments[id] = attachment;
      }
    } else if (needsClientEncryptionMigration) {
      const legacy = await getRecords(user.id);
      appendRecord({
        userId: user.id, username: user.username, kind: 'legacy',
        envelope: null, legacyRecords: legacy,
      });
      bundle.counts.legacyRecords += 1;
    }
  }

  // Count each attachment as it loads, rather than assembling an unbounded JSON
  // string. Recount metadata for the final count digits before allowing export.
  assertBackupByteLength(backupJsonByteLength({ ...bundle, records: [] }) + recordBytes);
  return bundle;
}

// ── Validation ────────────────────────────────────────────────────────────────

function validateUser(raw: unknown, seenIds: Set<string>, seenUsernames: Set<string>, userName: string): User {
  if (!isRecord(raw)) throw new Error(`使用者資料格式錯誤：${userName}`);
  const username = typeof raw.username === 'string' ? raw.username : '';
  const label = username || userName;

  if (!isSafeUserId(raw.id)) {
    throw new Error(`使用者「${label}」的 id 無效`);
  }
  if (seenIds.has(raw.id.toLowerCase())) throw new Error(`使用者「${label}」的 id 重複`);
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

  seenIds.add(raw.id.toLowerCase());
  seenUsernames.add(raw.username);
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

function validateAttachments(
  raw: unknown,
  envelope: ClientEncryptedRecords | null,
): Record<string, ClientEncryptedRecords> | undefined {
  const expected = new Set(envelope?.attachmentIds ?? []);
  if (raw === undefined) {
    if (expected.size) throw new Error('備份缺少健康紀錄參照的加密附件');
    return undefined;
  }
  if (!isRecord(raw)) throw new Error('加密附件必須為以 UUID 為鍵的物件');
  const entries = Object.entries(raw);
  if (entries.length !== expected.size) throw new Error('加密附件與健康紀錄參照不相符');
  for (const [id, attachment] of entries) {
    if (!isAttachmentId(id) || !expected.has(id)) throw new Error('加密附件包含無效或不屬於此紀錄的鍵');
    if (!isClientEncryptedRecords(attachment, true)) throw new Error('加密附件信封格式錯誤');
  }
  return Object.fromEntries(entries) as Record<string, ClientEncryptedRecords>;
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
    const record = validateBackupRecordMetadata(entry, userById, seen);
    const attachments = validateAttachments((entry as Record<string, unknown>).attachments, record.envelope);
    records.push({ ...record, ...(attachments ? { attachments } : {}) });
  }
  return records;
}

/** Validate a record without collecting its potentially multi-GB attachment set. */
export function validateBackupRecordMetadata(
  entry: unknown, userById: Map<string, User>, seen: Set<string>,
): BackupRecordEntry {
  if (!isRecord(entry)) throw new Error('健康紀錄條目格式錯誤');
  const { userId, kind } = entry;
  if (!isSafeUserId(userId)) throw new Error('健康紀錄條目的 userId 無效');
  if (seen.has(userId)) throw new Error(`使用者 ${userId} 的健康紀錄重複`);
  const user = userById.get(userId);
  if (!user) throw new Error('備份包含不屬於備份使用者的健康紀錄');
  let record: BackupRecordEntry;
  if (kind === 'client-encrypted') {
    if (!isClientEncryptedRecords(entry.envelope)) {
      throw new Error(`使用者「${user.username}」的加密信封格式錯誤`);
    }
    record = { userId, username: user.username, kind, envelope: entry.envelope, legacyRecords: null };
  } else if (kind === 'legacy') {
    if (!isRecord(entry.legacyRecords)) throw new Error(`使用者「${user.username}」的舊格式健康紀錄缺失或格式錯誤`);
    record = { userId, username: user.username, kind, envelope: null, legacyRecords: normalizeStoredRecords(entry.legacyRecords) };
  } else if (kind === 'corrupt') {
    throw new Error('備份含無法還原的損毀紀錄，為避免資料遺失已中止還原');
  } else {
    throw new Error(`使用者「${user.username}」的紀錄 kind 無法識別（${String(kind)}）`);
  }
  seen.add(userId);
  return record;
}

/** Strictly validate an unknown parsed backup file. Throws with a Chinese message on any hard error. */
export function validateBackupBundle(raw: unknown): ValidatedBackup {
  const warnings: string[] = [];

  if (!isRecord(raw)) throw new Error('備份檔格式錯誤');
  assertBackupByteLength(backupJsonByteLength(raw));
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
 * The exclusive data gate prevents uploads/deletions from racing the snapshot.
 * Attachments are written before manifests; caught failures automatically restore
 * the encrypted snapshot. The retained snapshot is also a safety net for process
 * interruption or disk failure.
 */
export interface BackupRestoreSource {
  metadata: Omit<BackupFile, 'records'>;
  warnings: string[];
  recordCount: number;
  readRecord(index: number): Promise<BackupRecordEntry>;
  readAttachment(index: number, id: string): Promise<ClientEncryptedRecords>;
}

export async function importBackupBundle(raw: unknown): Promise<ImportStats> {
  const { bundle, warnings } = validateBackupBundle(raw);
  return restoreBackupSource({
    metadata: bundle, warnings, recordCount: bundle.records.length,
    readRecord: async (index) => bundle.records[index],
    readAttachment: async (index, id) => bundle.records[index].attachments![id],
  });
}

export function restoreBackupSource(source: BackupRestoreSource, signal?: AbortSignal): Promise<ImportStats> {
  return withDataMaintenance(() => importValidatedBackup(source, signal));
}

async function importValidatedBackup(source: BackupRestoreSource, signal?: AbortSignal): Promise<ImportStats> {
  const { metadata: bundle, warnings } = source;
  signal?.throwIfAborted();
  let snapshotDir: string;
  try {
    snapshotDir = await snapshotDataFiles(`pre-import-${crypto.randomUUID()}`);
  } catch (err) {
    throw new Error(`無法建立匯入前快照，已中止還原：${(err as Error).message}`);
  }

  try {
    const users = bundle.data.users;
    const userSalt = new Map(users.map((u) => [u.id, u.encryptionSalt]));

    const restored = new Map<string, number>();
    for (let index = 0; index < source.recordCount; index++) {
      signal?.throwIfAborted();
      const record = await source.readRecord(index);
      const salt = userSalt.get(record.userId)!;
      if (record.kind === 'client-encrypted' && record.envelope) {
        for (const id of record.envelope.attachmentIds ?? []) {
          signal?.throwIfAborted();
          await writeAttachmentEnvelope(record.userId, salt, id, await source.readAttachment(index, id));
        }
        await writeRecordsEnvelope(record.userId, salt, record.envelope);
      } else if (record.kind === 'legacy' && record.legacyRecords) {
        await writeLegacyRecords(record.userId, salt, record.legacyRecords);
      }
      restored.set(record.userId, index);
    }
    signal?.throwIfAborted();

    // 2-3. Settings and login logs
    await replaceSettings(bundle.data.settings);
    await replaceLoginLogs(bundle.data.loginLogs);

    // Publish users after all encrypted files have been written.
    await replaceUsers(users);

    // Full replace also clears omitted records for users retained by the backup.
    const orphans = (await listRecordFileIds()).filter((id) => !restored.has(id));
    for (const id of orphans) {
      signal?.throwIfAborted();
      await deleteRecordsFile(id);
    }
    await pruneAttachments(async (userId) => {
      signal?.throwIfAborted();
      const index = restored.get(userId);
      return index === undefined ? undefined : new Set((await source.readRecord(index)).envelope?.attachmentIds ?? []);
    });
    signal?.throwIfAborted();

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
      note: `users=${users.length} records=${source.recordCount} orphanDeleted=${orphans.length}`,
    });

    return {
      users: users.length,
      settings: true,
      loginLogs: bundle.data.loginLogs.length,
      recordsRestored: source.recordCount,
      orphanRecordsDeleted: orphans.length,
      warnings,
    };
  } catch (err) {
    try {
      await restoreDataSnapshot(snapshotDir);
    } catch {
      throw new Error(`還原失敗且自動復原未完成。原始加密資料保留於：${snapshotDir}，請從此快照手動復原。`);
    }
    throw new Error(`還原失敗，已自動復原匯入前資料。加密快照保留於：${snapshotDir}。錯誤：${(err as Error).message}`);
  }
}