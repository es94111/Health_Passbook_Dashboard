// Server-side secret resolution for the self-hosted AI service.
//
// Resolution order per secret: OpenBao (when OPENBAO_ADDR is configured) with a
// short TTL cache so rotated values are picked up automatically, falling back
// to plain process.env. Node runtime only — never import from client code.

const CACHE_TTL_MS = 60_000

type CacheEntry = { value: string; expiresAt: number }

const cache = new Map<string, CacheEntry>()

function env(name: string): string {
  return (process.env[name] || '').trim()
}

async function openBaoToken(): Promise<string> {
  const addr = env('OPENBAO_ADDR')
  const roleId = env('OPENBAO_ROLE_ID')
  const secretId = env('OPENBAO_SECRET_ID')
  if (!addr || !roleId || !secretId) throw new Error('OPENBAO_ADDR/OPENBAO_ROLE_ID/OPENBAO_SECRET_ID 需完整設定')
  const res = await fetch(`${addr}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role_id: roleId, secret_id: secretId }),
  })
  if (!res.ok) throw new Error(`OpenBao AppRole 登入失敗（${res.status}）`)
  const body = (await res.json()) as { auth?: { client_token?: string } }
  const token = body.auth?.client_token
  if (!token) throw new Error('OpenBao AppRole 登入未回傳 client_token')
  return token
}

/** Read one KV v2 secret string. `path` is "<mount>/<secret-path>/<field>". */
async function openBaoSecret(path: string): Promise<string> {
  const addr = env('OPENBAO_ADDR')
  const [mount, ...rest] = path.split('/')
  const field = rest.pop()
  const secretPath = rest.join('/')
  if (!addr || !field || !secretPath) throw new Error(`OpenBao 路徑格式不正確：${path}`)
  const token = await openBaoToken()
  const res = await fetch(`${addr}/v1/${mount}/data/${secretPath}`, {
    headers: { 'X-Vault-Token': token },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`OpenBao 讀取 ${path} 失敗（${res.status}）`)
  const body = (await res.json()) as { data?: { data?: Record<string, unknown> } }
  const value = body.data?.data?.[field]
  if (typeof value !== 'string' || !value) throw new Error(`OpenBao ${path} 缺少欄位 ${field}`)
  return value
}

/**
 * Resolve a secret by OpenBao path (e.g. "kv/apps/mediprisma/ai/api-key") with
 * 60s memoization — rotated values propagate within one TTL without restart.
 * Falls back to a literal process.env value named by `envFallback` when OpenBao
 * is not configured (dev / simple deployments).
 */
export async function resolveSecret(openBaoPath: string, envFallback: string): Promise<string> {
  const useOpenBao = Boolean(env('OPENBAO_ADDR'))
  const cacheKey = useOpenBao ? `bao:${openBaoPath}` : `env:${envFallback}`
  const hit = cache.get(cacheKey)
  if (hit && hit.expiresAt > Date.now()) return hit.value

  const value = useOpenBao ? await openBaoSecret(openBaoPath) : env(envFallback)
  if (value) cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  return value
}

/** The self-hosted AI service base URL (server side). */
export async function aiSelfBaseUrl(): Promise<string> {
  return resolveSecret('kv/apps/mediprisma/ai/base-url', 'AI_SELF_BASE_URL')
}

/** The self-hosted AI service API key (server side, OpenBao-rotatable). */
export async function aiSelfApiKey(): Promise<string> {
  return resolveSecret('kv/apps/mediprisma/ai/api-key', 'AI_SELF_API_KEY')
}

/** Optional shared proxy token guarding /api/ai. Empty = no gate. */
export function aiProxyGateKey(): string {
  return env('AI_PROXY_KEY')
}
