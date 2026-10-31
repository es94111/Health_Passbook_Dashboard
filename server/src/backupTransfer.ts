import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import parserStream, { type parser } from 'stream-json';
import {
  BACKUP_FORMAT, BACKUP_VERSION, restoreBackupSource, validateBackupBundle, validateBackupRecordMetadata,
  type BackupCounts, type BackupRecordEntry, type BackupRestoreSource, type ImportStats,
} from './backup.js';
import { BackupSizeError, MAX_BACKUP_JSON_BYTES, MAX_BACKUP_VALUE_BYTES } from './backupLimits.js';
import { isAttachmentId, MAX_ATTACHMENT_IDS } from './clientEncryption.js';
import { withDataMaintenance } from './dataAccess.js';
import {
  getUsers, getSettings, getAllLoginLogs, getHealthDataForClient, getRecords,
  getEncryptedAttachment, isClientEncryptedRecords, type ClientEncryptedRecords,
} from './store.js';

type Token = parser.Token;
export interface BackupTransferOptions { limitBytes?: number; signal?: AbortSignal }
export interface PreparedBackup {
  file: string;
  bytes: number;
  counts: BackupCounts;
  filename: string;
  cleanup(): Promise<void>;
}

const TEMP_ROOT = path.join(process.cwd(), 'data', '.backup-transfers');
const PROCESS_INSTANCE = crypto.randomUUID();
const MAX_RECORDS = 100_000;
const MAX_VALUE_TOKENS = 1_000_000;
// Export stays below the import assembly budget so every file we write can be restored.
const MAX_PART_BYTES = MAX_BACKUP_VALUE_BYTES - 256 * 1024;

function limit(options: BackupTransferOptions): number {
  const bytes = options.limitBytes ?? MAX_BACKUP_JSON_BYTES;
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_BACKUP_JSON_BYTES) throw new Error('Invalid backup byte limit');
  return bytes;
}

function assertSize(bytes: number, maximum: number): void {
  if (bytes > maximum) throw new BackupSizeError();
}

function partTooLarge(): Error {
  return new Error('備份單一中繼資料區塊或紀錄超過 64 MiB、結構過深或過於複雜；請保留原資料並使用離線備份。');
}

async function workspace(): Promise<string> {
  await fs.mkdir(TEMP_ROOT, { recursive: true, mode: 0o700 });
  await fs.chmod(TEMP_ROOT, 0o700);
  // Only remove crash leftovers whose owning process is gone; another worker
  // can still be streaming a large file, irrespective of its creation time.
  for (const entry of await fs.readdir(TEMP_ROOT, { withFileTypes: true })) {
    const owner = /^transfer-(\d+)-([0-9a-f-]{36})-/.exec(entry.name);
    if (!entry.isDirectory() || !owner) continue;
    let abandoned = Number(owner[1]) === process.pid && owner[2] !== PROCESS_INSTANCE;
    try { process.kill(Number(owner[1]), 0); }
    catch (err) { abandoned = (err as NodeJS.ErrnoException).code === 'ESRCH'; }
    if (abandoned) await fs.rm(path.join(TEMP_ROOT, entry.name), { recursive: true, force: true });
  }
  return fs.mkdtemp(path.join(TEMP_ROOT, `transfer-${process.pid}-${PROCESS_INSTANCE}-`));
}

function encodePart(value: unknown): string {
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json, 'utf8') > MAX_PART_BYTES) throw partTooLarge();
  // Match the parser's bounded token budget, reserving depth for the v1 wrappers.
  let bytes = 0;
  let tokens = 0;
  const visit = (item: unknown, depth: number): void => {
    if (depth > 124) throw partTooLarge();
    if (item !== null && typeof item === 'object') {
      tokens += 2;
      bytes += 4;
      if (Array.isArray(item)) for (const child of item) visit(child, depth + 1);
      else for (const [key, child] of Object.entries(item)) {
        if (child === undefined) continue;
        if (Buffer.byteLength(key, 'utf8') > 64 * 1024) throw partTooLarge();
        tokens++;
        bytes += Buffer.byteLength(JSON.stringify(key), 'utf8') + 2;
        visit(child, depth + 1);
      }
    } else {
      tokens++;
      const packed = typeof item === 'number' ? String(item) : item;
      bytes += Buffer.byteLength(JSON.stringify(packed), 'utf8') + 2;
    }
    if (bytes > MAX_PART_BYTES || tokens > MAX_VALUE_TOKENS) throw partTooLarge();
  };
  visit(value, 1);
  return json;
}

