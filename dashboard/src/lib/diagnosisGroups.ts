import type { Visit } from '../parsers/types';

export interface DiagnosisCode {
  code: string;
  name: string;
  count: number;
}

export interface DiagnosisGroup {
  root: string;
  name: string;
  visitCount: number;
  firstDate: Date;
  lastDate: Date;
  hospitals: string[];
  codes: DiagnosisCode[];
}

export type DiagnosisSort = 'recent' | 'count';

interface NameStat {
  count: number;
  latest: number;
}

interface CodeAccumulator {
  visits: Set<number>;
  names: Map<string, NameStat>;
}

interface GroupAccumulator {
  visits: Set<number>;
  first: number;
  last: number;
  hospitals: Map<string, number>;
  names: Map<string, NameStat>;
  codes: Map<string, CodeAccumulator>;
}

const LOCALE = 'zh-TW';
const SEPARATORS = /[\s.]/g;

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareRecent(a: DiagnosisGroup, b: DiagnosisGroup): number {
  return (
    b.lastDate.getTime() - a.lastDate.getTime() ||
    b.visitCount - a.visitCount ||
    compareText(a.root, b.root)
  );
}

function compareCount(a: DiagnosisGroup, b: DiagnosisGroup): number {
  return (
    b.visitCount - a.visitCount ||
    b.lastDate.getTime() - a.lastDate.getTime() ||
    compareText(a.root, b.root)
  );
}

function addName(names: Map<string, NameStat>, name: string, time: number): void {
  if (!name) return;
  const stat = names.get(name);
  if (stat) {
    stat.count += 1;
    stat.latest = Math.max(stat.latest, time);
  } else {
    names.set(name, { count: 1, latest: time });
  }
}

function pickName(names: Map<string, NameStat>, fallback: string): string {
  const ranked = [...names].sort(
    ([nameA, a], [nameB, b]) =>
      b.count - a.count || b.latest - a.latest || nameA.localeCompare(nameB, LOCALE),
  );
  return ranked[0]?.[0] ?? fallback;
}

// 只保留英數字元，因此小數點、空白與其他符號都會被忽略
export function diagnosisRoot(code: string): string {
  const compact = code.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  return Array.from(compact).slice(0, 3).join('');
}

export function computeDiagnosisGroups(visits: Visit[]): DiagnosisGroup[] {
  const accumulators = new Map<string, GroupAccumulator>();

  visits.forEach((visit, index) => {
    const time = visit.date.getTime();
    if (Number.isNaN(time)) return;
    const hospital = visit.hospital.trim();

    for (const diagnosis of visit.diagnoses) {
      const root = diagnosisRoot(diagnosis.code);
      if (!root) continue;

      let group = accumulators.get(root);
      if (!group) {
        group = {
          visits: new Set<number>(),
          first: time,
          last: time,
          hospitals: new Map<string, number>(),
          names: new Map<string, NameStat>(),
          codes: new Map<string, CodeAccumulator>(),
        };
        accumulators.set(root, group);
      }
      if (!group.visits.has(index)) {
        group.visits.add(index);
        group.first = Math.min(group.first, time);
        group.last = Math.max(group.last, time);
        if (hospital) group.hospitals.set(hospital, (group.hospitals.get(hospital) ?? 0) + 1);
      }

      const code = diagnosis.code.trim().toUpperCase();
      const name = diagnosis.name.trim();
      let detail = group.codes.get(code);
      if (!detail) {
        detail = { visits: new Set<number>(), names: new Map<string, NameStat>() };
        group.codes.set(code, detail);
      }
      detail.visits.add(index);
      addName(detail.names, name, time);
      addName(group.names, name, time);
    }
  });

  return [...accumulators]
    .map(([root, group]): DiagnosisGroup => ({
      root,
      name: pickName(group.names, root),
      visitCount: group.visits.size,
      firstDate: new Date(group.first),
      lastDate: new Date(group.last),
      hospitals: [...group.hospitals]
        .sort(([nameA, a], [nameB, b]) => b - a || nameA.localeCompare(nameB, LOCALE))
        .map(([name]) => name),
      codes: [...group.codes]
        .map(([code, detail]): DiagnosisCode => ({
          code,
          name: pickName(detail.names, code),
          count: detail.visits.size,
        }))
        .sort((a, b) => b.count - a.count || compareText(a.code, b.code)),
    }))
    .sort(compareRecent);
}

export function sortDiagnosisGroups(
  groups: DiagnosisGroup[],
  sort: DiagnosisSort,
): DiagnosisGroup[] {
  return [...groups].sort(sort === 'count' ? compareCount : compareRecent);
}

// 'E11.9' 與無小數點的 'E119' 視為同一個代碼，因此比對時另外忽略空白與小數點
export function filterDiagnosisGroups(
  groups: DiagnosisGroup[],
  query: string,
): DiagnosisGroup[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return groups;
  const compactNeedle = needle.replace(SEPARATORS, '');

  return groups.filter((group) => {
    const fields = [
      group.root,
      group.name,
      ...group.codes.flatMap((item) => [item.code, item.name]),
    ];
    return fields.some((field) => {
      const text = field.toLowerCase();
      return (
        text.includes(needle) ||
        (compactNeedle !== '' && text.replace(SEPARATORS, '').includes(compactNeedle))
      );
    });
  });
}
