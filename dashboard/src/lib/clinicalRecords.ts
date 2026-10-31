import type { RecordOrigin, SourcedRecord } from '../parsers/types';

export function clinicalDateTime(date: Date | null): number {
  return date && Number.isFinite(date.getTime()) ? date.getTime() : -Infinity;
}

export function clinicalDate(date: Date | null): string {
  if (clinicalDateTime(date) === -Infinity) return '日期未提供';
  return date!.toLocaleDateString('zh-TW');
}

export function originLabel(origin: RecordOrigin): string {
  return [
    origin.format,
    [origin.resourceType, origin.id].filter(Boolean).join('/'),
    origin.source ? `來源：${origin.source}` : '',
  ].filter(Boolean).join(' · ');
}

export function recordIdentity(record: SourcedRecord & { id: string }): string {
  return JSON.stringify([record.id, (record.origins ?? []).map(originLabel).sort()]);
}

export function keyedRecords<T>(records: T[], identity: (record: T) => string): { key: string; record: T }[] {
  const occurrences = new Map<string, number>();
  return records.map(record => {
    const key = identity(record);
    const occurrence = occurrences.get(key) ?? 0;
    occurrences.set(key, occurrence + 1);
    return { key: JSON.stringify([key, occurrence]), record };
  });
}

export function rawResourceText(resource: Record<string, unknown>): string {
  try {
    return JSON.stringify(resource, null, 2);
  } catch {
    return '無法顯示原始資源。';
  }
}
