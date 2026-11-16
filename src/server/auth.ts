import { createHash, randomBytes } from 'node:crypto'
import * as oauth from 'oauth4webapi'
import { getDatabasePool, ensureDatabaseSchema } from '@/src/server/database'
import { resolveSecret } from '@/src/server/ai-self-secrets'

const ISSUER = new URL('https://accounts.google.com')
const DEFAULT_CLIENT_SECRET_PATH = 'kv/apps/mediprisma/auth/google-client-secret'
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const OAUTH_TTL_SECONDS = 60 * 10

export interface AppUser {
  uid: string
  email: string | null
  displayName: string | null
  photoURL: string | null
  emailVerified: boolean
}

interface OAuthTransaction {
  state: string
  nonce: string
  codeVerifier: string
  redirectUri: string
}

let authorizationServer: Promise<oauth.AuthorizationServer> | undefined

function secureRequest(request: Request): boolean {
  const configured = process.env.APP_BASE_URL?.trim()
  return configured ? new URL(configured).protocol === 'https:' : new URL(request.url).protocol === 'https:'
}

function cookieName(request: Request, kind: 'session' | 'oauth'): string {
  const prefix = secureRequest(request) ? '__Host-' : ''
  return `${prefix}mediprisma.${kind}`
}

function cookieOptions(request: Request, maxAge: number): string {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secureRequest(request) ? '; Secure' : ''}`
}

function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=')
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue
    return decodeURIComponent(part.slice(separator + 1).trim())
  }
  return null
}

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function baseUrl(request: Request): URL {
  const configured = process.env.APP_BASE_URL?.trim()
  const origin = configured ? new URL(configured) : new URL(request.url)
  if (origin.protocol !== 'https:' && process.env.NODE_ENV === 'production') {
    throw new Error('APP_BASE_URL must use HTTPS in production')
  }
  return origin
}

function callbackUrl(request: Request): string {
  const configured = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim()
  return configured || new URL('/api/auth/google/callback', baseUrl(request)).toString()
}

async function getOAuthClient(): Promise<oauth.Client> {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim()
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID is not configured')
  return { client_id: clientId }
}

async function getOAuthClientSecret(): Promise<string> {
  const secret = await resolveSecret(
    process.env.OPENBAO_GOOGLE_CLIENT_SECRET_PATH || DEFAULT_CLIENT_SECRET_PATH,
    'GOOGLE_CLIENT_SECRET',
  )
  if (!secret) throw new Error('Google OAuth client secret is not configured')
  return secret
}

async function getAuthorizationServer(): Promise<oauth.AuthorizationServer> {
  if (!authorizationServer) {
    authorizationServer = oauth.discoveryRequest(ISSUER)
      .then((response) => oauth.processDiscoveryResponse(ISSUER, response))
      .catch((error) => {
        authorizationServer = undefined
        throw error
      })
  }
  return authorizationServer
}

export async function beginGoogleOAuth(request: Request): Promise<Response> {
  const [as, client] = await Promise.all([getAuthorizationServer(), getOAuthClient()])
  if (!as.authorization_endpoint) throw new Error('Google authorization endpoint is unavailable')

  const state = oauth.generateRandomState()
  const nonce = oauth.generateRandomNonce()
  const codeVerifier = oauth.generateRandomCodeVerifier()
  const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier)
  const redirectUri = callbackUrl(request)
  const transaction: OAuthTransaction = { state, nonce, codeVerifier, redirectUri }
  const authorizationUrl = new URL(as.authorization_endpoint)
  authorizationUrl.search = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    prompt: 'select_account',
  }).toString()

  return new Response(null, {
    status: 303,
    headers: {
      location: authorizationUrl.toString(),
      'set-cookie': `${cookieName(request, 'oauth')}=${encodeURIComponent(Buffer.from(JSON.stringify(transaction)).toString('base64url'))}; ${cookieOptions(request, OAUTH_TTL_SECONDS)}`,
      'cache-control': 'no-store',
    },
  })
}

export async function completeGoogleOAuth(request: Request): Promise<Response> {
  const callback = new URL(request.url)
  const transactionCookie = readCookie(request, cookieName(request, 'oauth'))
  const clearOAuthCookie = `${cookieName(request, 'oauth')}=; ${cookieOptions(request, 0)}`
  if (!transactionCookie) return new Response('Login attempt expired. Please try again.', { status: 400, headers: { 'set-cookie': clearOAuthCookie } })

  let transaction: OAuthTransaction
  try {
    transaction = JSON.parse(Buffer.from(transactionCookie, 'base64url').toString('utf8')) as OAuthTransaction
    if (!transaction.state || !transaction.nonce || !transaction.codeVerifier || !transaction.redirectUri) throw new Error('Incomplete OAuth transaction')
  } catch {
    return new Response('Invalid login attempt. Please try again.', { status: 400, headers: { 'set-cookie': clearOAuthCookie } })
  }

  try {
    const [as, client, clientSecret] = await Promise.all([
      getAuthorizationServer(), getOAuthClient(), getOAuthClientSecret(),
    ])
    if (!as.token_endpoint) throw new Error('Google token endpoint is unavailable')
    const parameters = oauth.validateAuthResponse(as, client, callback.searchParams, transaction.state)
    const tokenResponse = await oauth.authorizationCodeGrantRequest(
      as,
      client,
      oauth.ClientSecretPost(clientSecret),
      parameters,
      transaction.redirectUri,
      transaction.codeVerifier,
    )
    const tokens = await oauth.processAuthorizationCodeResponse(as, client, tokenResponse, {
      expectedNonce: transaction.nonce,
      requireIdToken: true,
    })
    const claims = oauth.getValidatedIdTokenClaims(tokens)
    if (!claims || typeof claims.sub !== 'string' || typeof claims.email !== 'string' || claims.email_verified !== true) {
      throw new Error('Google did not return a verified account')
    }

    const token = await createAppSession({
      uid: claims.sub,
      email: claims.email,
      displayName: typeof claims.name === 'string' ? claims.name : null,
      photoURL: typeof claims.picture === 'string' ? claims.picture : null,
      emailVerified: true,
    })
    const origin = baseUrl(request)
    const response = new Response(null, {
      status: 303,
      headers: {
        location: new URL('/', origin).toString(),
        'set-cookie': `${cookieName(request, 'session')}=${encodeURIComponent(token)}; ${cookieOptions(request, SESSION_TTL_SECONDS)}`,
        'cache-control': 'no-store',
      },
    })
    response.headers.append('set-cookie', clearOAuthCookie)
    return response
  } catch {
    const origin = baseUrl(request)
    const target = new URL('/', origin)
    target.searchParams.set('auth_error', 'google_sign_in_failed')
    const response = new Response(null, {
      status: 303,
      headers: { location: target.toString(), 'cache-control': 'no-store', 'set-cookie': clearOAuthCookie },
    })
    return response
  }
}

export async function createAppSession(user: AppUser): Promise<string> {
  const database = await getDatabasePool()
  const token = randomBytes(32).toString('base64url')
  const hash = tokenHash(token)
  await ensureDatabaseSchema()
  const client = await database.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO app_users (uid, email, display_name, photo_url, email_verified)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (uid) DO UPDATE SET email = EXCLUDED.email,
         display_name = EXCLUDED.display_name, photo_url = EXCLUDED.photo_url,
         email_verified = EXCLUDED.email_verified, updated_at = NOW()`,
      [user.uid, user.email, user.displayName, user.photoURL, user.emailVerified],
    )
    await client.query('DELETE FROM app_sessions WHERE uid = $1 AND expires_at <= NOW()', [user.uid])
    await client.query(
      `INSERT INTO app_sessions (token_hash, uid, expires_at) VALUES ($1, $2, NOW() + INTERVAL '7 days')`,
      [hash, user.uid],
    )
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
  return token
}