/** Fully stage a consistent v1 JSON export before sending download headers. */
export async function prepareBackupFile(options: BackupTransferOptions = {}): Promise<PreparedBackup> {
  const maximum = limit(options);
  const dir = await workspace();
  const file = path.join(dir, 'backup.json');
  const cleanup = () => fs.rm(dir, { recursive: true, force: true });
  try {
    return await withDataMaintenance(async () => {
      options.signal?.throwIfAborted();
      const users = await getUsers();
      const settings = await getSettings();
      const loginLogs = await getAllLoginLogs();
      const counts = { users: users.length, withRecords: 0, legacyRecords: 0, loginLogs: loginLogs.length };
      const exportedAt = new Date().toISOString();
      const handle = await fs.open(file, 'wx', 0o600);
      let bytes = 0;
      const write = async (text: string) => {
        options.signal?.throwIfAborted();
        bytes += Buffer.byteLength(text, 'utf8');
        assertSize(bytes, maximum);
        await handle.writeFile(text, 'utf8');
      };
      try {
        const metadata = encodePart({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, data: { users, settings, loginLogs } });
        await write(`${metadata.slice(0, -1)},"records":[`);
        const append = async (record: BackupRecordEntry) => {
          if (counts.withRecords) await write(',');
          await write(encodePart(record));
          counts.withRecords++;
        };
        for (const user of users) {
          options.signal?.throwIfAborted();
          let health;
          try { health = await getHealthDataForClient(user.id); }
          catch {
            await append({ userId: user.id, username: user.username, kind: 'corrupt', envelope: null, legacyRecords: null, error: '加密紀錄檔讀取失敗' });
            continue;
          }
          if (health.envelope) {
            const { envelope } = health;
            if (counts.withRecords) await write(',');
            const head = encodePart({ userId: user.id, username: user.username, kind: 'client-encrypted', envelope, legacyRecords: null });
            await write(head.slice(0, -1));
            const ids = envelope.attachmentIds ?? [];
            if (ids.length) {
              await write(',"attachments":{');
              for (let index = 0; index < ids.length; index++) {
                options.signal?.throwIfAborted();
                let attachment;
                try { attachment = await getEncryptedAttachment(user.id, ids[index]); }
                catch { /* Missing/corrupt references must never produce an incomplete download. */ }
                if (!attachment) throw new Error('無法完整匯出備份：健康紀錄參照的加密附件缺失或損毀');
                await write(`${index ? ',' : ''}${JSON.stringify(ids[index])}:`);
                await write(encodePart(attachment));
              }
              await write('}');
            }
            await write('}');
            counts.withRecords++;
          } else if (health.needsClientEncryptionMigration) {
            await append({ userId: user.id, username: user.username, kind: 'legacy', envelope: null, legacyRecords: await getRecords(user.id) });
            counts.legacyRecords++;
          }
        }
        await write(`],"counts":${JSON.stringify(counts)}}`);
        await handle.sync();
      } finally { await handle.close(); }
      return { file, bytes, counts, filename: `nhi-backup-${exportedAt.slice(0, 19).replace(/[:T]/g, '-')}.json`, cleanup };
    });
  } catch (err) {
    await cleanup();
    throw err;
  }
}

