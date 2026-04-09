// Thin API client — all calls go to /api (proxied to :3001 in dev)

const BASE = '/api';

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('nhi_token');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json();
  if (!res.ok) throw new Error((data as { error?: string }).error ?? res.statusText);
  return data as T;
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