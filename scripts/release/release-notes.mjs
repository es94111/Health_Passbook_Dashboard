#!/usr/bin/env node
/**
 * Render GitHub Release notes for a tag from changelog.json.
 *
 * Usage:
 *   node scripts/release/release-notes.mjs --tag v2.2.0 \
 *     --image ghcr.io/owner/nhi-dashboard \
 *     --image dockerhub-user/nhi-dashboard \
 *     --digest sha256:... \
 *     --out notes.md
 *
 * IMAGE_TAGS (newline-separated image refs) adds the published tag list.
 * GITHUB_OUTPUT receives title / prerelease / notes_file for the workflow.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SECTIONS = [
  ['new', '新增'],
  ['improved', '改進'],
  ['fixed', '修正'],
  ['removed', '移除'],
  ['warning', '注意事項'],
];
const KNOWN_TAGS = new Set(SECTIONS.map(([tag]) => tag));

const options = { tag: '', digest: '', out: '', platforms: 'linux/amd64, linux/arm64', images: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const flag = argv[i];
  const value = argv[i + 1];
  switch (flag) {
    case '--tag':
      options.tag = value ?? '';
      i += 1;
      break;
    case '--digest':
      options.digest = value ?? '';
      i += 1;
      break;
    case '--image':
      if (value) options.images.push(value);
      i += 1;
      break;
    case '--platforms':
      options.platforms = value ?? options.platforms;
      i += 1;
      break;
    case '--out':
      options.out = value ?? '';
      i += 1;
      break;
    default:
      console.error(`未知參數：${flag}`);
      process.exit(2);
  }
}

if (!options.tag) {
  console.error('缺少 --tag vX.Y.Z');
  process.exit(2);
}

const version = options.tag.replace(/^v/, '');

// Accept both bare repo names (ghcr.io/owner/app) and already-tagged refs.
const stripTag = (ref) => {
  const slash = ref.lastIndexOf('/');
  const head = slash === -1 ? '' : ref.slice(0, slash + 1);
  const tail = slash === -1 ? ref : ref.slice(slash + 1);
  const colon = tail.indexOf(':');
  return head + (colon === -1 ? tail : tail.slice(0, colon));
};
options.images = [...new Set(options.images.map(stripTag))];

const changelog = JSON.parse(readFileSync(join(repoRoot, 'changelog.json'), 'utf8'));
const entry = (changelog.releases ?? []).find((release) => release.version === version);

if (!entry) {
  console.error(`changelog.json 找不到 ${version}，請先補上版本紀錄再發版。`);
  process.exit(1);
}

const lines = [`# v${version} — ${entry.title ?? ''}`.trim(), ''];
if (entry.date) lines.push(`版本日期：${entry.date}`, '');

lines.push('## 變更內容');
for (const [tag, heading] of SECTIONS) {
  const changes = (entry.changes ?? []).filter((change) => change.tag === tag);
  if (changes.length === 0) continue;
  lines.push('', `### ${heading}`);
  for (const change of changes) lines.push(`- ${change.text}`);
}

const others = (entry.changes ?? []).filter((change) => !KNOWN_TAGS.has(change.tag));
if (others.length > 0) {
  lines.push('', '### 其他');
  for (const change of others) lines.push(`- ${change.text}`);
}

if (options.images.length > 0) {
  const tagNames = [
    ...new Set(
      (process.env.IMAGE_TAGS ?? '')
        .split(/\r?\n/)
        .map((ref) => ref.trim())
        .filter((ref) => ref && !ref.includes('@'))
        .map((ref) => ref.slice(ref.lastIndexOf(':') + 1)),
    ),
  ];
  const publishedTags = tagNames.length > 0 ? tagNames : [version];

  lines.push('', '## Docker Image', '', '| Registry | Image |', '|---|---|');
  for (const image of options.images) {
    const registry = image.startsWith('ghcr.io/') ? 'GitHub Container Registry' : 'Docker Hub';
    lines.push(`| ${registry} | \`${image}\` |`);
  }

  lines.push('', '```bash');
  for (const image of options.images) lines.push(`docker pull ${image}:${version}`);
  lines.push('```', '');
  lines.push(`- 平台：\`${options.platforms}\``);
  lines.push(`- 可用標籤：${publishedTags.map((tag) => `\`${tag}\``).join('、')}`);
  if (options.digest) lines.push(`- 映像 digest：\`${options.digest}\``);
}

lines.push('', '---', '本內文由 `changelog.json` 自動產生。');

const markdown = `${lines.join('\n')}\n`;
const title = `v${version} — ${entry.title ?? ''}`.trim();
const prerelease = version.includes('-') || entry.prerelease === true;

if (options.out) writeFileSync(options.out, markdown);
else process.stdout.write(markdown);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `title=${title.replace(/\r?\n/g, ' ')}\nprerelease=${prerelease}\nnotes_file=${options.out}\n`,
  );
}
