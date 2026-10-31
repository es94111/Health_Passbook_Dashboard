import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const PROCESS_STARTED_AT = new Date().toISOString();
const STATE_FILE_NAME = 'system-update.json';
const PENDING_TIMEOUT_MS = 15 * 60 * 1000;

export type SystemUpdateState = 'idle' | 'pending' | 'restarted' | 'failed' | 'unknown';

export interface SystemUpdateStatus {
  state: SystemUpdateState;
  requestedAt: string | null;
  requestedBy: string | null;
  message: string | null;
}

export interface SystemInfo {
  version: string;
  image: string | null;
  startedAt: string;
  nodeVersion: string;
  watchtowerConfigured: boolean;
  update: SystemUpdateStatus;
}

interface PersistedUpdateState {
  state: 'requested' | 'failed';
  requestedAt: string;
  requestedBy: string;
  fromVersion: string;
  message?: string;
}

export class UpdateConfigurationError extends Error {}
export class UpdateConflictError extends Error {}

let cachedVersion: string | null = null;
let updateInFlight = false;

/** Resolve the app version from APP_VERSION, then the repository changelog. */
export function currentVersion(): string {
  const fromEnv = process.env.APP_VERSION?.trim();
  if (fromEnv) return fromEnv;
  if (cachedVersion) return cachedVersion;

  const candidates = [
    path.join(process.cwd(), 'changelog.json'),
    path.join(process.cwd(), '..', 'changelog.json'),
  ];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as { currentVersion?: unknown };
      if (typeof parsed.currentVersion === 'string' && parsed.currentVersion.trim()) {
        cachedVersion = parsed.currentVersion.trim();
        return cachedVersion;
      }
    } catch {
      // Try the next location.
    }
  }
  cachedVersion = 'unknown';
  return cachedVersion;
}

/**
 * Normalize WATCHTOWER_URL to the /v1/update endpoint.
 * Only http(s) URLs without embedded credentials are accepted.
 */
export function resolveWatchtowerEndpoint(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;

  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath.endsWith('/v1/update')
    ? normalizedPath
    : `${normalizedPath}/v1/update`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function stateFile(): string {
  return path.join(process.cwd(), 'data', STATE_FILE_NAME);
}

async function readPersistedState(): Promise<PersistedUpdateState | null> {
  try {
    const raw = await fsp.readFile(stateFile(), 'utf8');
    const value = JSON.parse(raw) as Partial<PersistedUpdateState>;
    if (value.state !== 'requested' && value.state !== 'failed') return null;
    if (typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt))) return null;
    return {
      state: value.state,
      requestedAt: value.requestedAt,
      requestedBy: typeof value.requestedBy === 'string' ? value.requestedBy : '',
      fromVersion: typeof value.fromVersion === 'string' ? value.fromVersion : '',
      message: typeof value.message === 'string' ? value.message : undefined,
    };
  } catch {
    return null;
  }
}

async function writePersistedState(state: PersistedUpdateState): Promise<void> {
  const file = stateFile();
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(state), { encoding: 'utf8', mode: 0o600 });
  await fsp.rename(temp, file);
}

