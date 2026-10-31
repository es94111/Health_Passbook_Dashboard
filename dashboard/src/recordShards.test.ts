import { describe, expect, it } from 'vitest';
import { isRecordShardHeader, joinShards, serializeRecords, shardId } from './recordShards';
import { MAX_RECORD_SHARDS } from './medicalAttachments';
import { emptyRecords, normalizeStoredRecords, type SourceChunk } from './recordStore';

const decoder = new TextDecoder();

async function collect(generator: Generator<Uint8Array<ArrayBuffer>>) {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  for (const part of generator) parts.push(part);
  return parts;
}

describe('streamed record index shards', () => {
  const records = normalizeStoredRecords({
    r1: { first: { 'r1.1': 'synthetic', 'r1.4': 'z'.repeat(800) }, second: { 'r1.1': 'synthetic-2' } },
    r3: { lab: { 'r3.1': 'synthetic-lab' } },
    sources: { ['a'.repeat(64)]: { format: 'NHI', chunks: [{ id: '11111111-1111-4111-8111-111111111111', digest: 'b'.repeat(64), size: 1024 }] } },
  });

  it('splits the index into fixed-size byte ranges that rejoin into the same JSON', async () => {
    const parts = await collect(serializeRecords(records, 1024));
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every(part => part.length <= 1024)).toBe(true);
    expect(parts.slice(0, -1).every(part => part.length === 1024)).toBe(true);
    const joined = joinShards(parts, parts.reduce((total, part) => total + part.length, 0));
    expect(JSON.parse(decoder.decode(joined))).toEqual(JSON.parse(JSON.stringify(records)));
  });
  it('rejects a shard size outside the supported range', () => {
    expect(() => serializeRecords(records, 512)).toThrow('分片');
    expect(() => serializeRecords(records, 9 * 1024 * 1024)).toThrow('分片');
  });
  it('derives stable RFC 4122 v4 identifiers from shard digests', () => {
    const digest = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    expect(shardId(digest)).toBe('abcdef01-2345-4789-abcd-ef0123456789');
    expect(shardId(digest)).toBe(shardId(digest));
    expect(() => shardId('not-a-digest')).toThrow('摘要');
  });
  it('accepts only complete headers whose sizes add up to the declared total', () => {
    const shard = (id: string, size: number): SourceChunk => ({ id, digest: 'a'.repeat(64), size });
    const header = { kind: 'records-shards', version: 1, size: 2048, shards: [shard('11111111-1111-4111-8111-111111111111', 1024), shard('22222222-2222-4222-8222-222222222222', 1024)] };
    expect(isRecordShardHeader(header)).toBe(true);
    expect(isRecordShardHeader({ ...header, size: 2049 })).toBe(false);
    // Identical content collapses to one id, so a repeated id describing the same bytes is legitimate.
    expect(isRecordShardHeader({ ...header, shards: [header.shards[0], header.shards[0]] })).toBe(true);
    const conflicting = { ...header.shards[1], id: header.shards[0].id, digest: 'b'.repeat(64) };
    expect(isRecordShardHeader({ ...header, shards: [header.shards[0], conflicting] })).toBe(false);
    expect(isRecordShardHeader({ ...header, version: 2 })).toBe(false);
    expect(isRecordShardHeader({ ...header, shards: Array.from({ length: MAX_RECORD_SHARDS + 1 }, (_, index) => shard(`1111111${index % 10}-1111-4111-8111-11111111111${index % 10}`, 1)) })).toBe(false);
    expect(isRecordShardHeader({ ...emptyRecords() })).toBe(false);
  });
});
