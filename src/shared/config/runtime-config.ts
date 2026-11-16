// Runtime-injected public configuration (window.__APP_CONFIG__).
//
// Docker deployments must configure Google 登入 (Firebase) and the self-hosted
// AI switch at RUNTIME — the published image bakes empty NEXT_PUBLIC_* values
// at build time. scripts/openbao/write-app-config.mjs writes
// /public/app-config.js at container start from plain env vars, and
// app/layout.tsx loads it synchronously (classic script) before any bundle
// code runs, so module-init reads already see the runtime values.
//
// Fallback: build-time NEXT_PUBLIC_* values (next dev / custom image builds).

export interface RuntimeFirebasePublicConfig {
  apiKey?: string
  authDomain?: string
  projectId?: string
  storageBucket?: string
  messagingSenderId?: string
  appId?: string
  measurementId?: string
  appCheckSiteKey?: string
}

export interface RuntimeAiSelfPublicConfig {
  model?: string
  endpoint?: string
  proxyKey?: string
  contextWindow?: string
}

export interface RuntimePublicConfig {
  firebase?: RuntimeFirebasePublicConfig
  aiSelf?: RuntimeAiSelfPublicConfig
}

export function getRuntimeConfig(): RuntimePublicConfig {
  if (typeof window === 'undefined') return {}
  return ((window as unknown as { __APP_CONFIG__?: RuntimePublicConfig }).__APP_CONFIG__) || {}
}

/** Runtime value wins; build-time value is the fallback; always a string. */
export function runtimeOrBuild(runtimeValue: string | undefined, buildValue: string | undefined): string {
  return (runtimeValue || buildValue || '').trim()
}
