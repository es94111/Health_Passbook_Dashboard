import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import net from 'node:net';
import { Readable } from 'node:stream';
import { assertBackupByteLength, backupJsonByteLength, BackupSizeError, MAX_BACKUP_JSON_BYTES } from '../src/backupLimits.js';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import path from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import type { ClientEncryptedRecords, StoredRecords } from '../src/store.js';

const originalCwd = process.cwd();
const testParent = path.join(originalCwd, '.test-data');
const testDir = path.join(testParent, crypto.randomUUID());
const dataDir = path.join(testDir, 'data');
const clientKey = crypto.randomBytes(32);
const clientSalt = crypto.randomBytes(16).toString('base64');
const alice = { id: crypto.randomUUID(), username: 'alice', passwordHash: '', isAdmin: true, createdAt: new Date().toISOString() };
const bob = { id: crypto.randomUUID(), username: 'bob', passwordHash: '', isAdmin: false, createdAt: new Date().toISOString() };
let store: typeof import('../src/store.js');
let backups: typeof import('../src/backup.js');
let encryption: typeof import('../src/clientEncryption.js');
let serverCrypto: typeof import('../src/crypto.js');
let auth: typeof import('../src/auth.js');
let gate: typeof import('../src/dataAccess.js');
let transfer: typeof import('../src/backupTransfer.js');
let server: Server;
let origin: string;

function envelope(value: string | Buffer = 'opaque bytes', extra: Partial<ClientEncryptedRecords> = {}): ClientEncryptedRecords {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clientKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final(), cipher.getAuthTag()]);
  return {
    __clientEnc: true, v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', iterations: 250_000,
    salt: clientSalt, iv: iv.toString('base64'), data: ciphertext.toString('base64'), ...extra,
  };
}

function decrypt(value: ClientEncryptedRecords): Buffer {
  const data = Buffer.from(value.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', clientKey, Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(data.subarray(-16));
  return Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
}

function recordFile(userId = alice.id): string {
  return path.join(dataDir, `records-${userId}.json`);
}

function attachmentFile(id: string, userId = alice.id): string {
  return path.join(dataDir, 'attachments', userId, `${id}.json`);
}

function cookie(user: typeof alice | typeof bob): string {
  return `nhi_session=${auth.signToken({ userId: user.id, username: user.username, isAdmin: user.isAdmin })}`;
}

async function request(method: string, url: string, body?: unknown, user: typeof alice | typeof bob | null = alice) {
  const response = await fetch(`${origin}${url}`, {
    method,
    headers: {
      ...(user ? { Cookie: cookie(user) } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as any };
}

async function newAdmin(username: string, password = 'backup-admin-password') {
  const user = {
    id: crypto.randomUUID(), username, passwordHash: await bcrypt.hash(password, 4), isAdmin: true,
    createdAt: new Date().toISOString(),
  };
  await store.createUser(user);
  return { user, password, cookie: `nhi_session=${auth.signToken({ userId: user.id, username, isAdmin: true })}` };
}

/** Sends hand-written HTTP so tests can declare a Content-Length the body cannot satisfy. */
async function rawRequest(options: { path?: string; headers: Record<string, string>; body: string }) {
  const url = new URL(`${origin}${options.path ?? '/api/admin/backup/import?confirm=true'}`);
  const socket = net.connect(Number(url.port), url.hostname);
  await once(socket, 'connect');
  socket.setEncoding('utf8');
  let raw = '';
  socket.on('data', (chunk: string) => { raw += chunk; });
  socket.write([
    `POST ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.host}`,
    ...Object.entries(options.headers).map(([name, value]) => `${name}: ${value}`),
    '', options.body,
  ].join('\r\n'));
  await once(socket, 'close');
  const [head, ...rest] = raw.split('\r\n\r\n');
  const [statusLine, ...lines] = head.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).toLowerCase()] = line.slice(index + 1).trim();
  }
  return { status: Number(statusLine.split(' ')[1]), headers, body: rest.join('\r\n\r\n') };
}

async function seedManifest(user = alice) {
  const id = crypto.randomUUID();
  const attachment = envelope(Buffer.from([0, 1, 2, 250, 255]));
  const manifest = envelope(JSON.stringify({ source: 'test', imported: 1 }), {
    attachmentIds: [id], revision: crypto.randomUUID(),
  });
  await store.saveEncryptedAttachment(user.id, id, attachment);
  await store.saveClientEncryptedRecords(user.id, manifest, null);
  return { id, attachment, manifest };
}

before(async () => {
  // Fixtures and encrypted files live only in this worktree, never a system temp directory.
  await fs.mkdir(testDir, { recursive: true, mode: 0o700 });
  process.chdir(testDir);
  process.env.ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');
  process.env.NODE_ENV = 'test';
  delete process.env.ALLOW_PLAINTEXT_MIGRATION;
  delete process.env.ENV_ADMIN_IP_ALLOWLIST;
  serverCrypto = await import('../src/crypto.js');
  await serverCrypto.loadMasterKey();
  store = await import('../src/store.js');
  backups = await import('../src/backup.js');
  encryption = await import('../src/clientEncryption.js');
  auth = await import('../src/auth.js');
  gate = await import('../src/dataAccess.js');
  transfer = await import('../src/backupTransfer.js');
  const { createApp } = await import('../src/index.js');
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  origin = `http://127.0.0.1:${address.port}`;
  assert.equal((await request('GET', '/api/ping', undefined, null)).status, 200);
});

beforeEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
  await store.createUser(alice);
  await store.createUser(bob);
});

after(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  process.chdir(originalCwd);
  await fs.rm(testDir, { recursive: true, force: true });
  await fs.rmdir(testParent).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOTEMPTY' && err.code !== 'ENOENT') throw err;
  });
});

