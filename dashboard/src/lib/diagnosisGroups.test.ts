import { describe, expect, it } from 'vitest';
import type { Visit } from '../parsers/types';
import {
  computeDiagnosisGroups,
  diagnosisRoot,
  filterDiagnosisGroups,
  sortDiagnosisGroups,
} from './diagnosisGroups';

type DiagnosisInput = string | { code: string; name?: string };

function visit(date: Date, hospital: string, ...diagnoses: DiagnosisInput[]): Visit {
  return {
    date,
    hospital,
    diagnoses: diagnoses.map((item) =>
      typeof item === 'string'
        ? { code: item, name: '' }
        : { code: item.code, name: item.name ?? '' },
    ),
    procedures: [],
  };
}

function groupOf(visits: Visit[], root: string) {
  const found = computeDiagnosisGroups(visits).find((item) => item.root === root);
  if (!found) throw new Error(`找不到 ${root} 群組`);
  return found;
}

function roots(groups: { root: string }[]): string[] {
  return groups.map((item) => item.root);
}

function deepFreeze<T extends object>(value: T): T {
  (Object.values(value) as unknown[]).forEach((child) => {
    if (typeof child === 'object' && child !== null) deepFreeze(child);
  });
  return Object.freeze(value);
}

describe('diagnosisRoot', () => {
  it('取前 3 個字元並忽略小數點', () => {
    expect(diagnosisRoot('E11.9')).toBe('E11');
    expect(diagnosisRoot('250.00')).toBe('250');
    expect(diagnosisRoot('E119')).toBe('E11');
  });

  it('去除前後空白並轉為大寫', () => {
    expect(diagnosisRoot('  e11.9  ')).toBe('E11');
    expect(diagnosisRoot('i10')).toBe('I10');
  });

  it('忽略代碼中間的空白與小數點', () => {
    expect(diagnosisRoot('E 1.1 9')).toBe('E11');
    expect(diagnosisRoot('.I 10')).toBe('I10');
  });

  it('不足 3 個字元時取現有字元', () => {
    expect(diagnosisRoot('I1')).toBe('I1');
    expect(diagnosisRoot('e')).toBe('E');
  });

  it('空字串或只有空白與小數點時回傳空字串', () => {
    expect(diagnosisRoot('')).toBe('');
    expect(diagnosisRoot('   ')).toBe('');
    expect(diagnosisRoot(' . ')).toBe('');
  });
});

