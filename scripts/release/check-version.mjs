#!/usr/bin/env node
/**
 * Verify that a release tag is fully documented before publishing an image.
 *
 * Usage: node scripts/release/check-version.mjs v2.2.0
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const raw = process.argv[2]?.trim();
if (!raw) {
  console.error('用法：node scripts/release/check-version.mjs vX.Y.Z');
  process.exit(2);
}

const version = raw.replace(/^v/, '');
if (!SEMVER.test(version)) {
  console.error(`✖ 版號格式不正確：${raw}（預期 vX.Y.Z 或 vX.Y.Z-rc.1）`);
  process.exit(1);
}

const read = (file) => readFileSync(join(repoRoot, file), 'utf8');
const errors = [];
const warnings = [];

let changelog;
try {
  changelog = JSON.parse(read('changelog.json'));
} catch (err) {
  console.error(`✖ 無法解析 changelog.json：${err.message}`);
  process.exit(1);
}

const releases = Array.isArray(changelog.releases) ? changelog.releases : [];
const entry = releases.find((release) => release.version === version);

if (changelog.currentVersion !== version) {
  errors.push(
    `changelog.json 的 currentVersion 是 ${changelog.currentVersion ?? '(缺少)'}，與標籤 ${version} 不一致`,
  );
}
if (!entry) {
  errors.push(`changelog.json 找不到 ${version} 的版本紀錄`);
} else if (!Array.isArray(entry.changes) || entry.changes.length === 0) {
  errors.push(`${version} 的版本紀錄沒有 changes 內容`);
}
if (releases[0] && releases[0].version !== changelog.currentVersion) {
  errors.push(
    `changelog.json 最新紀錄是 ${releases[0].version}，與 currentVersion ${changelog.currentVersion} 不一致`,
  );
}
if (releases[0] && releases[0].version !== version) {
  warnings.push(`changelog.json 最新紀錄是 ${releases[0].version}，不是 ${version}`);
}

const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
if (!new RegExp(`^\\|\\s*${escaped}\\s*\\|`, 'm').test(read('SRS.md'))) {
  errors.push(`SRS.md 的版本歷程（8.2）缺少 ${version} 一列`);
}

if (!read('README.md').includes(version)) {
  warnings.push(`README.md 找不到版號 ${version}`);
}

for (const warning of warnings) console.warn(`⚠ ${warning}`);

if (errors.length > 0) {
  for (const error of errors) console.error(`✖ ${error}`);
  console.error(
    `\n版號檢查失敗：請先同步 changelog.json、SRS.md 與 README.md，再建立 v${version} 標籤。`,
  );
  process.exit(1);
}

console.log(`✔ 版號 ${version} 與 changelog.json、SRS.md 一致`);
