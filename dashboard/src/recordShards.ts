import { MAX_RECORD_BYTES, MAX_RECORD_SHARDS, RECORD_SHARD_BYTES, UUID_PATTERN } from './medicalAttachments';
import type { SourceChunk, StoredRecords } from './recordStore';

const encoder = new TextEncoder();
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const RECORD_MAPS = ['r1', 'r2', 'r3', 'r6', 'r7', 'r8', 'fhir'] as const;
const RECORD_META = ['fhirAliases', 'attachments', 'sources', 'importHistory'] as const;

export const RECORD_SHARD_KIND = 'records-shards';

/** Header stored (encrypted) in the manifest; the record index itself lives in the shards. */
export interface RecordShardHeader {
  kind: typeof RECORD_SHARD_KIND;
  version: 1;
  /** Total plaintext byte length of the concatenated shards. */
  size: number;
  shards: SourceChunk[];
}

export interface RecordShardUpload {
  id: string;
  digest: string;
  bytes: Uint8Array<ArrayBuffer>;
}

function createByteWriter(size: number) {
  const buffer = new Uint8Array(size);
  let filled = 0;
  return {
    *write(part: Uint8Array): Generator<Uint8Array<ArrayBuffer>> {
      let offset = 0;
      while (offset < part.length) {
        const take = Math.min(size - filled, part.length - offset);
        buffer.set(part.subarray(offset, offset + take), filled);
        filled += take;
        offset += take;
        if (filled === size) {
          yield buffer.slice();
          filled = 0;
        }
      }
    },
    flush(): Uint8Array<ArrayBuffer> | null {
      if (!filled) return null;
      const rest = buffer.slice(0, filled);
      filled = 0;
      return rest;
    },
  };
}

/** Streams the record index as JSON text one record at a time so peak memory stays bounded. */
function* recordIndexText(records: StoredRecords): Generator<string> {
  let first = true;
  const member = (key: string) => {
    const prefix = `${first ? '' : ','}${JSON.stringify(key)}:`;
    first = false;
    return prefix;
  };
  yield '{';
  for (const type of RECORD_MAPS) {
    yield `${member(type)}{`;
    let firstEntry = true;
    for (const [key, value] of Object.entries(records[type])) {
      yield `${firstEntry ? '' : ','}${JSON.stringify(key)}:${JSON.stringify(value)}`;
      firstEntry = false;
    }
    yield '}';
  }
  for (const key of RECORD_META) yield `${member(key)}${JSON.stringify(records[key])}`;
  yield '}';
}

export function serializeRecords(records: StoredRecords, shardBytes = RECORD_SHARD_BYTES): Generator<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(shardBytes) || shardBytes < 1024 || shardBytes > RECORD_SHARD_BYTES) throw new Error('病歷索引分片大小不正確');
  return serialize(records, shardBytes);
}

function* serialize(records: StoredRecords, shardBytes: number): Generator<Uint8Array<ArrayBuffer>> {
  const writer = createByteWriter(shardBytes);
  for (const text of recordIndexText(records)) yield* writer.write(encoder.encode(text));
  const rest = writer.flush();
  if (rest) yield rest;
}

/** Content-addressed UUID so an unchanged shard keeps its identity across imports. */
export function shardId(digest: string): string {
  if (!DIGEST_PATTERN.test(digest)) throw new Error('病歷索引分片摘要格式不正確');
  const variant = '89ab'[parseInt(digest[16], 16) & 0b11];
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export function isRecordShardHeader(value: unknown): value is RecordShardHeader {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const header = value as Record<string, unknown>;
  if (header.kind !== RECORD_SHARD_KIND || header.version !== 1) return false;
  if (!Number.isSafeInteger(header.size) || Number(header.size) < 1 || Number(header.size) > MAX_RECORD_BYTES) return false;
  if (!Array.isArray(header.shards) || !header.shards.length || header.shards.length > MAX_RECORD_SHARDS) return false;
  // Identical shards share one id, so a repeated id is allowed as long as it describes the same bytes.
  const seen = new Map<string, string>();
  let total = 0;
  for (const entry of header.shards) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const chunk = entry as Record<string, unknown>;
    if (typeof chunk.id !== 'string' || !UUID_PATTERN.test(chunk.id)) return false;
    if (typeof chunk.digest !== 'string' || !DIGEST_PATTERN.test(chunk.digest)) return false;
    if (!Number.isSafeInteger(chunk.size) || Number(chunk.size) < 1 || Number(chunk.size) > RECORD_SHARD_BYTES) return false;
    const known = seen.get(chunk.id);
    if (known !== undefined && known !== chunk.digest) return false;
    seen.set(chunk.id, chunk.digest);
    total += Number(chunk.size);
  }
  return total === header.size;
}

export function joinShards(parts: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  if (parts.reduce((total, part) => total + part.length, 0) !== size) throw new Error('病歷索引分片長度不一致，已停止載入');
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
}