test('attachment and manifest endpoints require the current session and isolate users, including admins', async () => {
  const id = crypto.randomUUID();
  const attachment = envelope();
  for (const [method, url, body] of [
    ['GET', '/api/data', undefined],
    ['POST', '/api/data/upload', { envelope: envelope() }],
    ['GET', `/api/data/attachments/${id}`, undefined],
    ['PUT', `/api/data/attachments/${id}`, { envelope: attachment }],
  ] as const) {
    assert.equal((await request(method, url, body, null)).status, 401);
  }
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: attachment, userId: bob.id })).status, 200);
  assert.equal((await request('GET', `/api/data/attachments/${id}`, undefined, bob)).status, 404);
  const otherAttachment = envelope('another vault');
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: otherAttachment }, bob)).status, 200);
  assert.deepEqual((await request('GET', `/api/data/attachments/${id}`)).body.envelope, attachment);
  assert.deepEqual((await request('GET', `/api/data/attachments/${id}`, undefined, bob)).body.envelope, otherAttachment);
  const bobOnly = crypto.randomUUID();
  await store.saveEncryptedAttachment(bob.id, bobOnly, otherAttachment);
  assert.equal((await request('GET', `/api/data/attachments/${bobOnly}?userId=${bob.id}`)).status, 404);
  const aliceOnly = crypto.randomUUID();
  await store.saveEncryptedAttachment(alice.id, aliceOnly, attachment);
  const reference = envelope('manifest', { attachmentIds: [aliceOnly] });
  assert.equal((await request('POST', '/api/data/upload', { envelope: reference }, bob)).status, 400);
});

test('rejects path traversal, noncanonical IDs and invalid manifest reference lists before filesystem use', async () => {
  const id = crypto.randomUUID();
  for (const invalid of ['..%2Fusers', '%2Fetc%2Fpasswd', 'not-a-uuid', id.toUpperCase(), `${id}.json`, '%5C..%5Cusers']) {
    for (const method of ['GET', 'PUT']) {
      const response = await request(method, `/api/data/attachments/${invalid}`, method === 'PUT' ? { envelope: envelope() } : undefined);
      assert.equal(response.status, 400, invalid);
    }
  }
  for (const ids of [[id, id], ['../users'], [id.toUpperCase()], Array.from({ length: 4097 }, () => crypto.randomUUID())]) {
    assert.equal((await request('POST', '/api/data/upload', { envelope: envelope('manifest', { attachmentIds: ids }) })).status, 400);
  }
  assert.equal(encryption.isClientEncryptedRecords(envelope('manifest', {
    attachmentIds: Array.from({ length: 4096 }, () => crypto.randomUUID()),
  })), true);
  await assert.rejects(fs.access(path.join(dataDir, 'attachments')));
});

test('strictly validates envelope fields, canonical Base64, IV, salt, KDF iterations and nested references', async () => {
  for (const [method, url] of [
    ['POST', '/api/data/upload'],
    ['PUT', `/api/data/attachments/${crypto.randomUUID()}`],
  ]) {
    for (const body of [undefined, {}, []]) assert.equal((await request(method, url, body)).status, 400);
  }
  const valid = envelope();
  assert.equal(encryption.isClientEncryptedRecords(valid), true);
  assert.equal(encryption.isClientEncryptedRecords({ ...valid, iterations: 100_000 }), true);
  assert.equal(encryption.isClientEncryptedRecords({ ...valid, iterations: 1_000_000 }), true);
  const noncanonicalSalt = `${Buffer.alloc(16).toString('base64').slice(0, -3)}B==`;
  const mutations: Record<string, unknown>[] = [
    { __clientEnc: false }, { v: 2 }, { alg: 'AES-CBC' }, { kdf: 'plaintext' },
    { iterations: 99_999 }, { iterations: 1_000_001 }, { iterations: 250_000.5 }, { iterations: '250000' },
    { iv: Buffer.alloc(11).toString('base64') }, { iv: '!!!!!!!!!!!!====' },
    { salt: Buffer.alloc(8).toString('base64') }, { salt: noncanonicalSalt },
    { data: 'plaintext' }, { data: Buffer.alloc(15).toString('base64') }, { data: `${valid.data}\n` },
    { revision: 123 }, { revision: '' }, { revision: 'bad revision' }, { filename: 'not permitted' },
  ];
  for (const mutation of mutations) {
    const invalid = { ...valid, ...mutation };
    assert.equal(encryption.isClientEncryptedRecords(invalid), false, JSON.stringify(mutation));
    assert.equal((await request('PUT', `/api/data/attachments/${crypto.randomUUID()}`, { envelope: invalid })).status, 400);
    assert.equal((await request('POST', '/api/data/upload', { envelope: invalid })).status, 400);
  }
  for (const body of [{}, { envelope: [] }, { envelope: null }]) {
    assert.equal((await request('PUT', `/api/data/attachments/${crypto.randomUUID()}`, body)).status, 400);
  }
  assert.equal((await request('PUT', `/api/data/attachments/${crypto.randomUUID()}`, {
    envelope: envelope('bytes', { attachmentIds: [] }),
  })).status, 400);
  const oversized = { ...valid, data: 'A'.repeat(encryption.MAX_ATTACHMENT_CIPHERTEXT_LENGTH + 4) };
  assert.equal((await request('PUT', `/api/data/attachments/${crypto.randomUUID()}`, { envelope: oversized })).status, 400);
});

test('supports a 12 MiB encrypted raw-byte attachment without accepting plaintext metadata', async () => {
  const bytes = Buffer.alloc(12 * 1024 * 1024, 0x73);
  const attachment = envelope(bytes);
  const id = crypto.randomUUID();
  assert.ok(attachment.data.length < encryption.MAX_ATTACHMENT_CIPHERTEXT_LENGTH);
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: attachment })).status, 200);
  const fetched = await request('GET', `/api/data/attachments/${id}`);
  assert.equal(fetched.status, 200);
  assert.deepEqual(decrypt(fetched.body.envelope), bytes);
  assert.equal(fetched.headers.get('cache-control'), 'no-store');
  const disk = JSON.parse(await fs.readFile(attachmentFile(id), 'utf-8'));
  assert.equal(disk.__enc, true);
  assert.equal(disk.__clientEnc, undefined);
  if (process.platform !== 'win32') assert.equal((await fs.stat(attachmentFile(id))).mode & 0o777, 0o600);
});

