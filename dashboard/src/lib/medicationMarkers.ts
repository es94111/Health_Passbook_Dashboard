import type { Visit } from '../parsers/types';
import { formatLocalDate } from './clock';

export interface MedicationOverlay {
  name: string;
  days: readonly string[];
}

export interface MarkerAnchor {
  date: Date | null;
  x: string;
}

export interface MarkerPlacement {
  lines: string[];
  inRange: number;
  outside: number;
  first: string | null;
  last: string | null;
}

const isValidDate = (date: Date | null): date is Date => date !== null && Number.isFinite(date.getTime());

export function prescriptionDays(visits: readonly Visit[], code: string): string[] {
  const days = new Set<string>();
  for (const visit of visits) {
    if (isValidDate(visit.date) && visit.procedures.some(procedure => procedure.code === code)) {
      days.add(formatLocalDate(visit.date));
    }
  }
  return [...days].sort();
}

// The chart's x axis is a category axis keyed by each reading's date label, so a prescription can only be
// drawn on an existing reading: the first one taken on or after the prescription day.
export function placeMedicationMarkers(days: readonly string[], anchors: readonly MarkerAnchor[]): MarkerPlacement {
  const unique = [...new Set(days)].sort();
  const readings = anchors
    .filter((anchor): anchor is MarkerAnchor & { date: Date } => isValidDate(anchor.date))
    .map(anchor => ({ x: anchor.x, day: formatLocalDate(anchor.date) }))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

  if (readings.length === 0) return { lines: [], inRange: 0, outside: unique.length, first: null, last: null };

  const start = readings[0].day;
  const end = readings[readings.length - 1].day;
  const lines = new Set<string>();
  const inside: string[] = [];
  let cursor = 0;
  for (const day of unique) {
    if (day < start || day > end) continue;
    while (readings[cursor].day < day) cursor += 1;
    lines.add(readings[cursor].x);
    inside.push(day);
  }

  return {
    lines: [...lines],
    inRange: inside.length,
    outside: unique.length - inside.length,
    first: inside[0] ?? null,
    last: inside.at(-1) ?? null,
  };
}

export function describeMedicationOverlay(name: string, placement: MarkerPlacement): string {
  const parts: string[] = [];
  if (placement.inRange === 0) {
    parts.push('此系列的檢驗期間內沒有處方');
  } else {
    const range = placement.first === placement.last ? placement.first : `${placement.first} 至 ${placement.last}`;
    parts.push(`期間內 ${placement.inRange} 次處方（${range}），藍色虛線標在處方後的第一次檢驗`);
  }
  if (placement.outside > 0) parts.push(`另有 ${placement.outside} 次處方在此系列的檢驗期間之外`);
  return `用藥時間點：${name} · ${parts.join('；')}`;
}
