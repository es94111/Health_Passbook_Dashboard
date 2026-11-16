#!/usr/bin/env node
/**
 * OpenBao secret fetcher (integration layer for an existing OpenBao instance).
 *
 * Auth methods (OPENBAO_AUTH_METHOD):
 *   - "approle" (default): OPENBAO_ROLE_ID + OPENBAO_SECRET_ID
 *   - "jwt"     : GitHub Actions OIDC (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN) or
 *                 any JWT in OPENBAO_JWT; exchanged at /auth/jwt/<OPENBAO_JWT_ROLE>
 *
 * Usage:
 *   node scripts/openbao/fetch-secrets.mjs --path kv/apps/mediprisma/runtime
 *   node scripts/openbao/fetch-secrets.mjs --path kv/ci/dockerhub --github-env
 *   node scripts/openbao/fetch-secrets.mjs --path kv/ci/dockerhub --dotenv .env.secrets
 *   node scripts/openbao/fetch-secrets.mjs --path kv/apps/mediprisma/runtime --exec -- node server.js
 *
 * Options:
 *   --path <mount/secret-path>   KV v2 secret path (default kv/apps/mediprisma/runtime)
 *   --env-prefix <prefix>        Prefix added to every env var name (e.g. OPENBAO_)
 *   --github-env                 Append KEY=VALUE lines to $GITHUB_ENV (CI)
 *   --dotenv <file>              Write KEY=VALUE lines to a file (0600)
 *   --exec -- <cmd...>           Export into env and exec a command (containers)
 *
 * No-op success when OPENBAO_ADDR is unset (falls back to plain env), so the
 * same wiring can stay in place before an instance is connected.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const options = { path: 'kv/apps/mediprisma/runtime', prefix: '', githubEnv: false, dotenv: '', exec: [] }
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (arg === '--path') options.path = argv[++i]
  else if (arg === '--env-prefix') options.prefix = argv[++i]
  else if (arg === '--github-env') options.githubEnv = true
  else if (arg === '--dotenv') options.dotenv = argv[++i]
  else if (arg === '--exec') { options.exec = argv.slice(i + 2); break }
}

const env = (name) => (process.env[name] || '').trim()

export async function openBaoLogin() {
  const addr = env('OPENBAO_ADDR')
  if (!addr) return null
  const method = env('OPENBAO_AUTH_METHOD') || 'approle'
  if (method === 'jwt') {
    const jwt = env('OPENBAO_JWT') || (await githubOidcJwt())
    const role = env('OPENBAO_JWT_ROLE') || 'github-actions'
    const res = await fetch(`${addr}/v1/auth/jwt/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role, jwt }),
    })
    if (!res.ok) throw new Error(`OpenBao JWT 登入失敗（${res.status}）`)
    return (await res.json()).auth.client_token
  }
  const res = await fetch(`${addr}/v1/auth/approle/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role_id: env('OPENBAO_ROLE_ID'), secret_id: env('OPENBAO_SECRET_ID') }),
  })
  if (!res.ok) throw new Error(`OpenBao AppRole 登入失敗（${res.status}）`)
  return (await res.json()).auth.client_token
}

async function githubOidcJwt() {
  const base = env('ACTIONS_ID_TOKEN_REQUEST_URL')
  const token = env('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
  if (!base || !token) throw new Error('GitHub OIDC 不可用（缺少 ACTIONS_ID_TOKEN_REQUEST_*）')
  const audience = env('OPENBAO_ADDR').replace(/\/+$/, '')
  const res = await fetch(`${base}&audience=${encodeURIComponent(audience)}`, {
    headers: { authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`GitHub OIDC token 取得失敗（${res.status}）`)
  return (await res.json()).value
}

export async function readKvSecret(path) {
  const addr = env('OPENBAO_ADDR')
  const token = await openBaoLogin()
  const [mount, ...rest] = path.split('/')
  const secretPath = rest.join('/')
  const res = await fetch(`${addr}/v1/${mount}/data/${secretPath}`, {
    headers: { 'X-Vault-Token': token },
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`OpenBao 讀取 ${path} 失敗（${res.status}）`)
  return (await res.json()).data?.data ?? {}
}

async function main() {
  if (!env('OPENBAO_ADDR')) {
    console.log('（未設定 OPENBAO_ADDR：跳過，沿用環境變數）')
    return
  }
  const data = await readKvSecret(options.path)
  const lines = Object.entries(data).map(([key, value]) => `${options.prefix}${key}=${String(value)}`)
  if (options.githubEnv) {
    if (!process.env.GITHUB_ENV) throw new Error('--github-env 需要在 GitHub Actions 中執行')
    appendFileSync(process.env.GITHUB_ENV, lines.join('\n') + '\n')
    console.log(`✔ 已寫入 ${lines.length} 個變數到 GITHUB_ENV（前綴 "${options.prefix}"）`)
  } else if (options.dotenv) {
    writeFileSync(options.dotenv, lines.join('\n') + '\n', { mode: 0o600 })
    console.log(`✔ 已寫入 ${lines.length} 個變數到 ${options.dotenv}`)
  } else if (options.exec.length > 0) {
    const [cmd, ...args] = options.exec
    const merged = { ...process.env }
    for (const line of lines) {
      const idx = line.indexOf('=')
      merged[line.slice(0, idx)] = line.slice(idx + 1)
    }
    const result = spawnSync(cmd, args, { stdio: 'inherit', env: merged })
    process.exit(result.status ?? 1)
  } else {
    for (const line of lines) console.log(line.replace(/=(.*)$/, '=<redacted>'))
    console.log(`✔ ${lines.length} 個變數（值已遮蔽）`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`✖ ${error.message}`)
    process.exit(1)
  })
}
