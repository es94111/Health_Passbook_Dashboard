#!/usr/bin/env node
/**
 * Write public/app-config.js — the runtime public configuration the browser
 * loads before any bundle code (see src/shared/config/runtime-config.ts).
 *
 * The published image bakes empty NEXT_PUBLIC_* values at build time, so
 * Docker deployments configure Google 登入 (Firebase) and the self-hosted AI
 * switch at RUNTIME through plain env vars. Each key accepts either the plain
 * name (recommended for compose `environment:`) or its NEXT_PUBLIC_* twin.
 *
 *   node scripts/openbao/write-app-config.mjs [--out public/app-config.js]
 *
 * Called automatically by scripts/openbao/entrypoint.mjs at container start
 * (after OpenBao injection), so OpenBao-managed values are included too.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const argv = process.argv.slice(2)
const outIndex = argv.indexOf('--out')
const OUT_DEFAULT = 'public/app-config.js'

export function buildAppConfig(env = process.env) {
  const pick = (plain, nextPublic) => String(env[plain] || env[nextPublic] || '').trim()
  return {
    firebase: {
      apiKey: pick('FIREBASE_API_KEY', 'NEXT_PUBLIC_FIREBASE_API_KEY'),
      authDomain: pick('FIREBASE_AUTH_DOMAIN', 'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN'),
      projectId: pick('FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_PROJECT_ID'),
      storageBucket: pick('FIREBASE_STORAGE_BUCKET', 'NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: pick('FIREBASE_MESSAGING_SENDER_ID', 'NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID'),
      appId: pick('FIREBASE_APP_ID', 'NEXT_PUBLIC_FIREBASE_APP_ID'),
      measurementId: pick('FIREBASE_MEASUREMENT_ID', 'NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID'),
      appCheckSiteKey: pick('FIREBASE_APPCHECK_SITE_KEY', 'NEXT_PUBLIC_APPCHECK_RECAPTCHA_SITE_KEY'),
    },
    aiSelf: {
      model: pick('AI_SELF_MODEL', 'NEXT_PUBLIC_AI_SELF_MODEL'),
      endpoint: pick('AI_SELF_ENDPOINT', 'NEXT_PUBLIC_AI_SELF_ENDPOINT'),
      proxyKey: pick('AI_SELF_PROXY_KEY', 'NEXT_PUBLIC_AI_PROXY_KEY'),
      contextWindow: pick('AI_SELF_CONTEXT', 'NEXT_PUBLIC_AI_SELF_CONTEXT'),
    },
  }
}

export function writeAppConfig(env = process.env, outPath = OUT_DEFAULT) {
  const config = buildAppConfig(env)
  const content = `window.__APP_CONFIG__ = ${JSON.stringify(config)};\n`
  mkdirSync(dirname(resolve(outPath)), { recursive: true })
  writeFileSync(resolve(outPath), content, 'utf8')
  return config
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = outIndex >= 0 ? argv[outIndex + 1] : OUT_DEFAULT
  const config = writeAppConfig(process.env, out)
  const set = [
    config.firebase.apiKey ? 'Firebase' : null,
    config.aiSelf.model ? 'AI' : null,
  ].filter(Boolean)
  console.log(`✔ 已寫入 ${out}${set.length ? `（${set.join('＋')} runtime 組態）` : '（無 runtime 組態，沿用建置值）'}`)
}