export async function getAppUser(request: Request): Promise<AppUser | null> {
  await ensureDatabaseSchema()
  const token = readCookie(request, cookieName(request, 'session'))
    ?? readCookie(request, 'mediprisma.session')
    ?? readCookie(request, '__Host-mediprisma.session')
  if (!token) return null
  const result = await (await getDatabasePool()).query(
    `SELECT u.uid, u.email, u.display_name, u.photo_url, u.email_verified
     FROM app_sessions s JOIN app_users u ON u.uid = s.uid
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash(token)],
  )
  const user = result.rows[0]
  if (!user) return null
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.display_name,
    photoURL: user.photo_url,
    emailVerified: user.email_verified === true,
  }
}

export async function destroyAppSession(request: Request): Promise<void> {
  const token = readCookie(request, cookieName(request, 'session'))
    ?? readCookie(request, 'mediprisma.session')
    ?? readCookie(request, '__Host-mediprisma.session')
  if (!token) return
  await ensureDatabaseSchema()
  await (await getDatabasePool()).query('DELETE FROM app_sessions WHERE token_hash = $1', [tokenHash(token)])
}

export function clearSessionCookie(request: Request): string {
  return `${cookieName(request, 'session')}=; ${cookieOptions(request, 0)}`
}

export function isSameOriginWrite(request: Request): boolean {
  const origin = request.headers.get('origin')
  if (!origin) return false
  try {
    return new URL(origin).origin === baseUrl(request).origin
  } catch {
    return false
  }
}
