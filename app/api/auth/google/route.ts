import { beginGoogleOAuth } from '@/src/server/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    return await beginGoogleOAuth(request)
  } catch {
    return Response.json({ error: 'Google sign-in is temporarily unavailable' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    })
  }
}