test('attachment IDs are immutable, retries are idempotent, and concurrent writes serialize', async () => {
  const id = crypto.randomUUID();
  const attachment = envelope();
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: attachment })).status, 200);
  const reordered = Object.fromEntries(Object.entries(attachment).reverse());
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: reordered })).status, 200);
  assert.equal((await request('PUT', `/api/data/attachments/${id}`, { envelope: envelope('different') })).status, 409);
  assert.deepEqual((await request('GET', `/api/data/attachments/${id}`)).body.envelope, attachment);
  const concurrentId = crypto.randomUUID();
  const candidates = [envelope('first'), envelope('second')];
  const results = await Promise.all(candidates.map((value) => request('PUT', `/api/data/attachments/${concurrentId}`, { envelope: value })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.findIndex((result) => result.status === 200);
  assert.deepEqual((await request('GET', `/api/data/attachments/${concurrentId}`)).body.envelope, candidates[winner]);
});

test('legacy envelopes get a stable revision without rewriting their stored ciphertext', async () => {
  const legacy = envelope('legacy ciphertext');
  await store.saveClientEncryptedRecords(alice.id, legacy);
  const before = await fs.readFile(recordFile());
  const first = await request('GET', '/api/data');
  const second = await request('GET', '/api/data');
  const expected = crypto.createHash('sha256').update(legacy.data).digest('hex');
  assert.equal(first.body.envelope.revision, expected);
  assert.deepEqual(first.body, second.body);
  assert.deepEqual(await fs.readFile(recordFile()), before);
  const user = (await store.getUserById(alice.id))!;
  const stored = await serverCrypto.readMaybeEncrypted<ClientEncryptedRecords>(recordFile(), serverCrypto.deriveRecordsKey(user.encryptionSalt), legacy);
  assert.equal(stored.data.revision, undefined);
  const replacement = envelope('new ciphertext', { revision: crypto.randomUUID() });
  assert.equal((await request('POST', '/api/data/upload', { envelope: replacement, expectedRevision: expected })).status, 200);
  assert.equal((await request('GET', '/api/data')).body.envelope.revision, replacement.revision);
});

test('missing or corrupt attachments cannot overwrite the previous manifest', async () => {
  const previous = await seedManifest();
  const oldFile = await fs.readFile(recordFile());
  const missing = crypto.randomUUID();
  const invalidManifest = envelope('replacement', { attachmentIds: [missing], revision: crypto.randomUUID() });
  assert.equal((await request('POST', '/api/data/upload', { envelope: invalidManifest, expectedRevision: previous.manifest.revision })).status, 400);
  assert.deepEqual(await fs.readFile(recordFile()), oldFile);
  assert.deepEqual((await request('GET', '/api/data')).body.envelope, previous.manifest);
  assert.deepEqual((await request('GET', `/api/data/attachments/${previous.id}`)).body.envelope, previous.attachment);

  const corruptId = crypto.randomUUID();
  await store.saveEncryptedAttachment(alice.id, corruptId, envelope());
  const raw = JSON.parse(await fs.readFile(attachmentFile(corruptId), 'utf-8'));
  raw.tag = '00'.repeat(16);
  await fs.writeFile(attachmentFile(corruptId), JSON.stringify(raw));
  const corruptManifest = envelope('replacement', { attachmentIds: [corruptId] });
  assert.equal((await request('POST', '/api/data/upload', { envelope: corruptManifest })).status, 400);
  assert.deepEqual(await fs.readFile(recordFile()), oldFile);
});

test('an atomic manifest write failure leaves the old record usable and permits a clean retry', async (t) => {
  const current = await seedManifest();
  const original = await fs.readFile(recordFile());
  const replacement = envelope('replacement', { revision: crypto.randomUUID() });
  const rename = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === recordFile()) throw Object.assign(new Error('Injected manifest write failure'), { code: 'EIO' });
    return rename(from, to);
  });
  await assert.rejects(store.saveClientEncryptedRecords(alice.id, replacement, current.manifest.revision));
  assert.deepEqual(await fs.readFile(recordFile()), original);
  assert.deepEqual((await store.getHealthDataForClient(alice.id)).envelope, current.manifest);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.endsWith('.tmp')), false);
  t.mock.restoreAll();
  await store.saveClientEncryptedRecords(alice.id, replacement, current.manifest.revision);
  assert.deepEqual((await store.getHealthDataForClient(alice.id)).envelope, replacement);
});