describe('computeDiagnosisGroups', () => {
  it('空輸入或沒有任何診斷時回傳空陣列', () => {
    expect(computeDiagnosisGroups([])).toEqual([]);
    expect(computeDiagnosisGroups([visit(new Date(2025, 0, 1), '甲院')])).toEqual([]);
  });

  it('略過代碼為空的診斷', () => {
    const groups = computeDiagnosisGroups([
      visit(
        new Date(2025, 0, 1),
        '甲院',
        { code: '', name: '無代碼' },
        { code: ' . ', name: '只有符號' },
        'E11.9',
      ),
    ]);
    expect(roots(groups)).toEqual(['E11']);
    expect(groups[0]?.codes).toHaveLength(1);
  });

  it('同一次就診的多個同群組代碼只算 1 次就診', () => {
    const group = groupOf([visit(new Date(2025, 0, 1), '甲院', 'E11.9', 'E11.0', 'E11.65')], 'E11');
    expect(group.visitCount).toBe(1);
    expect(group.codes.map((item) => item.count)).toEqual([1, 1, 1]);
    expect(group.hospitals).toEqual(['甲院']);
  });

  it('同日同院的兩次就診仍算 2 次', () => {
    const group = groupOf(
      [
        visit(new Date(2025, 0, 1), '甲院', 'E11.9'),
        visit(new Date(2025, 0, 1), '甲院', 'E11.9'),
      ],
      'E11',
    );
    expect(group.visitCount).toBe(2);
    expect(group.codes.map((item) => item.count)).toEqual([2]);
  });

  it('不同寫法的代碼歸入同一大類，細項以去空白並轉大寫後的字串區分', () => {
    const group = groupOf(
      [
        visit(new Date(2025, 0, 1), '甲院', 'E11.9'),
        visit(new Date(2025, 1, 1), '甲院', 'e11.9'),
        visit(new Date(2025, 2, 1), '甲院', 'E119'),
        visit(new Date(2025, 3, 1), '甲院', ' E11.0 '),
      ],
      'E11',
    );
    expect(group.visitCount).toBe(4);
    expect(group.codes.map((item) => [item.code, item.count])).toEqual([
      ['E11.9', 2],
      ['E11.0', 1],
      ['E119', 1],
    ]);
  });

  it('firstDate 與 lastDate 取群組內最早與最晚的就診日，且為副本', () => {
    const visits = [
      visit(new Date(2025, 2, 5), '甲院', 'E11.9'),
      visit(new Date(2024, 0, 10), '甲院', 'E11.9'),
      visit(new Date(2025, 11, 31), '乙院', 'E11.0'),
      visit(new Date(2026, 0, 1), '乙院', 'I10'),
    ];
    const group = groupOf(visits, 'E11');
    expect(group.firstDate.getTime()).toBe(new Date(2024, 0, 10).getTime());
    expect(group.lastDate.getTime()).toBe(new Date(2025, 11, 31).getTime());

    group.firstDate.setFullYear(1999);
    expect(visits[1]?.date.getTime()).toBe(new Date(2024, 0, 10).getTime());
  });

  it('name 取群組內出現次數最多的名稱', () => {
    const group = groupOf(
      [
        visit(new Date(2025, 0, 1), '甲院', { code: 'E11.9', name: 'Common' }),
        visit(new Date(2025, 1, 1), '甲院', { code: 'E11.0', name: 'Common' }),
        visit(new Date(2025, 2, 1), '甲院', { code: 'E11.9', name: 'Common' }),
        visit(new Date(2025, 3, 1), '甲院', { code: 'E11.9', name: 'Rare' }),
      ],
      'E11',
    );
    expect(group.name).toBe('Common');
  });

  it('name 同票時取最近一次就診的名稱，且不受輸入順序影響', () => {
    const older = visit(new Date(2024, 0, 10), '甲院', { code: 'E11.9', name: 'Older' });
    const newer = visit(new Date(2025, 3, 5), '甲院', { code: 'E11.0', name: 'Newer' });
    expect(groupOf([older, newer], 'E11').name).toBe('Newer');
    expect(groupOf([newer, older], 'E11').name).toBe('Newer');
  });

  it('name 同票且同日時取 localeCompare 最小者', () => {
    const group = groupOf(
      [
        visit(
          new Date(2025, 0, 1),
          '甲院',
          { code: 'E11.9', name: 'Beta' },
          { code: 'E11.0', name: 'Alpha' },
        ),
      ],
      'E11',
    );
    expect(group.name).toBe('Alpha');
  });

  it('name 忽略空名稱，名稱全部為空時退回大類代碼', () => {
    const day = new Date(2025, 0, 1);
    const unnamed = [
      visit(day, '甲院', 'E11.9'),
      visit(day, '甲院', { code: 'E11.0', name: '   ' }),
    ];
    expect(groupOf(unnamed, 'E11').name).toBe('E11');
    expect(
      groupOf([...unnamed, visit(day, '甲院', { code: 'E11.5', name: 'Named' })], 'E11').name,
    ).toBe('Named');
  });

  it('hospitals 依就診次數降冪、同次數依名稱排序，並略過空院所', () => {
    const names = [
      'Hospital B',
      'Hospital B',
      'Hospital B',
      'Clinic Z',
      'Clinic Z',
      'Clinic A',
      'Clinic A',
      'Solo',
      '',
      '  ',
    ];
    const visits = names.map((name, index) => visit(new Date(2025, 0, index + 1), name, 'E11.9'));
    expect(groupOf(visits, 'E11').hospitals).toEqual([
      'Hospital B',
      'Clinic A',
      'Clinic Z',
      'Solo',
    ]);
  });

  it('hospitals 以不重複就診計算次數，並合併前後空白不同的院所名稱', () => {
    const visits = [
      visit(new Date(2025, 0, 1), 'Hospital A', 'E11.9', 'E11.0', 'E11.5'),
      visit(new Date(2025, 0, 2), 'Hospital B', 'E11.9'),
      visit(new Date(2025, 0, 3), ' Hospital B ', 'E11.9'),
    ];
    expect(groupOf(visits, 'E11').hospitals).toEqual(['Hospital B', 'Hospital A']);
  });

  it('codes 依就診數降冪、代碼升冪排序，name 取該代碼最常見的名稱', () => {
    const group = groupOf(
      [
        visit(
          new Date(2025, 0, 1),
          '甲院',
          { code: 'E11.9', name: 'Name X' },
          { code: 'E11.0', name: 'Zeta' },
        ),
        visit(new Date(2025, 1, 1), '甲院', { code: 'E11.9', name: 'Name Y' }),
        visit(new Date(2025, 2, 1), '甲院', { code: 'E11.9', name: 'Name Y' }, 'E10'),
        visit(
          new Date(2025, 3, 1),
          '甲院',
          'E11.0',
          { code: 'E11.5', name: 'Five' },
          { code: 'E11.1', name: 'One' },
        ),
      ],
      'E11',
    );
    expect(group.codes).toEqual([
      { code: 'E11.9', name: 'Name Y', count: 3 },
      { code: 'E11.0', name: 'Zeta', count: 2 },
      { code: 'E11.1', name: 'One', count: 1 },
      { code: 'E11.5', name: 'Five', count: 1 },
    ]);
  });

  it('codes 的 name 同票時取最近一次就診者，全為空時退回代碼本身', () => {
    const group = groupOf(
      [
        visit(new Date(2024, 0, 1), '甲院', { code: 'E11.9', name: 'Older' }),
        visit(new Date(2025, 0, 1), '甲院', { code: 'E11.9', name: 'Newer' }),
        visit(new Date(2025, 0, 2), '甲院', 'E11.4'),
      ],
      'E11',
    );
    expect(group.codes.find((item) => item.code === 'E11.9')?.name).toBe('Newer');
    expect(group.codes.find((item) => item.code === 'E11.4')?.name).toBe('E11.4');
  });

  it('群組依最近就診日降冪、就診次數降冪、大類升冪排序', () => {
    const visits = [
      visit(new Date(2025, 4, 1), '甲院', 'C00', 'B00'),
      visit(new Date(2025, 6, 1), '甲院', 'D00'),
      visit(new Date(2025, 5, 1), '甲院', 'A00', 'B00', 'C00'),
    ];
    expect(roots(computeDiagnosisGroups(visits))).toEqual(['D00', 'B00', 'C00', 'A00']);
  });

  it('略過日期無效的就診', () => {
    const groups = computeDiagnosisGroups([
      visit(new Date(Number.NaN), '甲院', 'E11.9'),
      visit(new Date(2025, 0, 1), '乙院', 'I10'),
    ]);
    expect(roots(groups)).toEqual(['I10']);
  });

  it('不會修改傳入的 visits', () => {
    const visits = deepFreeze([
      visit(new Date(2025, 5, 1), '乙院', { code: 'e11.9', name: ' 糖尿病 ' }, 'I10'),
      visit(new Date(2024, 1, 1), '甲院', 'E11.0'),
    ]);
    const before = JSON.stringify(visits);

    expect(computeDiagnosisGroups(visits)).toHaveLength(2);
    expect(JSON.stringify(visits)).toBe(before);
  });
});