/** Turn the persisted request into the status shown in the admin UI. */
export function describeUpdateState(
  state: PersistedUpdateState | null,
  now = Date.now(),
  processStartedAt = Date.parse(PROCESS_STARTED_AT),
): SystemUpdateStatus {
  if (!state) {
    return { state: 'idle', requestedAt: null, requestedBy: null, message: null };
  }

  const requestedAtMs = Date.parse(state.requestedAt);
  const base = {
    requestedAt: state.requestedAt,
    requestedBy: state.requestedBy || null,
  };

  if (state.state === 'failed') {
    return {
      state: 'failed',
      ...base,
      message: state.message ?? '更新請求失敗，請檢查 Watchtower 設定。',
    };
  }

  if (Number.isFinite(processStartedAt) && processStartedAt > requestedAtMs) {
    return {
      state: 'restarted',
      ...base,
      message: '服務已在更新請求後重新啟動。若版本未變，代表目前使用的已是最新 image。',
    };
  }

  if (now - requestedAtMs > PENDING_TIMEOUT_MS) {
    return {
      state: 'unknown',
      ...base,
      message: '已送出更新請求，但超過 15 分鐘未偵測到服務重新啟動；可能已是最新版本，或 Watchtower 尚未完成更新。',
    };
  }

  return {
    state: 'pending',
    ...base,
    message: '更新請求已送出，正在等待 Watchtower 完成並視需要重新啟動服務。',
  };
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const endpoint = resolveWatchtowerEndpoint(process.env.WATCHTOWER_URL);
  return {
    version: currentVersion(),
    image: process.env.APP_IMAGE?.trim() || null,
    startedAt: PROCESS_STARTED_AT,
    nodeVersion: process.version,
    watchtowerConfigured: Boolean(endpoint),
    update: describeUpdateState(await readPersistedState()),
  };
}

function describeFetchError(error: unknown): string {
  const candidate = error as { message?: string; cause?: { code?: string; message?: string } };
  return candidate.cause?.code ?? candidate.cause?.message ?? candidate.message ?? '未知錯誤';
}

export interface SystemUpdateResult {
  message: string;
  update: SystemUpdateStatus;
}

/**
 * Ask Watchtower to pull and recreate the app container.
 * The password check and audit logging live in the admin route.
 */
export async function triggerSystemUpdate(actor: { username: string }): Promise<SystemUpdateResult> {
  const endpoint = resolveWatchtowerEndpoint(process.env.WATCHTOWER_URL);
  if (!endpoint) {
    throw new UpdateConfigurationError('尚未設定有效的 WATCHTOWER_URL（僅支援 http/https，且不可包含帳密）');
  }
  if (updateInFlight) {
    throw new UpdateConflictError('已有更新請求正在處理中，請稍候再試。');
  }

  updateInFlight = true;
  const requestedAt = new Date().toISOString();
  const requestedBy = actor.username;
  const fromVersion = currentVersion();
  const token = process.env.WATCHTOWER_TOKEN?.trim() || null;

  const persist = (state: 'requested' | 'failed', message?: string) =>
    writePersistedState({
      state,
      requestedAt,
      requestedBy,
      fromVersion,
      ...(message ? { message } : {}),
    });

  try {
    // Persist before calling Watchtower so a restart is still detectable afterwards.
    await persist('requested');
    const startedAt = Date.now();

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await response.text().catch(() => '')).trim().slice(0, 300);

      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'Watchtower 拒絕更新請求：權杖驗證失敗，請確認 WATCHTOWER_TOKEN 與 WATCHTOWER_HTTP_API_TOKEN 一致。'
          : `Watchtower 回應 HTTP ${response.status}${body ? `：${body}` : ''}`;
        await persist('failed', message);
        return {
          message,
          update: {
            state: 'failed',
            requestedAt,
            requestedBy,
            message,
          },
        };
      }

      const message = '已送出更新請求，Watchtower 正在檢查並更新 image。若需要重新啟動，連線會暫時中斷。';
      return {
        message,
        update: { state: 'pending', requestedAt, requestedBy, message },
      };
    } catch (error) {
      // A connection reset after the request was dispatched usually means the
      // container is being replaced. An immediate failure means Watchtower is
      // unreachable, which should be reported as an error instead.
      if (Date.now() - startedAt >= 3_000) {
        const message = '更新請求已送出，但等待回應時連線中斷；服務可能正在重新啟動。';
        return {
          message,
          update: { state: 'pending', requestedAt, requestedBy, message },
        };
      }

      const message = `無法連線至 Watchtower：${describeFetchError(error)}`;
      await persist('failed', message);
      return {
        message,
        update: { state: 'failed', requestedAt, requestedBy, message },
      };
    }
  } finally {
    updateInFlight = false;
  }
}
