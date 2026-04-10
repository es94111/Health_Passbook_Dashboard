// Thin API client — all calls go to /api (proxied to :3001 in dev)

const BASE = '/api';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('nhi_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders(),
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
  token: string;
  username: string;
  isAdmin: boolean;
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

export function me(): Promise<UserProfile> {
  return request('/auth/me');
}

// ── Health data ───────────────────────────────────────────────────────────────

export interface UploadResult {
  message: string;
  stats: Record<string, { added: number; skipped: number }>;
}

export function fetchHealthData(): Promise<Record<string, object[]>> {
  return request('/data');
}

export function uploadNHIJson(json: object): Promise<UploadResult> {
  return request('/data/upload', {
    method: 'POST',
    body: JSON.stringify(json),
  });
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

export function fetchUserData(id: string): Promise<Record<string, object[]>> {
  return request(`/admin/users/${id}/data`);
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