test('optimistic revisions compare inside the user lock and preserve the winning import', async () => {
  const first = envelope('initial', { revision: crypto.randomUUID() });
  assert.equal((await request('POST', '/api/data/upload', { envelope: first, expectedRevision: null })).status, 200);
  for (const expectedRevision of [null, crypto.randomUUID()]) {
    assert.equal((await request('POST', '/api/data/upload', { envelope: envelope(), expectedRevision })).status, 409);
  }
  for (const expectedRevision of [123, {}, '']) {
    assert.equal((await request('POST', '/api/data/upload', { envelope: envelope(), expectedRevision })).status, 400);
  }
  const candidates = [envelope('winner A', { revision: crypto.randomUUID() }), envelope('winner B', { revision: crypto.randomUUID() })];
  const results = await Promise.all(candidates.map((value) => request('POST', '/api/data/upload', {
    envelope: value, expectedRevision: first.revision,
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.deepEqual((await request('GET', '/api/data')).body.envelope, candidates[results.findIndex((result) => result.status === 200)]);
  const legacyClient = envelope('old client without compare-and-swap');
  assert.equal((await request('POST', '/api/data/upload', { envelope: legacyClient })).status, 200);
});

test('upload statistics return bounded count-only added, updated and skipped values', async () => {
  const response = await request('POST', '/api/data/upload', {
    envelope: envelope(),
    stats: {
      r1: { added: 3, updated: 2, skipped: -1, raw: { disallowed: 'not echoed' } },
      medicalReports: { added: '4', updated: 1.25, skipped: 5 },
      'invalid group key': { added: 9 },
      r7: 'not a count object',
      attachments: { added: 1, skipped: 0 },
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.stats, {
    r1: { added: 3, updated: 2, skipped: 0 },
    medicalReports: { added: 0, updated: 0, skipped: 5 },
    attachments: { added: 1, updated: 0, skipped: 0 },
  });
  assert.match(response.body.message, /Added 4, updated 2, skipped 5/);
  for (const stats of [null, [], 'invalid']) {
    assert.deepEqual((await request('POST', '/api/data/upload', { envelope: envelope(), stats })).body.stats, {});
  }
});

test('backup limits count UTF-8 JSON bytes and include exactly the 20 GB boundary', () => {
  assert.equal(MAX_BACKUP_JSON_BYTES, 20_000_000_000);
  assert.doesNotThrow(() => assertBackupByteLength(MAX_BACKUP_JSON_BYTES));
  assert.throws(() => assertBackupByteLength(MAX_BACKUP_JSON_BYTES + 1), BackupSizeError);
  const value = { label: '醫療報告🩺', attachment: envelope() };
  const json = JSON.stringify(value);
  assert.equal(backupJsonByteLength(value), Buffer.byteLength(json, 'utf8'));
  assert.ok(backupJsonByteLength(value) > json.length);
  const error = new BackupSizeError();
  assert.equal(error.status, 413);
  assert.equal(error.code, 'BACKUP_TOO_LARGE');
  assert.equal(error.limitBytes, 20_000_000_000);
  assert.match(error.message, /20 GB/);
  assert.match(error.message, /離線備份/);
});

test('a prepared export stages a byte-exact snapshot that streams back into the same data', async () => {
  const current = await seedManifest();
  await store.updateUserPreferences(alice.id, { lastActiveTab: '醫療報告🩺' });
  const prepared = await transfer.prepareBackupFile();
  try {
    const content = await fs.readFile(prepared.file, 'utf8');
    assert.equal(prepared.bytes, Buffer.byteLength(content, 'utf8'));
    assert.equal((await fs.stat(prepared.file)).size, prepared.bytes);
    assert.deepEqual(prepared.counts, { users: 2, withRecords: 1, legacyRecords: 0, loginLogs: 0 });
    assert.match(prepared.filename, /^nhi-backup-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
    assert.equal(backupJsonByteLength(JSON.parse(content)), prepared.bytes);

    const stats = await transfer.importBackupStream(Readable.from([Buffer.from(content)]));
    assert.equal(stats.recordsRestored, 1);
    assert.deepEqual(await store.getEncryptedAttachment(alice.id, current.id), current.attachment);
    assert.equal((await store.getUserById(alice.id))?.preferences?.lastActiveTab, '醫療報告🩺');
  } finally { await prepared.cleanup(); }
  await assert.rejects(fs.stat(prepared.file), { code: 'ENOENT' });
});

test('a limited export aborts mid-stream before reading every attachment and leaves no staging files', async () => {
  const first = await seedManifest();
  const later = crypto.randomUUID();
  const last = crypto.randomUUID();
  await store.saveEncryptedAttachment(alice.id, later, envelope('later attachment'));
  await store.saveEncryptedAttachment(alice.id, last, envelope('last attachment'));
  await store.saveClientEncryptedRecords(alice.id, {
    ...first.manifest, attachmentIds: [first.id, later, last],
  }, first.manifest.revision);

  const baseline = await transfer.prepareBackupFile();
  const baselineBytes = baseline.bytes;
  await baseline.cleanup();

  // A corrupt final attachment proves the export really walks every referenced file.
  await fs.writeFile(attachmentFile(last), '{"__clientEnc":true}');
  await assert.rejects(transfer.prepareBackupFile(), /無法完整匯出/);

  // Under an injected limit the same export stops mid-stream: no attachment error, no staging files.
  await assert.rejects(
    transfer.prepareBackupFile({ limitBytes: Math.floor(baselineBytes / 2) }),
    (err: unknown) => err instanceof BackupSizeError,
  );
  assert.deepEqual(await fs.readdir(path.join(dataDir, '.backup-transfers')), []);
  assert.deepEqual(await store.getEncryptedAttachment(alice.id, first.id), first.attachment);
});

test('download tickets bind to their owner, refresh while active and clean up on expiry', async () => {
  const { BackupDownloads } = await import('../src/backupDownloads.js');
  const downloads = new BackupDownloads(60, 2);
  const cleaned: string[] = [];
  const fake = (name: string) => ({
    file: name, bytes: 1, counts: { users: 0, withRecords: 0, legacyRecords: 0, loginLogs: 0 },
    filename: name, cleanup: async () => { cleaned.push(name); },
  });
  try {
    const first = await downloads.prepare('admin-a', async () => fake('first'));
    await downloads.prepare('admin-b', async () => fake('second'));
    assert.equal(downloads.acquire(first.token, 'admin-b'), null);
    assert.equal(downloads.acquire('unknown', 'admin-a'), null);
    const handle = downloads.acquire(first.token, 'admin-a');
    assert.ok(handle);
    await assert.rejects(downloads.prepare('admin-a', async () => fake('busy')), { status: 409 });
    await assert.rejects(downloads.prepare('admin-c', async () => fake('full')), { status: 503 });
    handle.release();
    const replacement = await downloads.prepare('admin-a', async () => fake('replacement'));
    assert.equal(downloads.acquire(first.token, 'admin-a'), null);
    assert.ok(cleaned.includes('first'));
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(downloads.acquire(replacement.token, 'admin-a'), null);
    assert.ok(cleaned.includes('replacement'));
    assert.ok(cleaned.includes('second'));
  } finally { await downloads.dispose(); }
});

test('a streamed import aborts as soon as the running byte counter passes an injected limit', async () => {
  const bundle = await backups.buildBackupBundle();
  const json = Buffer.from(JSON.stringify(bundle));
  await assert.rejects(transfer.importBackupStream(Readable.from([json]), { limitBytes: json.length - 1 }), BackupSizeError);
  await assert.rejects(
    transfer.importBackupStream(Readable.from([json.subarray(0, 16)]), { limitBytes: 8 }),
    BackupSizeError,
  );
  assert.deepEqual(await fs.readdir(path.join(dataDir, '.backup-transfers')), []);
  assert.deepEqual(await store.getHealthDataForClient(alice.id), { envelope: null, needsClientEncryptionMigration: false });
});

test('an over-limit Content-Length is refused before any snapshot, write or body buffering', async () => {
  const current = await seedManifest();
  const before = {
    record: await fs.readFile(recordFile()),
    attachment: await fs.readFile(attachmentFile(current.id)),
    users: await fs.readFile(path.join(dataDir, 'users.json')),
  };
  const response = await rawRequest({
    headers: {
      Cookie: cookie(alice),
      'Content-Type': 'application/json',
      'Content-Length': String(MAX_BACKUP_JSON_BYTES + 1),
      Connection: 'close',
    },
    body: '{}',
  });
  assert.equal(response.status, 413);
  assert.equal(response.headers.connection, 'close');
  const body = JSON.parse(response.body) as { code: string; limitBytes: number; error: string };
  assert.equal(body.code, 'BACKUP_TOO_LARGE');
  assert.equal(body.limitBytes, MAX_BACKUP_JSON_BYTES);
  assert.match(body.error, /20 GB/);
  assert.match(body.error, /離線備份/);
  assert.deepEqual(await fs.readFile(recordFile()), before.record);
  assert.deepEqual(await fs.readFile(attachmentFile(current.id)), before.attachment);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'users.json')), before.users);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('pre-import-')), false);
});

test('malformed, duplicated, mismatched and unsafe backup bodies are rejected with zero writes', async () => {
  await seedManifest();
  const admin = await newAdmin('backup-invalid');
  const prepared = await transfer.prepareBackupFile();
  const content = await fs.readFile(prepared.file, 'utf8');
  await prepared.cleanup();
  const clone = () => JSON.parse(content) as {
    data: unknown;
    records: { attachments?: Record<string, unknown> }[];
  };
  const recordBefore = await fs.readFile(recordFile());
  const usersBefore = await fs.readFile(path.join(dataDir, 'users.json'));
  const post = async (body: string) => {
    const response = await fetch(`${origin}/api/admin/backup/import?confirm=true`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body,
    });
    return { status: response.status, body: await response.text() };
  };

  const mismatched = clone();
  mismatched.records[0].attachments = {};
  const unsafeKey = clone();
  unsafeKey.records[0].attachments = { '../escape': envelope() };
  const wrongFormat = clone() as unknown as Record<string, unknown>;
  wrongFormat.format = 'some-other-backup';

  const cases: [string, string, RegExp][] = [
    ['truncated json', content.slice(0, -4), /格式錯誤或檔案不完整/],
    ['invalid json', content.replace('"version":1', '"version" 1'), /格式錯誤或檔案不完整|區塊格式錯誤/],
    ['duplicate root field', `{"format":"nhi-dashboard-backup","format":"nhi-dashboard-backup","data":${JSON.stringify(clone().data)}}`, /重複|欄位/],
    ['missing attachment copy', JSON.stringify(mismatched), /附件|參照/],
    ['unsafe attachment key', JSON.stringify(unsafeKey), /附件|無效/],
    ['wrong backup format', JSON.stringify(wrongFormat), /格式|備份/],
  ];
  for (const [label, body, pattern] of cases) {
    const response = await post(body);
    assert.equal(response.status, 400, `${label}: ${response.body}`);
    assert.match((JSON.parse(response.body) as { error: string }).error, pattern, label);
    assert.deepEqual(await fs.readFile(recordFile()), recordBefore, label);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'users.json')), usersBefore, label);
    assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('pre-import-')), false, label);
  }

  // Unknown root fields are tolerated, but only a well-formed v1 body is actually restored.
  const extra = clone() as unknown as Record<string, unknown>;
  extra.extra = [1, 2, 3];
  const restored = await post(JSON.stringify(extra));
  assert.equal(restored.status, 200, restored.body);
  assert.ok((JSON.parse(restored.body) as { stats: { recordsRestored: number } }).stats.recordsRestored >= 1);
});