describe('sortDiagnosisGroups', () => {
  const groups = computeDiagnosisGroups([
    visit(new Date(2025, 0, 1), '甲院', 'A00'),
    visit(new Date(2025, 1, 1), '甲院', 'A00'),
    visit(new Date(2025, 2, 1), '甲院', 'A00'),
    visit(new Date(2025, 5, 1), '甲院', 'B00'),
    visit(new Date(2025, 4, 1), '甲院', 'C00'),
    visit(new Date(2025, 3, 1), '甲院', 'C00'),
  ]);

  it('recent 依最近就診日排序，count 依就診次數排序', () => {
    expect(roots(sortDiagnosisGroups(groups, 'recent'))).toEqual(['B00', 'C00', 'A00']);
    expect(roots(sortDiagnosisGroups(groups, 'count'))).toEqual(['A00', 'C00', 'B00']);
  });

  it('count 排序在次數相同時依最近就診日降冪，再依大類升冪', () => {
    const tied = computeDiagnosisGroups([
      visit(new Date(2025, 0, 1), '甲院', 'X00'),
      visit(new Date(2025, 2, 1), '甲院', 'Z00'),
      visit(new Date(2025, 2, 1), '甲院', 'Y00'),
    ]);
    expect(roots(sortDiagnosisGroups(tied, 'count'))).toEqual(['Y00', 'Z00', 'X00']);
  });

  it('回傳新陣列而不改變輸入', () => {
    const before = roots(groups);
    const sorted = sortDiagnosisGroups(groups, 'count');
    expect(sorted).not.toBe(groups);
    expect(roots(groups)).toEqual(before);
  });
});

describe('filterDiagnosisGroups', () => {
  const groups = computeDiagnosisGroups([
    visit(
      new Date(2025, 0, 1),
      'Hospital Alpha',
      { code: 'E11.9', name: 'Type 2 diabetes' },
      { code: 'E11.65', name: 'With hyperglycemia' },
    ),
    visit(new Date(2025, 1, 1), 'Hospital Beta', { code: 'I10', name: 'Hypertension' }),
  ]);

  it('查詢字串為空白時原樣回傳', () => {
    expect(filterDiagnosisGroups(groups, '')).toBe(groups);
    expect(filterDiagnosisGroups(groups, '   ')).toBe(groups);
  });

  it('比對大類代碼與群組名稱，不分大小寫', () => {
    expect(roots(filterDiagnosisGroups(groups, 'e11'))).toEqual(['E11']);
    expect(roots(filterDiagnosisGroups(groups, 'HYPERTENSION'))).toEqual(['I10']);
  });

  it('比對細項代碼與細項名稱', () => {
    expect(roots(filterDiagnosisGroups(groups, 'e11.65'))).toEqual(['E11']);
    expect(roots(filterDiagnosisGroups(groups, 'hyperglycemia'))).toEqual(['E11']);
  });

  it('不比對院所名稱，無符合時回傳空陣列', () => {
    expect(filterDiagnosisGroups(groups, 'Alpha')).toEqual([]);
    expect(filterDiagnosisGroups(groups, 'zzz')).toEqual([]);
  });

  it('含小數點與不含小數點的寫法可互相搜尋', () => {
    const dotless = computeDiagnosisGroups([visit(new Date(2025, 0, 1), '甲院', 'E119')]);
    const dotted = computeDiagnosisGroups([visit(new Date(2025, 0, 1), '甲院', 'E11.9')]);
    expect(roots(filterDiagnosisGroups(dotless, 'E11.9'))).toEqual(['E11']);
    expect(roots(filterDiagnosisGroups(dotted, 'e119'))).toEqual(['E11']);
  });
});
