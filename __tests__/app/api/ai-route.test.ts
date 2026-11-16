/** @jest-environment node */

jest.mock('@/src/server/auth', () => ({
  getAppUser: jest.fn(),
  isSameOriginWrite: jest.fn(),
}))
jest.mock('@/src/server/ai-self-secrets', () => ({
  aiProxyGateKey: jest.fn(),
  aiSelfApiKey: jest.fn(),
  aiSelfBaseUrl: jest.fn(),
}))

import { GET, POST } from '@/app/api/ai/[[...path]]/route'
import { getAppUser, isSameOriginWrite, type AppUser } from '@/src/server/auth'
import { aiProxyGateKey, aiSelfApiKey, aiSelfBaseUrl } from '@/src/server/ai-self-secrets'

const mockedGetAppUser = jest.mocked(getAppUser)
const mockedSameOriginWrite = jest.mocked(isSameOriginWrite)
const mockedProxyGateKey = jest.mocked(aiProxyGateKey)
const mockedAiSelfApiKey = jest.mocked(aiSelfApiKey)
const mockedAiSelfBaseUrl = jest.mocked(aiSelfBaseUrl)
const user: AppUser = {
  uid: 'test-user',
  email: 'user@example.test',
  displayName: 'Test User',
  photoURL: null,
  emailVerified: true,
}

function routeContext(path: string[]) {
  return { params: Promise.resolve({ path }) }
}

describe('self-hosted AI proxy route', () => {
  let upstreamFetch: jest.MockedFunction<typeof fetch>

  beforeEach(() => {
    jest.clearAllMocks()
    mockedGetAppUser.mockResolvedValue(user)
    mockedSameOriginWrite.mockReturnValue(true)
    mockedProxyGateKey.mockReturnValue('')
    mockedAiSelfApiKey.mockResolvedValue('server-side-test-key')
    mockedAiSelfBaseUrl.mockResolvedValue('https://ai.example.test/v1')
    upstreamFetch = jest.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as jest.MockedFunction<typeof fetch>
    jest.spyOn(globalThis, 'fetch').mockImplementation(upstreamFetch)
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('rejects callers without an app session', async () => {
    mockedGetAppUser.mockResolvedValue(null)
    const response = await GET(
      new Request('https://app.example.test/api/ai/models'),
      routeContext(['models']),
    )

    expect(response.status).toBe(401)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('returns 503 when session validation is unavailable', async () => {
    mockedGetAppUser.mockRejectedValue(new Error('database unavailable'))
    const response = await GET(
      new Request('https://app.example.test/api/ai/models'),
      routeContext(['models']),
    )

    expect(response.status).toBe(503)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('rejects cross-origin writes before forwarding them', async () => {
    mockedSameOriginWrite.mockReturnValue(false)
    const response = await POST(
      new Request('https://app.example.test/api/ai/chat/completions', {
        method: 'POST',
        headers: { origin: 'https://attacker.example.test' },
        body: '{}',
      }),
      routeContext(['chat', 'completions']),
    )

    expect(response.status).toBe(403)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it('forwards authenticated requests with only the server-side upstream key', async () => {
    mockedProxyGateKey.mockReturnValue('browser-proxy-key')
    const response = await POST(
      new Request('https://app.example.test/api/ai/chat/completions', {
        method: 'POST',
        headers: {
          origin: 'https://app.example.test',
          cookie: 'mediprisma.session=session-token',
          'content-type': 'application/json',
          'x-proxy-key': 'browser-proxy-key',
        },
        body: '{"model":"self-hosted-model"}',
      }),
      routeContext(['chat', 'completions']),
    )

    expect(response.status).toBe(200)
    expect(upstreamFetch).toHaveBeenCalledWith(
      'https://ai.example.test/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    )
    const init = upstreamFetch.mock.calls[0][1]
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer server-side-test-key')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('x-proxy-key')).toBeNull()
    await expect(response.json()).resolves.toEqual({ ok: true })
  })
})
