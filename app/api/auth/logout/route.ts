import { clearSessionCookie, destroyAppSession, isSameOriginWrite } from '@/src/server/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginWrite(request)) return Response.json({ error: 'Invalid request origin' }, { status: 403 })
  try {
    await destroyAppSession(request)
    return new Response(null, {
      status: 204,
      headers: { 'set-cookie': clearSessionCookie(request), 'cache-control': 'no-store' },
    })
  } catch {
    return Response.json({ error: 'Could not end the session' }, {
      status: 503,
      headers: { 'set-cookie': clearSessionCookie(request), 'cache-control': 'no-store' },
    })
  }
}
