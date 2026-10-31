// Thin API client — all calls go to /api (proxied to :3001 in dev)

import type { StoredRecords } from './cryptoVault';

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new Error('無法連線至伺服器，請確認後端是否已啟動（npm run server）');
  }

  // Parse body safely — empty body or non-JSON responses would otherwise crash
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) throw new Error(`伺服器錯誤 (${res.status})`);
      throw new Error(`回應格式錯誤：${text.slice(0, 100)}`);
    }
  }

  if (!res.ok) {
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new Error('無法連線至伺服器，請先啟動後端（npm run server）');
    }
    throw new Error((data as { error?: string } | null)?.error ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface ServerConfig {
  googleClientId: string | null;
}

export function fetchConfig(): Promise<ServerConfig> {
  return request('/auth/config');
}

// ── Auth ──────────────────────────────────────────────────────────────────────

export interface AuthResponse {
  username: string;
  isAdmin: boolean;
}

export type DateRangePreset = 'all' | '3m' | '6m' | '1y' | '3y';

export interface UserPreferences {
  pinnedLabItems: string[];      // lab subItem names tracked long-term
  pinnedMedications: string[];   // drug codes tracked long-term
  hiddenSections: string[];      // dashboard section keys the user has hidden
  defaultDateRange: DateRangePreset;
  lastActiveTab: string | null;  // last selected dashboard tab
  acknowledgedAlerts: string[];  // dismissed alert ids
}

export interface UserProfile {
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

export function register(username: string, password: string): Promise<AuthResponse> {
  return request('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function login(username: string, password: string): Promise<AuthResponse> {
  return request('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  });
}

export function loginWithGoogle(credential: string): Promise<AuthResponse> {
  return request('/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return request('/auth/logout', { method: 'POST' });
}

export function me(): Promise<UserProfile> {
  return request('/auth/me');
}

// ── Health data ───────────────────────────────────────────────────────────────

export interface UploadResult {
  message: string;
  stats: Record<string, { added: number; skipped: number; updated?: number }>;
}

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

export interface HealthDataResponse {
  envelope: ClientEncryptedRecords | null;
  needsClientEncryptionMigration: boolean;
}

export function fetchHealthData(signal?: AbortSignal): Promise<HealthDataResponse> {
  return request('/data', { signal });
}

export function fetchLegacyHealthData(signal?: AbortSignal): Promise<{ records: StoredRecords }> {
  return request('/data/legacy', { signal });
}

export function uploadEncryptedHealthData(
  envelope: ClientEncryptedRecords,
  stats: Record<string, { added: number; skipped: number; updated?: number }>,
  expectedRevision?: string | null,
  signal?: AbortSignal,
): Promise<UploadResult> {
  return request('/data/upload', {
    method: 'POST',
    signal,
    body: JSON.stringify({ envelope, stats, expectedRevision }),
  });
}

export function uploadEncryptedAttachment(id: string, envelope: ClientEncryptedRecords, signal?: AbortSignal): Promise<{ ok: boolean }> {
  return request(`/data/attachments/${encodeURIComponent(id)}`, { method: 'PUT', signal, body: JSON.stringify({ envelope }) });
}

export function fetchEncryptedAttachment(id: string): Promise<{ envelope: ClientEncryptedRecords }> {
  return request(`/data/attachments/${encodeURIComponent(id)}`);
}

// ── Account settings ──────────────────────────────────────────────────────────

export function updateTheme(themeMode: 'light' | 'dark' | 'system'): Promise<{ themeMode: string }> {
  return request('/account/theme', {
    method: 'PUT',
    body: JSON.stringify({ themeMode }),
  });
}

export function updateDisplayName(displayName: string): Promise<{ displayName: string }> {
  return request('/account/display-name', {
    method: 'PUT',
    body: JSON.stringify({ displayName }),
  });
}

// ── User preferences ──────────────────────────────────────────────────────────

/** Persist a partial preferences patch; returns the merged server-side preferences. */
export function updatePreferences(patch: Partial<UserPreferences>): Promise<UserPreferences> {
  return request('/account/preferences', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export interface LoginLog {
  id: string;
  userId: string | null;
  username: string;
  isAdmin: boolean;
  method: 'password' | 'google';
  success: boolean;
  failReason?: string;
  ip: string;
  country?: string;
  timestamp: string;
  action?: string;   // audit actions, e.g. 'admin-export' | 'admin-import'
  note?: string;     // audit detail, e.g. backup stats summary
}

export function fetchLoginLogs(): Promise<LoginLog[]> {
  return request('/account/login-logs');
}

export function deleteLoginLogs(ids: string[]): Promise<{ deleted: number }> {
  return request('/account/login-logs', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

export function linkGoogle(credential: string): Promise<{ googleEmail: string; avatarUrl: string | null }> {
  return request('/account/link-google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
}

export function unlinkGoogle(): Promise<{ message: string }> {
  return request('/account/unlink-google', { method: 'POST' });
}

export function deleteAccount(password?: string): Promise<{ message: string }> {
  return request('/account/delete', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
}

export function setPassword(newPassword: string): Promise<{ message: string }> {
  return request('/account/set-password', {
    method: 'POST',
    body: JSON.stringify({ newPassword }),
  });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ message: string }> {
  return request('/account/password', {
    method: 'PUT',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: string;
  username: string;
  displayName: string | null;
  isAdmin: boolean;
  createdAt: string;
  googleEmail: string | null;
  hasGoogle: boolean;
  hasPassword: boolean;
}

export function listUsers(): Promise<UserInfo[]> {
  return request('/admin/users');
}

export function createUser(username: string, password: string, isAdmin: boolean): Promise<UserInfo> {
  return request('/admin/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, isAdmin }),
  });
}

export function deleteUser(id: string): Promise<{ message: string }> {
  return request(`/admin/users/${id}`, { method: 'DELETE' });
}

export interface AppSettings {
  publicRegistration: boolean;
  allowedRegistrationEmails: string[];
  adminIpAllowlist: string[];
}

export function fetchAdminSettings(): Promise<AppSettings> {
  return request('/admin/settings');
}

export function updateAdminSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return request('/admin/settings', {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function fetchAdminLoginLogs(): Promise<LoginLog[]> {
  return request('/admin/login-logs');
}

export function deleteAdminLoginLogs(ids: string[]): Promise<{ deleted: number }> {
  return request('/admin/login-logs', {
    method: 'DELETE',
    body: JSON.stringify({ ids }),
  });
}

// ── Admin backup ──────────────────────────────────────────────────────────────

export interface ImportStats {
  users: number;
  settings: boolean;
  loginLogs: number;
  recordsRestored: number;
  orphanRecordsDeleted: number;
  warnings: string[];
}

export const MAX_BACKUP_BYTES = 20_000_000_000;

export interface BackupPrepareResult {
  downloadUrl: string;
  filename: string;
  bytes: number;
}

export interface BackupHeader {
  exportedAt: string | null;
  version: number | null;
  format: string | null;
}

/** Read only the first few KiB so previewing a 20 GB file never loads it into memory. */
export async function readBackupHeader(file: Blob): Promise<BackupHeader> {
  const head = (await file.slice(0, 8192).text()).replace(/^\uFEFF/, '');
  const pick = (name: string) => new RegExp(`"${name}"\\s*:\\s*"([^"]*)"`).exec(head)?.[1] ?? null;
  const version = /"version"\s*:\s*(\d+)/.exec(head)?.[1];
  return {
    exportedAt: pick('exportedAt'),
    version: version === undefined ? null : Number(version),
    format: pick('format'),
  };
}

/** POST /admin/backup/export?prepare=true — stage the file server-side, get a native download URL. */
export async function prepareBackup(password: string, signal?: AbortSignal): Promise<BackupPrepareResult> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/admin/backup/export?prepare=true`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal,
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('已取消匯出', { cause: error });
    throw new Error('無法連線至伺服器，請確認後端是否已啟動（npm run server）', { cause: error });
  }

  const text = await res.text();
  let data: unknown = null;
  try { data = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok) throw new Error((data as { error?: string } | null)?.error ?? `伺服器錯誤 (${res.status})`);
  const result = data as BackupPrepareResult | null;
  if (!result?.downloadUrl) throw new Error('伺服器未回傳下載連結');
  return result;
}

/** Hand the prepared file to the browser so it streams from disk instead of a JS Blob. */
export function startBackupDownload(result: BackupPrepareResult): void {
  const anchor = document.createElement('a');
  anchor.href = result.downloadUrl;
  anchor.download = result.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

export interface BackupUpload {
  promise: Promise<{ message: string; stats: ImportStats }>;
  cancel(): void;
}

/**
 * POST /admin/backup/import — stream the selected File straight from disk.
 * XMLHttpRequest keeps upload progress available for multi-GB restores.
 */
export function importBackup(
  file: Blob,
  onProgress?: (loadedBytes: number, totalBytes: number) => void,
): BackupUpload {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ message: string; stats: ImportStats }>((resolve, reject) => {
    xhr.open('POST', `${BASE}/admin/backup/import?confirm=true`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.upload.onprogress = (event) => {
      if (onProgress) onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
    };
    xhr.onerror = () => reject(new Error('無法連線至伺服器，請確認後端是否已啟動（npm run server）'));
    xhr.onabort = () => reject(new Error('已取消還原，現有資料未被變更'));
    xhr.onload = () => {
      let data: unknown = null;
      try { data = JSON.parse(xhr.responseText) as unknown; } catch { /* handled below */ }
      if (xhr.status >= 200 && xhr.status < 300 && data) {
        resolve(data as { message: string; stats: ImportStats });
        return;
      }
      reject(new Error((data as { error?: string } | null)?.error ?? `伺服器錯誤 (${xhr.status})`));
    };
    xhr.send(file);
  });
  return { promise, cancel: () => xhr.abort() };
}
