import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const eslintBin = path.join(here, 'node_modules', 'eslint', 'bin', 'eslint.js')
const configPath = path.join(here, 'eslint.config.mjs')

const result = spawnSync(
  process.execPath,
  [eslintBin, '--config', configPath, ...process.argv.slice(2), '.'],
  { cwd: path.join(here, '..'), stdio: 'inherit' },
)

process.exit(result.status ?? 1)
