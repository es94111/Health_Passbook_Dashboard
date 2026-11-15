#!/usr/bin/env node
/**
 * Rotate one self-issued secret in OpenBao (KV v2) — the auto-rotation
 * primitive for keys this deployment issues itself.
 *
 *   node scripts/openbao/rotate-secret.mjs --path kv/apps/mediprisma --field APP_SESSION_KEY
 *   node scripts/openbao/rotate-secret.mjs --path kv/apps/mediprisma/ai --field api-key --value "$NEW_KEY"
 *
 * Modes:
 *   - default      : generate a fresh 32-byte base64url secret and write it as
 *                    a NEW KV v2 version. Old versions remain in KV history for
 *                    the transition window; consumers re-resolve within their
 *                    TTL (the app's server cache is 60s) — no restart needed.
 *   - --value <v>  : write an externally-issued value (semi-auto rotation for
 *                    keys only your provider can mint: re-issue there, then run
 *                    this to publish; propagation is still automatic).
 *
 * Schedule with the OpenBao Key Rotation workflow or host cron. Rotate only
 * server-side secrets — any value baked into the client at build time
 * (NEXT_PUBLIC_*) needs a rebuild and must not be auto-rotated here.
 */
import { randomBytes } from 'node:crypto'
import { openBaoLogin, readKvSecret } from './fetch-secrets.mjs'

const argv = process.argv.slice(2)
const options = { path: '', field: '', value: '', bytes: 32 }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--path') options.path = argv[++i]
  else if (arg === '--field') options.field = argv[++i]
  else if (arg === '--value') options.value = argv[++i]
  else if (arg === '--bytes') options.bytes = Number(argv[++i])
}

function env(name) { return (process.env[name] || '').trim() }

async function writeKvSecret(path, data) {
  const addr = env('OPENBAO_ADDR')
  const token = await openBaoLogin()
  const [mount, ...rest] = path.split('/')
  const res = await fetch(`${addr}/v1/${mount}/data/${rest.join('/')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Vault-Token': token },
    body: JSON.stringify({ data }),
  })
  if (!res.ok) throw new Error(`OpenBao 寫入 ${path} 失敗（${res.status}）`)
  return (await res.json()).data?.version
}

async function main() {
  if (!env('OPENBAO_ADDR')) throw new Error('未設定 OPENBAO_ADDR')
  if (!options.path || !options.field) throw new Error('需要 --path 與 --field')
  const current = await readKvSecret(options.path)
  const next = options.value || randomBytes(options.bytes).toString('base64url')
  const version = await writeKvSecret(options.path, { ...current, [options.field]: next })
  console.log(`✔ 已輪換 ${options.path} 的 ${options.field}（新版本 ${version ?? 'latest'}；舊值保留於 KV 歷史，應用端 TTL 內自動生效）`)
}

main().catch((error) => {
  console.error(`✖ ${error.message}`)
  process.exit(1)
})