test('streamed imports parse unsafe keys without polluting prototypes or reordering requirements', async () => {
  const admin = await newAdmin('backup-proto');
  const prepared = await transfer.prepareBackupFile();
  const content = await fs.readFile(prepared.file, 'utf8');
  await prepared.cleanup();
  const bundle = JSON.parse(content) as Record<string, unknown>;
  const reordered = JSON.stringify({
    records: bundle.records,
    counts: bundle.counts,
    data: (bundle as { data: Record<string, unknown> }).data,
    __proto__: { polluted: true },
    exportedAt: bundle.exportedAt,
    version: bundle.version,
    format: bundle.format,
  });
  const response = await fetch(`${origin}/api/admin/backup/import?confirm=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: reordered,
  });
  const body = await response.json() as { stats: unknown; error?: string };
  assert.equal(response.status, 200, body.error);
  assert.ok(body.stats);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});

test('the backup import bypasses express.json so chunked bodies stream and never buffer', async () => {
  const admin = await newAdmin('backup-stream');
  const prepared = await transfer.prepareBackupFile();
  const content = await fs.readFile(prepared.file, 'utf8');
  await prepared.cleanup();
  const response = await fetch(`${origin}/api/admin/backup/import?confirm=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (let offset = 0; offset < content.length; offset += 16 * 1024) {
          controller.enqueue(encoder.encode(content.slice(offset, offset + 16 * 1024)));
        }
        controller.close();
      },
    }),
    // @ts-expect-error Node requires duplex for streamed request bodies.
    duplex: 'half',
  });
  const body = await response.json() as { stats?: unknown; error?: string };
  assert.equal(response.status, 200, body.error);
  assert.ok(body.stats);

  const malformed = await fetch(`${origin}/api/admin/backup/import?confirm=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: '{',
  });
  const malformedBody = await malformed.json() as { error: string };
  assert.equal(malformed.status, 400);
  assert.match(malformedBody.error, /備份 JSON/);

  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }]) {
    const rejected = await fetch(`${origin}/api/admin/backup/import?confirm=true`, {
      method: 'POST', headers: { ...headers, Cookie: admin.cookie }, body: '{}',
    });
    assert.equal(rejected.status, 415);
    assert.match((await rejected.json() as { error: string }).error, /JSON/);
  }
});

test('prepared downloads stay owner-bound, resumable and short-lived', async () => {
  seedManifest();
  const admin = await newAdmin('backup-ticket', 'ticket-export-password');
  const other = await newAdmin('backup-ticket-other');
  const prepared = await fetch(`${origin}/api/admin/backup/export?prepare=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ password: admin.password }),
  });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.headers.get('cache-control'), 'no-store');
  const ticket = await prepared.json() as { downloadUrl: string; filename: string; bytes: number };
  assert.match(ticket.downloadUrl, /^\/api\/admin\/backup\/download\/[0-9a-f]{64}$/);
  assert.match(ticket.filename, /^nhi-backup-.*\.json$/);
  assert.ok(ticket.bytes > 0);

  const download = await fetch(`${origin}${ticket.downloadUrl}`, { headers: { Cookie: admin.cookie } });
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition')!, /attachment; filename="?nhi-backup-/);
  assert.equal(download.headers.get('accept-ranges'), 'bytes');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  const content = await download.text();
  assert.equal(Buffer.byteLength(content, 'utf8'), ticket.bytes);

  // Interrupted transfers resume through HTTP range requests on the same owner-bound ticket.
  const resume = await fetch(`${origin}${ticket.downloadUrl}`, { headers: { Cookie: admin.cookie, Range: 'bytes=0-9' } });
  assert.equal(resume.status, 206);
  assert.equal(resume.headers.get('content-range'), `bytes 0-9/${ticket.bytes}`);
  assert.equal((await resume.arrayBuffer()).byteLength, 10);

  const second = await fetch(`${origin}/api/admin/backup/export?prepare=true`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
    body: JSON.stringify({ password: admin.password }),
  });
  const secondTicket = await second.json() as { downloadUrl: string };
  const foreign = await fetch(`${origin}${secondTicket.downloadUrl}`, { headers: { Cookie: other.cookie } });
  assert.equal(foreign.status, 404);
  const anonymous = await fetch(`${origin}${secondTicket.downloadUrl}`, { headers: { Cookie: cookie(bob) } });
  assert.equal(anonymous.status, 403);
  const unknown = await fetch(`${origin}/api/admin/backup/download/${'0'.repeat(64)}`, { headers: { Cookie: admin.cookie } });
  assert.equal(unknown.status, 404);
  const ownerDownload = await fetch(`${origin}${secondTicket.downloadUrl}`, { headers: { Cookie: admin.cookie } });
  assert.equal(ownerDownload.status, 200);
});

