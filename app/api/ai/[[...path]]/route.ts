// Same-origin proxy for the self-hosted OpenAI-compatible AI service.
//
// The browser calls /api/ai/<path>; this route forwards to the deployment's
// own AI service (AI_SELF_BASE_URL, key from OpenBao/process.env) so the real
// endpoint and credential never reach the browser. Auto-rotation: secrets are
// resolved through src/server/ai-self-secrets.ts with a short TTL cache, so a
// rotated key is picked up without a restart.
//
// Only known OpenAI-compatible data paths are proxied — this is not an open
// relay. When AI_PROXY_KEY is set, callers must present the matching
// x-proxy-key header (the browser's NEXT_PUBLIC_AI_PROXY_KEY).

import { aiProxyGateKey, aiSelfApiKey, aiSelfBaseUrl } from '@/src/server/ai-self-secrets'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_PATHS = new Set([
  'chat/completions',
  'responses',
  'embeddings',
  'audio/transcriptions',
  'models',
])

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function proxy(request: Request, path: string[] | undefined): Promise<Response> {
  const subPath = (path ?? []).join('/')
  if (!ALLOWED_PATHS.has(subPath)) return jsonError(404, `不支援的 AI 路徑：${subPath || '(root)'}`)

  const gateKey = aiProxyGateKey()
  if (gateKey && request.headers.get('x-proxy-key') !== gateKey) {
    return jsonError(401, '代理金鑰驗證失敗')
  }

  let baseUrl: string
  let apiKey: string
  try {
    ;[baseUrl, apiKey] = await Promise.all([aiSelfBaseUrl(), aiSelfApiKey()])
  } catch (error) {
    const message = error instanceof Error ? error.message : 'AI 服務組態讀取失敗'
    return jsonError(502, message)
  }
  if (!baseUrl) return jsonError(503, 'AI_SELF_BASE_URL 未設定（環境變數或 OpenBao）')

  const upstream = `${baseUrl.replace(/\/+$/, '')}/${subPath}`
  const headers = new Headers()
  headers.set('content-type', request.headers.get('content-type') || 'application/json')
  headers.set('accept', request.headers.get('accept') || '*/*')
  if (apiKey) headers.set('authorization', `Bearer ${apiKey}`)

  const method = request.method.toUpperCase()
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()

  let upstreamRes: Response
  try {
    upstreamRes = await fetch(upstream, {
      method,
      headers,
      body,
      signal: request.signal,
      cache: 'no-store',
    })
  } catch {
    return jsonError(502, '無法連線自架 AI 服務')
  }

  const responseHeaders = new Headers()
  const contentType = upstreamRes.headers.get('content-type')
  if (contentType) responseHeaders.set('content-type', contentType)
  return new Response(method === 'HEAD' ? null : upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders,
  })
}

export function GET(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  return params.then(({ path }) => proxy(request, path))
}

export function POST(request: Request, { params }: { params: Promise<{ path?: string[] }> }) {
  return params.then(({ path }) => proxy(request, path))
}
