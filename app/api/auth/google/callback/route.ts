import { completeGoogleOAuth } from '@/src/server/auth'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request): Promise<Response> {
  try {
    return await completeGoogleOAuth(request)
  } catch {
    return Response.json({ error: 'Google sign-in could not be completed' }, {
      status: 400,
      headers: { 'cache-control': 'no-store' },
    })
  }
}