test('new tab preferences persist through the API and a byte-compatible HTTP backup round trip', async () => {
  const labels = ['醫療報告', '用藥', '同步紀錄'];
  const hiddenSections = labels.map((label) => `tab:${label}`);
  for (const label of labels) {
    const response = await request('PUT', '/api/account/preferences', { lastActiveTab: label, hiddenSections });
    assert.equal(response.status, 200);
    assert.equal(response.body.lastActiveTab, label);
    assert.deepEqual(response.body.hiddenSections, hiddenSections);
  }
  const current = await seedManifest();
  const password = 'backup-round-trip-password';
  await store.updateUser(alice.id, { passwordHash: await bcrypt.hash(password, 4) });
  const response = await fetch(`${origin}/api/admin/backup/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(alice) },
    body: JSON.stringify({ password }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition')!, /attachment;/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const json = await response.text();
  const bytes = Buffer.byteLength(json, 'utf8');
  assert.equal(Number(response.headers.get('content-length')), bytes);
  assert.ok(bytes <= MAX_BACKUP_JSON_BYTES);
  assert.ok(bytes > json.length);
  const bundle = JSON.parse(json);
  assert.equal(backupJsonByteLength(bundle), bytes);
  const restored = await request('POST', '/api/admin/backup/import?confirm=true', bundle);
  assert.equal(restored.status, 200);
  const profile = await request('GET', '/api/account/me');
  assert.equal(profile.body.preferences.lastActiveTab, '同步紀錄');
  assert.deepEqual(profile.body.preferences.hiddenSections, hiddenSections);
  assert.deepEqual(await store.getEncryptedAttachment(alice.id, current.id), current.attachment);
});

test('backup round trip includes each user\'s referenced attachments and cleans obsolete files', async () => {
  const aliceData = await seedManifest();
  const bobAttachment = envelope('bob raw bytes');
  const bobManifest = envelope('bob metadata', { attachmentIds: [aliceData.id], revision: crypto.randomUUID() });
  await store.saveEncryptedAttachment(bob.id, aliceData.id, bobAttachment);
  await store.saveClientEncryptedRecords(bob.id, bobManifest);
  const bundle = await backups.buildBackupBundle();
  assert.equal(bundle.version, 1);
  const aliceEntry = bundle.records.find((entry) => entry.userId === alice.id)!;
  const bobEntry = bundle.records.find((entry) => entry.userId === bob.id)!;
  assert.deepEqual(aliceEntry.attachments, { [aliceData.id]: aliceData.attachment });
  assert.deepEqual(bobEntry.attachments, { [aliceData.id]: bobAttachment });
  assert.deepEqual(backups.validateBackupBundle(bundle).bundle.records, bundle.records);

  const orphan = crypto.randomUUID();
  await store.saveEncryptedAttachment(alice.id, orphan, envelope('uncommitted bytes'));
  const removed = { ...bob, id: crypto.randomUUID(), username: 'removed' };
  await store.createUser(removed);
  await seedManifest(removed);
  for (const user of bundle.data.users) user.encryptionSalt = crypto.randomBytes(32).toString('hex');
  const restored = await backups.importBackupBundle(bundle);
  assert.equal(restored.recordsRestored, 2);
  assert.equal(restored.orphanRecordsDeleted, 1);
  assert.deepEqual((await store.getHealthDataForClient(alice.id)).envelope, aliceData.manifest);
  assert.deepEqual(await store.getEncryptedAttachment(alice.id, aliceData.id), aliceData.attachment);
  assert.deepEqual(await store.getEncryptedAttachment(bob.id, aliceData.id), bobAttachment);
  assert.deepEqual(decrypt((await store.getEncryptedAttachment(bob.id, aliceData.id))!), Buffer.from('bob raw bytes'));
  assert.equal(await store.getEncryptedAttachment(alice.id, orphan), null);
  await assert.rejects(fs.access(recordFile(removed.id)));
  await assert.rejects(fs.access(path.join(dataDir, 'attachments', removed.id)));
  const aliceUser = (await store.getUserById(alice.id))!;
  const bobUser = (await store.getUserById(bob.id))!;
  assert.notEqual(aliceUser.encryptionSalt, bobUser.encryptionSalt);
  await assert.rejects(serverCrypto.readMaybeEncrypted(
    attachmentFile(aliceData.id, bob.id), serverCrypto.deriveRecordsKey(aliceUser.encryptionSalt), null,
  ));
});

test('version 1 backups without attachments retain both legacy client envelopes and old record migration', async () => {
  const oldEnvelope = envelope('older vault');
  await store.saveClientEncryptedRecords(alice.id, oldEnvelope);
  const oldRecords: StoredRecords = { r1: { old: { marker: 'legacy fixture' } }, r2: {}, r3: {}, r6: {}, r7: {}, r8: {} };
  await store.writeLegacyRecords(bob.id, (await store.getUserById(bob.id))!.encryptionSalt, oldRecords);
  const bundle = await backups.buildBackupBundle();
  for (const entry of bundle.records) {
    delete entry.attachments;
    if (entry.envelope) delete entry.envelope.revision;
  }
  const orphan = crypto.randomUUID();
  await store.saveEncryptedAttachment(alice.id, orphan, envelope());
  await store.saveClientEncryptedRecords(alice.id, envelope('newer data'));
  await backups.importBackupBundle(bundle);
  assert.equal((await store.getHealthDataForClient(alice.id)).envelope?.data, oldEnvelope.data);
  assert.equal((await store.getHealthDataForClient(bob.id)).needsClientEncryptionMigration, true);
  assert.deepEqual(await store.getLegacyRecordsForClientEncryption(bob.id), oldRecords);
  assert.equal(await store.getEncryptedAttachment(alice.id, orphan), null);

  const omitted = structuredClone(bundle);
  omitted.records = [];
  await backups.importBackupBundle(omitted);
  assert.equal((await store.getHealthDataForClient(alice.id)).envelope, null);
  assert.equal((await store.getHealthDataForClient(bob.id)).needsClientEncryptionMigration, false);
  assert.deepEqual(await store.listRecordFileIds(), []);
});

test('backup validation rejects missing, corrupt, cross-user and unsafe attachment keys before any restore writes', async () => {
  const current = await seedManifest();
  const bundle = await backups.buildBackupBundle();
  const recordBefore = await fs.readFile(recordFile());
  const usersBefore = await fs.readFile(path.join(dataDir, 'users.json'));
  const mutations: Array<(raw: any) => void> = [
    (raw) => { delete raw.records[0].attachments; },
    (raw) => { raw.records[0].attachments = {}; },
    (raw) => { raw.records[0].attachments[crypto.randomUUID()] = current.attachment; },
    (raw) => { raw.records[0].attachments = { [bob.id]: current.attachment }; },
    (raw) => { raw.records[0].attachments = { [`${bob.id}/${current.id}`]: current.attachment }; },
    (raw) => { raw.records[0].envelope.attachmentIds = ['../users']; },
    (raw) => { raw.records[0].attachments[current.id].data = 'invalid'; },
    (raw) => { raw.records[0].attachments[current.id].attachmentIds = []; },
    (raw) => { raw.records[0].envelope.iv = 'invalid'; },
    (raw) => { raw.records[0].userId = crypto.randomUUID(); },
    (raw) => { raw.data.users[0].id = '../users'; },
    (raw) => { raw.data.users.push({ ...raw.data.users[0], username: 'duplicate' }); },
    (raw) => { raw.data.users.push({ ...raw.data.users[0], id: raw.data.users[0].id.toUpperCase(), username: 'casealias' }); },
    (raw) => { raw.records[0] = { ...raw.records[0], kind: 'corrupt', envelope: null, legacyRecords: null }; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(bundle);
    mutate(invalid);
    await assert.rejects(backups.importBackupBundle(invalid));
    assert.deepEqual(await fs.readFile(recordFile()), recordBefore);
    assert.deepEqual(await fs.readFile(path.join(dataDir, 'users.json')), usersBefore);
    assert.deepEqual(await store.getEncryptedAttachment(alice.id, current.id), current.attachment);
  }
  assert.equal((await fs.readdir(dataDir)).some((name) => name.startsWith('pre-import-')), false);
});

test('backup export fails rather than dropping a referenced missing or corrupt attachment', async () => {
  const current = await seedManifest();
  await fs.unlink(attachmentFile(current.id));
  await assert.rejects(backups.buildBackupBundle(), /附件缺失或損毀/);
  await fs.writeFile(attachmentFile(current.id), '{"invalid":true}');
  await assert.rejects(backups.buildBackupBundle(), /附件缺失或損毀/);
});

test('restore failure automatically rolls back records, user keys and attachments, retaining an encrypted safety snapshot', async (t) => {
  const current = await seedManifest();
  const originalUsers = await fs.readFile(path.join(dataDir, 'users.json'));
  const originalRecord = await fs.readFile(recordFile());
  const originalAttachment = await fs.readFile(attachmentFile(current.id));
  const replacement = await backups.buildBackupBundle();
  const id = crypto.randomUUID();
  replacement.records[0].envelope = envelope('replacement metadata', { revision: crypto.randomUUID(), attachmentIds: [id] });
  replacement.records[0].attachments = { [id]: envelope('replacement bytes') };
  replacement.data.users[0].encryptionSalt = crypto.randomBytes(32).toString('hex');
  const rename = fs.rename.bind(fs);
  let failed = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!failed && to === path.join(dataDir, 'users.json')) {
      failed = true;
      throw Object.assign(new Error('Injected import failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(backups.importBackupBundle(replacement), /已自動復原匯入前資料/);
  assert.equal(failed, true);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'users.json')), originalUsers);
  assert.deepEqual(await fs.readFile(recordFile()), originalRecord);
  assert.deepEqual(await fs.readFile(attachmentFile(current.id)), originalAttachment);
  assert.deepEqual((await store.getHealthDataForClient(alice.id)).envelope, current.manifest);
  assert.equal(decrypt((await store.getHealthDataForClient(alice.id)).envelope!).toString(), JSON.stringify({ source: 'test', imported: 1 }));
  assert.equal(await store.getEncryptedAttachment(alice.id, id), null);
  const snapshots = (await fs.readdir(dataDir)).filter((name) => name.startsWith('pre-import-'));
  assert.equal(snapshots.length, 1);
  assert.deepEqual(await fs.readFile(path.join(dataDir, snapshots[0], 'attachments', alice.id, `${current.id}.json`)), originalAttachment);
  assert.equal(JSON.parse((await fs.readFile(path.join(dataDir, snapshots[0], 'users.json'))).toString()).__enc, true);
});

test('a restore failure after publishing users and pruning files still restores the old data', async (t) => {
  const aliceData = await seedManifest();
  const bobData = await seedManifest(bob);
  const originalUsers = await fs.readFile(path.join(dataDir, 'users.json'));
  const replacement = await backups.buildBackupBundle();
  replacement.records = replacement.records.filter((entry) => entry.userId === alice.id);
  replacement.records[0].envelope = envelope('new manifest', { revision: crypto.randomUUID() });
  delete replacement.records[0].attachments;
  replacement.data.users[0].encryptionSalt = crypto.randomBytes(32).toString('hex');
  const rename = fs.rename.bind(fs);
  let logWrites = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(dataDir, 'login-logs.json') && ++logWrites === 2) {
      throw Object.assign(new Error('Injected post-commit audit failure'), { code: 'EIO' });
    }
    return rename(from, to);
  });
  await assert.rejects(backups.importBackupBundle(replacement), /已自動復原匯入前資料/);
  assert.equal(logWrites, 2);
  assert.deepEqual(await fs.readFile(path.join(dataDir, 'users.json')), originalUsers);
  assert.deepEqual((await store.getHealthDataForClient(alice.id)).envelope, aliceData.manifest);
  assert.deepEqual((await store.getHealthDataForClient(bob.id)).envelope, bobData.manifest);
  assert.deepEqual(await store.getEncryptedAttachment(alice.id, aliceData.id), aliceData.attachment);
  assert.deepEqual(await store.getEncryptedAttachment(bob.id, bobData.id), bobData.attachment);
});

test('account and admin deletion remove all user attachments, including unreferenced uploads', async () => {
  await seedManifest(bob);
  await store.saveEncryptedAttachment(bob.id, crypto.randomUUID(), envelope('orphan'));
  assert.equal((await request('POST', '/api/account/delete', {}, bob)).status, 200);
  await assert.rejects(fs.access(path.join(dataDir, 'attachments', bob.id)));
  await assert.rejects(fs.access(recordFile(bob.id)));
  await store.createUser(bob);
  await seedManifest(bob);
  assert.equal((await request('DELETE', `/api/admin/users/${bob.id}`)).status, 200);
  await assert.rejects(fs.access(path.join(dataDir, 'attachments', bob.id)));
});

test('backup maintenance drains current work and queues new operations until completion', async () => {
  const events: string[] = [];
  let started!: () => void;
  let releaseRead!: () => void;
  let enteredMaintenance!: () => void;
  let releaseMaintenance!: () => void;
  const readStarted = new Promise<void>((resolve) => { started = resolve; });
  const readHold = new Promise<void>((resolve) => { releaseRead = resolve; });
  const maintenanceStarted = new Promise<void>((resolve) => { enteredMaintenance = resolve; });
  const maintenanceHold = new Promise<void>((resolve) => { releaseMaintenance = resolve; });
  const active = gate.withDataAccess(async () => {
    events.push('active');
    started();
    await readHold;
    events.push('finished');
  });
  await readStarted;
  const maintenance = gate.withDataMaintenance(async () => {
    events.push('maintenance');
    assert.equal((await store.getUsers()).length, 2);
    enteredMaintenance();
    await maintenanceHold;
    events.push('committed');
  });
  const queued = gate.withDataAccess(async () => { events.push('queued'); });
  releaseRead();
  await maintenanceStarted;
  assert.deepEqual(events, ['active', 'finished', 'maintenance']);
  releaseMaintenance();
  await Promise.all([active, maintenance, queued]);
  assert.deepEqual(events, ['active', 'finished', 'maintenance', 'committed', 'queued']);
});

test('CSP permits Blob image previews only, and parser errors never log submitted health bodies', async (t) => {
  const response = await request('GET', '/api/ping');
  const policy = response.headers.get('content-security-policy')!;
  assert.deepEqual(policy.split('; ').filter((directive) => directive.includes('blob:')), ["img-src 'self' data: blob: https:"]);
  assert.ok(policy.includes("object-src 'none'"));
  assert.ok(policy.includes('frame-src https://accounts.google.com'));
  const logged: unknown[][] = [];
  t.mock.method(console, 'error', (...args: unknown[]) => { logged.push(args); });
  const marker = 'health-body-must-not-be-logged';
  const malformed = await fetch(`${origin}/api/data/upload`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie(alice) },
    body: `{"sensitive":"${marker}",}`,
  });
  assert.equal(malformed.status, 400);
  await malformed.json();
  assert.equal(logged.length, 1);
  assert.equal(JSON.stringify(logged).includes(marker), false);
});
