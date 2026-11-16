#!/usr/bin/env node
/**
 * Container entrypoint: resolve runtime secrets (OpenBao when configured,
 * plain env otherwise) and start the standalone Next server.
 *
 * With OPENBAO_ADDR set, fields of kv/apps/mediprisma/runtime are injected as
 * environment variables (e.g. AI_SELF_API_KEY) before `node server.js`, so the
 * image can rotate secrets without rebuilds. Without OpenBao it simply starts
 * the server with the existing environment.
 */
import { spawn } from 'node:child_process'
import { readKvSecret } from './fetch-secrets.mjs'
import { writeAppConfig } from './write-app-config.mjs'

const RUNTIME_SECRETS_PATH = process.env.OPENBAO_RUNTIME_PATH || 'kv/apps/mediprisma/runtime'

function env(name) { return (process.env[name] || '').trim() }

async function main() {
  const envVars = { ...process.env }
  if (env('OPENBAO_ADDR')) {
    try {
      const data = await readKvSecret(RUNTIME_SECRETS_PATH)
      for (const [key, value] of Object.entries(data)) envVars[key] = String(value)
      console.log(`✔ 從 OpenBao 注入 ${Object.keys(data).length} 個執行期變數`)
    } catch (error) {
      // Fail open to the image env so a transient OpenBao outage does not take
      // the app down; the AI proxy still fails closed per request without keys.
      console.warn(`⚠ OpenBao 讀取失敗，沿用映像環境變數：${error.message}`)
    }
  }
  // Runtime public config for optional Firebase integrations and the AI UI;
  // written from the merged env so OpenBao-injected values are included.
  try {
    writeAppConfig(envVars)
  } catch (error) {
    console.warn(`⚠ app-config.js 寫入失敗（沿用建置期組態）：${error.message}`)
  }
  const child = spawn('node', ['server.js'], { stdio: 'inherit', env: envVars })
  const forward = (signal) => () => child.kill(signal)
  process.on('SIGTERM', forward('SIGTERM'))
  process.on('SIGINT', forward('SIGINT'))
  child.on('exit', (code) => process.exit(code ?? 0))
}

main().catch((error) => {
  console.error(`✖ ${error.message}`)
  process.exit(1)
})
