// Self-hosted AI service wiring (client side).
//
// The app talks to ONE AI service: a self-hosted OpenAI-compatible endpoint,
// reached through the same-origin server proxy at /api/ai (see
// app/api/ai/[[...path]]/route.ts). The real upstream base URL and API key live
// on the SERVER (environment / OpenBao) and never reach the browser; the
// browser only knows the proxy path and, optionally, a shared proxy token.
//
// Everything here is env-switchable at RUNTIME (Docker compose `environment:`):
// set AI_SELF_MODEL to enable the service, point AI_SELF_BASE_URL at the real
// endpoint and provide AI_SELF_API_KEY server-side. Runtime values arrive via
// /app-config.js (see runtime-config.ts) and win over build-time NEXT_PUBLIC_*.
// When the model name is empty the app runs with no configured AI service
// (fail closed).

import type { OpenAiCompatibleProfile } from '@/src/shared/types/openai-compatible.types'
import { getRuntimeConfig, runtimeOrBuild } from './runtime-config'

const NEXT_BASE = (process.env.NEXT_PUBLIC_BASE_PATH || '').replace(/\/+$/, '')

const runtimeAi = getRuntimeConfig().aiSelf

/** Upstream model name sent to the self-hosted service. Empty = AI disabled. */
export const AI_SELF_MODEL = runtimeOrBuild(runtimeAi?.model, process.env.NEXT_PUBLIC_AI_SELF_MODEL)

/** Path (or absolute URL) the browser calls. Defaults to the same-origin proxy. */
export const AI_SELF_ENDPOINT = runtimeOrBuild(runtimeAi?.endpoint, process.env.NEXT_PUBLIC_AI_SELF_ENDPOINT) || `${NEXT_BASE}/api/ai`

/** Shared proxy token sent by the browser; the server proxy validates it when
 *  AI_PROXY_KEY is configured server-side. */
export const AI_SELF_PROXY_KEY = runtimeOrBuild(runtimeAi?.proxyKey, process.env.NEXT_PUBLIC_AI_SELF_PROXY_KEY)

/** Upstream model's context window (tokens), overridable per deployment. */
export const AI_SELF_CONTEXT_WINDOW = Number(runtimeOrBuild(runtimeAi?.contextWindow, process.env.NEXT_PUBLIC_AI_SELF_CONTEXT)) || 262_144

/** Stable, non-secret profile id. Deliberately the catalog's 'legacy' slot so
 *  the single catalog model (openai-compatible-custom) resolves here first. */
export const AI_SELF_PROFILE_ID = 'legacy'

/** Absolute endpoint for the browser (relative paths resolve against origin). */
function absoluteEndpoint(): string {
  if (/^https?:\/\//i.test(AI_SELF_ENDPOINT)) return AI_SELF_ENDPOINT
  if (typeof window === 'undefined') return AI_SELF_ENDPOINT
  return `${window.location.origin}${AI_SELF_ENDPOINT}`
}

/** The env-configured self-hosted connection, or null when unconfigured.
 *  Marked runtimeOnly: it must never be persisted into browser storage. */
export function aiSelfRuntimeProfile(): OpenAiCompatibleProfile | null {
  if (!AI_SELF_MODEL) return null
  return {
    profileId: AI_SELF_PROFILE_ID,
    runtimeOnly: true,
    enabled: true,
    baseUrl: absoluteEndpoint(),
    modelId: AI_SELF_MODEL,
    apiKey: AI_SELF_PROXY_KEY || null,
    transport: 'direct',
    contextWindowTokens: AI_SELF_CONTEXT_WINDOW,
    contextWindowSource: 'manual',
    agentMode: 'standard',
  }
}

/** Store profiles with the env-configured self-hosted connection first, so it
 *  wins any same-id lookup (and shadows a stale persisted 'legacy' profile).
 *  Memoized per input array: selectors must return a stable reference or every
 *  render would retrigger profile-keyed memos downstream. */
const effectiveCache = new WeakMap<object, readonly { profileId: string }[]>()

export function effectiveAiProfiles<T extends { profileId: string }>(
  profiles: readonly T[],
): readonly (T | OpenAiCompatibleProfile)[] {
  const self = aiSelfRuntimeProfile()
  if (!self) return profiles
  const key = profiles as unknown as object
  const hit = effectiveCache.get(key)
  if (hit) return hit as readonly (T | OpenAiCompatibleProfile)[]
  const merged: readonly (T | OpenAiCompatibleProfile)[] =
    [self, ...profiles.filter((p) => p.profileId !== self.profileId)]
  effectiveCache.set(key, merged as readonly { profileId: string }[])
  return merged
}
