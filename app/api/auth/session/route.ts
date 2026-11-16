import { getAppUser } from '@/src/server/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    return Response.json({ user: await getAppUser(request) }, {
      headers: { 'cache-control': 'no-store' },
    })
  } catch {
    return Response.json({ error: 'Session service is temporarily unavailable' }, {
      status: 503,
      headers: { 'cache-control': 'no-store' },
    })
  }
}
