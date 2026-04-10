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
  } catch (err) {
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

// ── Config ───────────────────────────────────────────────────────────────────

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

export function me(): Promise<{ userId: string; username: string; isAdmin: boolean }> {
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

// ── Admin ─────────────────────────────────────────────────────────────────────

export interface UserInfo {
  id: string;
  username: string;
  isAdmin: boolean;
  createdAt: string;
}

export function listUsers(): Promise<UserInfo[]> {
  return request('/admin/users');
}

export function deleteUser(id: string): Promise<{ message: string }> {
  return request(`/admin/users/${id}`, { method: 'DELETE' });
}

export function fetchUserData(id: string): Promise<Record<string, object[]>> {
  return request(`/admin/users/${id}/data`);
}