/** Packed tokens simplify bounded assembly; streamed tokens cap even unfinished strings/keys. */
class TokenReader {
  private readonly iterator: AsyncIterator<Token>;
  private stringBytes = 0;
  private stringLimit = MAX_BACKUP_VALUE_BYTES;
  private depth = 0;
  constructor(stream: Readable, private readonly signal?: AbortSignal) {
    this.iterator = stream[Symbol.asyncIterator]();
  }
  async next(): Promise<Token | undefined> {
    for (;;) {
      this.signal?.throwIfAborted();
      const item = await this.iterator.next();
      if (item.done) return undefined;
      const token = item.value;
      if (token.name === 'startString' || token.name === 'startKey' || token.name === 'startNumber') {
        this.stringBytes = 0;
        this.stringLimit = token.name === 'startKey' ? 64 * 1024 : token.name === 'startNumber' ? 1024 : MAX_BACKUP_VALUE_BYTES;
      } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
        this.stringBytes += Buffer.byteLength(token.value, 'utf8');
        if (this.stringBytes > this.stringLimit) throw partTooLarge();
      } else if (token.name === 'startObject' || token.name === 'startArray') {
        if (++this.depth > 128) throw partTooLarge();
        return token;
      } else if (token.name === 'endObject' || token.name === 'endArray') {
        this.depth--;
        return token;
      } else if (token.name.endsWith('Value')) return token;
    }
  }
  async required(): Promise<Token> {
    const token = await this.next();
    if (!token) throw new Error('備份 JSON 格式錯誤或檔案不完整');
    return token;
  }
  async expect(name: Token['name']): Promise<void> {
    if ((await this.required()).name !== name) throw new Error('備份 JSON 區塊格式錯誤');
  }
  async value(first: Token, keep = true): Promise<unknown> {
    type Frame = { value: unknown[] | Record<string, unknown>; key?: string; keys: Set<string> };
    const stack: Frame[] = [];
    let result: unknown;
    let depth = 0;
    let bytes = 0;
    let tokens = 0;
    const save = (value: unknown) => {
      const parent = stack.at(-1);
      if (!parent) result = value;
      else if (Array.isArray(parent.value)) parent.value.push(value);
      else {
        Object.defineProperty(parent.value, parent.key!, { value, enumerable: true, writable: true, configurable: true });
        parent.key = undefined;
      }
    };
    for (let token = first;; token = await this.required()) {
      if (keep) {
        bytes += 'value' in token ? Buffer.byteLength(JSON.stringify(token.value), 'utf8') + 2 : 2;
        if (bytes > MAX_BACKUP_VALUE_BYTES || ++tokens > MAX_VALUE_TOKENS) throw partTooLarge();
      }
      if (token.name === 'startObject' || token.name === 'startArray') {
        depth++;
        if (keep) {
          const value = token.name === 'startArray' ? [] : {};
          save(value);
          stack.push({ value, keys: new Set() });
        }
      } else if (token.name === 'endObject' || token.name === 'endArray') {
        depth--;
        if (keep) stack.pop();
      } else if (keep && token.name === 'keyValue') {
        const parent = stack.at(-1)!;
        if (parent.keys.has(token.value)) throw new Error('備份 JSON 包含重複欄位');
        parent.keys.add(token.value);
        parent.key = token.value;
      } else if (keep && 'value' in token) {
        save(token.name === 'numberValue' ? Number(token.value) : token.value);
      }
      if (depth === 0) return result;
    }
  }
}

function key(token: Token, seen: Set<string>): string {
  if (token.name !== 'keyValue' || seen.has(token.value)) throw new Error('備份 JSON 欄位錯誤或重複');
  if (seen.size >= 128) throw partTooLarge();
  seen.add(token.value);
  return token.value;
}

async function jsonFile(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

async function stageBackup(file: string, dir: string, signal?: AbortSignal): Promise<BackupRestoreSource> {
  const input = createReadStream(file, { highWaterMark: 64 * 1024, signal });
  const tokens = parserStream();
  input.on('error', (err) => tokens.destroy(err));
  input.pipe(tokens);
  const reader = new TokenReader(tokens, signal);
  const metadata: Record<string, unknown> = {};
  let recordCount = 0;
  let hasRecords = false;
  const recordPath = (index: number) => path.join(dir, `record-${index}.json`);
  const attachmentDir = (index: number) => path.join(dir, `attachments-${index}`);
  const attachmentPath = (index: number, id: string) => path.join(attachmentDir(index), `${id}.json`);
  const writeJson = (file: string, value: unknown) => fs.writeFile(file, encodePart(value), { flag: 'wx', mode: 0o600 });
  try {
    await reader.expect('startObject');
    const rootKeys = new Set<string>();
    for (let token = await reader.required(); token.name !== 'endObject'; token = await reader.required()) {
      const name = key(token, rootKeys);
      if (name !== 'records') {
        const keep = ['format', 'version', 'exportedAt', 'data'].includes(name);
        const value = await reader.value(await reader.required(), keep);
        if (keep) metadata[name] = value;
        continue;
      }
      hasRecords = true;
      await reader.expect('startArray');
      for (let entry = await reader.required(); entry.name !== 'endArray'; entry = await reader.required()) {
        if (entry.name !== 'startObject') throw new Error('健康紀錄條目格式錯誤');
        if (recordCount >= MAX_RECORDS) throw partTooLarge();
        const record: Record<string, unknown> = {};
        const fields = new Set<string>();
        let recordBytes = 0;
        for (let field = await reader.required(); field.name !== 'endObject'; field = await reader.required()) {
          const name = key(field, fields);
          if (name !== 'attachments') {
            const keep = ['userId', 'username', 'kind', 'envelope', 'legacyRecords', 'error'].includes(name);
            const value = await reader.value(await reader.required(), keep);
            if (keep) {
              recordBytes += Buffer.byteLength(encodePart(value), 'utf8');
              if (recordBytes > MAX_BACKUP_VALUE_BYTES) throw partTooLarge();
              record[name] = value;
            }
            continue;
          }
          await reader.expect('startObject');
          await fs.mkdir(attachmentDir(recordCount), { mode: 0o700 });
          const ids = new Set<string>();
          for (let attachment = await reader.required(); attachment.name !== 'endObject'; attachment = await reader.required()) {
            if (attachment.name !== 'keyValue' || !isAttachmentId(attachment.value) || ids.has(attachment.value) || ids.size >= MAX_ATTACHMENT_IDS) {
              throw new Error('加密附件包含無效、重複或過多的鍵');
            }
            const id = attachment.value;
            ids.add(id);
            const value = await reader.value(await reader.required());
            if (!isClientEncryptedRecords(value, true)) throw new Error('加密附件信封格式錯誤');
            await writeJson(attachmentPath(recordCount, id), value);
          }
        }
        await writeJson(recordPath(recordCount++), record);
      }
    }
    if (await reader.next()) throw new Error('備份 JSON 包含多餘資料');
  } catch (err) {
    // stream-json reports raw parser text; never echo internals or English grammar to clients.
    if (/^Parser cannot parse input/.test((err as Error).message)) throw new Error('備份 JSON 格式錯誤或檔案不完整');
    throw err;
  } finally {
    input.destroy();
    tokens.destroy();
  }

  const { bundle, warnings } = validateBackupBundle({ ...metadata, ...(hasRecords ? { records: [] } : {}) });
  const userById = new Map(bundle.data.users.map((user) => [user.id, user]));
  const seen = new Set<string>();
  const readRecord = async (index: number) => await jsonFile(recordPath(index)) as BackupRecordEntry;
  for (let index = 0; index < recordCount; index++) {
    signal?.throwIfAborted();
    const record = validateBackupRecordMetadata(await readRecord(index), userById, seen);
    const ids = await fs.readdir(attachmentDir(index)).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return [];
      throw err;
    });
    const expected = new Set((record.envelope?.attachmentIds ?? []).map((id) => `${id}.json`));
    if (ids.length !== expected.size || ids.some((id) => !expected.has(id))) throw new Error('加密附件與健康紀錄參照不相符');
    await fs.writeFile(recordPath(index), encodePart(record), { mode: 0o600 });
  }
  return {
    metadata: bundle, warnings, recordCount, readRecord,
    readAttachment: async (index, id) => await jsonFile(attachmentPath(index, id)) as ClientEncryptedRecords,
  };
}

/** Stage an authenticated raw request with backpressure, validate everything, then restore. */
export async function importBackupStream(
  input: Readable, options: BackupTransferOptions & { contentLength?: number } = {},
): Promise<ImportStats> {
  const maximum = limit(options);
  if (options.contentLength !== undefined) assertSize(options.contentLength, maximum);
  const dir = await workspace();
  const file = path.join(dir, 'upload.json');
  try {
    const handle = await fs.open(file, 'wx', 0o600);
    let bytes = 0;
    try {
      // Do not destroy the HTTP request on an over-limit chunk: the route must
      // still be able to send an actionable 413 instead of a connection reset.
      for await (const chunk of input.iterator({ destroyOnReturn: false })) {
        options.signal?.throwIfAborted();
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        assertSize(bytes, maximum);
        await handle.writeFile(buffer);
      }
    } finally { await handle.close(); }
    options.signal?.throwIfAborted();
    const source = await stageBackup(file, dir, options.signal);
    await fs.unlink(file);
    return await restoreBackupSource(source, options.signal);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
