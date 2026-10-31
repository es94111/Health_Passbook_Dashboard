import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import DiagnosisGroups from './DiagnosisGroups';
import type { Visit } from '../parsers/types';

afterEach(cleanup);

function visit(date: Date, hospital: string, diagnoses: { code: string; name: string }[]): Visit {
  return { date, hospital, diagnoses, procedures: [] };
}

// E11：3 次（2024-01-15 ~ 2025-06-10）、J00：2 次（最近 2025-09-01）、I10：1 次
const SAMPLE: Visit[] = [
  visit(new Date(2025, 5, 10), '台大醫院', [
    { code: 'E11.9', name: '第2型糖尿病' },
    { code: 'I10', name: '原發性高血壓' },
  ]),
  visit(new Date(2025, 2, 3), '台大醫院', [{ code: 'E11.9', name: '第2型糖尿病' }]),
  visit(new Date(2024, 0, 15), '榮總', [
    { code: 'E11.65', name: '糖尿病併高血糖' },
    { code: 'J00', name: '急性鼻咽炎' },
  ]),
  visit(new Date(2025, 8, 1), '林口長庚', [{ code: 'J00', name: '急性鼻咽炎' }]),
];

const MANY_HOSPITALS: Visit[] = ['A', 'B', 'C', 'D', 'E'].map((suffix, index) =>
  visit(new Date(2025, 0, index + 1), `Hospital ${suffix}`, [{ code: 'K29.7', name: '胃炎' }]),
);

function visibleRoots(): string[] {
  return screen
    .queryAllByRole('button', { name: /細項$/ })
    .map((button) => (button.getAttribute('aria-label') ?? '').split(' ')[1] ?? '');
}

function rowOf(root: string): HTMLElement {
  const button = screen.getByRole('button', { name: new RegExp(`^(?:展開|收合) ${root} 細項$`) });
  const row = button.closest('li');
  if (!row) throw new Error(`找不到 ${root} 的群組列`);
  return row;
}

function searchBox(): HTMLElement {
  return screen.getByRole('textbox', { name: '搜尋診斷' });
}

function sortSelect(): HTMLElement {
  return screen.getByRole('combobox', { name: '診斷排序' });
}

function statusText(): string {
  return screen.getByRole('status').textContent ?? '';
}

function missingDarkVariants(root: HTMLElement): string[] {
  const colorToken = /^(bg|text|border|divide)-(?:gray|teal|white|black)/;
  const missing: string[] = [];
  for (const element of Array.from(root.querySelectorAll('*'))) {
    const tokens = Array.from(element.classList);
    for (const token of tokens) {
      const prefix = colorToken.exec(token)?.[1];
      if (prefix && !tokens.some((other) => other.startsWith(`dark:${prefix}-`))) {
        missing.push(token);
      }
    }
  }
  return missing;
}

describe('DiagnosisGroups', () => {
  it('顯示區塊標題、說明與工具列', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    const region = screen.getByRole('region', { name: '診斷彙總' });
    expect(within(region).getByRole('heading', { level: 2, name: '診斷彙總' })).toBeTruthy();
    expect(within(region).getByText(/依診斷碼前 3 碼（ICD 大類）彙總/)).toBeTruthy();
    expect(within(region).getByText(/僅統計門診紀錄/)).toBeTruthy();

    expect(searchBox().getAttribute('placeholder')).toBe('搜尋診斷碼或名稱');
    expect(searchBox().parentElement?.className).toContain('print:hidden');
    expect(
      within(sortSelect())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['最近就診', '就診次數']);
  });

  it('預設依最近就診排序並顯示群組數量', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    expect(visibleRoots()).toEqual(['J00', 'E11', 'I10']);
    expect(statusText()).toBe('顯示 3 / 3 個診斷群組');
    expect(screen.getAllByRole('button', { name: /細項$/ }).every((button) => button.getAttribute('aria-expanded') === 'false')).toBe(true);
  });

  it('切換為就診次數排序後可切回最近就診', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(sortSelect(), { target: { value: 'count' } });
    expect(visibleRoots()).toEqual(['E11', 'J00', 'I10']);
    fireEvent.change(sortSelect(), { target: { value: 'recent' } });
    expect(visibleRoots()).toEqual(['J00', 'E11', 'I10']);
  });

  it('每列顯示代碼徽章、名稱、就診次數、首末就診日與院所', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    const row = rowOf('E11');
    expect(within(row).getByRole('heading', { level: 3, name: '第2型糖尿病' })).toBeTruthy();

    const badge = within(row).getByText('E11');
    expect(badge.className).toContain('badge');
    expect(badge.className).toContain('font-mono');

    const first = within(row).getByText('2024-01-15');
    const last = within(row).getByText('2025-06-10');
    expect(first.className).toContain('font-mono');
    expect(last.className).toContain('font-mono');

    const text = row.textContent ?? '';
    expect(text).toContain('3 次就診');
    expect(text).toContain('首次就診 2024-01-15');
    expect(text).toContain('最近就診 2025-06-10');
    expect(text).toContain('院所：台大醫院、榮總');

    const other = rowOf('J00').textContent ?? '';
    expect(other).toContain('2 次就診');
    expect(other).toContain('最近就診 2025-09-01');
    expect(other).toContain('榮總');
    expect(other).toContain('林口長庚');
    expect(other).not.toContain('等');
  });

  it('搜尋可用診斷群組代碼且不分大小寫', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(searchBox(), { target: { value: 'e11' } });
    expect(visibleRoots()).toEqual(['E11']);
    expect(statusText()).toBe('顯示 1 / 3 個診斷群組');
  });

  it('搜尋可用群組名稱', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(searchBox(), { target: { value: '高血壓' } });
    expect(visibleRoots()).toEqual(['I10']);
  });

  it('搜尋可比對細項代碼與細項名稱', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(searchBox(), { target: { value: 'e11.65' } });
    expect(visibleRoots()).toEqual(['E11']);

    fireEvent.change(searchBox(), { target: { value: '併高血糖' } });
    expect(visibleRoots()).toEqual(['E11']);
    expect(statusText()).toBe('顯示 1 / 3 個診斷群組');
  });

  it('空白查詢顯示全部，多筆結果同時列出', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(searchBox(), { target: { value: '   ' } });
    expect(visibleRoots()).toEqual(['J00', 'E11', 'I10']);

    fireEvent.change(searchBox(), { target: { value: '1' } });
    expect(visibleRoots()).toEqual(['E11', 'I10']);
    expect(statusText()).toBe('顯示 2 / 3 個診斷群組');
  });

  it('搜尋沒有結果時顯示空狀態，清除搜尋後恢復清單', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(screen.getByText('沒有符合條件的診斷群組')).toBeTruthy();
    expect(statusText()).toBe('顯示 0 / 3 個診斷群組');
    expect(screen.queryByRole('list', { name: '診斷群組清單' })).toBeNull();
    expect(screen.queryByText('尚無診斷資料')).toBeNull();

    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(screen.queryByText('沒有符合條件的診斷群組')).toBeNull();
    expect(visibleRoots()).toEqual(['J00', 'E11', 'I10']);
  });

  it('展開與收合細項', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    const button = screen.getByRole('button', { name: '展開 E11 細項' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'E11 細項診斷碼' })).toBeNull();

    fireEvent.click(button);
    const opened = screen.getByRole('button', { name: '收合 E11 細項' });
    expect(opened.getAttribute('aria-expanded')).toBe('true');

    const detail = within(rowOf('E11')).getByRole('list', { name: 'E11 細項診斷碼' });
    expect(
      within(detail)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['E11.9第2型糖尿病2 次', 'E11.65糖尿病併高血糖1 次']);
    expect(within(detail).getByText('E11.9').className).toContain('font-mono');
    expect(within(detail).getByText('2 次').className).toContain('font-mono');

    expect(screen.getByRole('button', { name: '展開 J00 細項' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByRole('button', { name: '展開 I10 細項' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'J00 細項診斷碼' })).toBeNull();

    fireEvent.click(opened);
    expect(screen.getByRole('button', { name: '展開 E11 細項' }).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('list', { name: 'E11 細項診斷碼' })).toBeNull();
  });

  it('切換排序或搜尋後保留各群組的展開狀態', () => {
    render(<DiagnosisGroups visits={SAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: '展開 E11 細項' }));

    fireEvent.change(sortSelect(), { target: { value: 'count' } });
    expect(screen.getByRole('button', { name: '收合 E11 細項' }).getAttribute('aria-expanded')).toBe('true');

    fireEvent.change(searchBox(), { target: { value: 'j00' } });
    expect(visibleRoots()).toEqual(['J00']);

    fireEvent.change(searchBox(), { target: { value: '' } });
    expect(screen.getByRole('button', { name: '收合 E11 細項' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('button', { name: '展開 J00 細項' }).getAttribute('aria-expanded')).toBe('false');
  });

  it('院所超過 3 家時只列前 3 家並顯示「等 N 家」，剛好 3 家則不顯示', () => {
    const { unmount } = render(<DiagnosisGroups visits={MANY_HOSPITALS} />);
    const text = rowOf('K29').textContent ?? '';
    expect(text).toContain('院所：Hospital A、Hospital B、Hospital C 等 5 家');
    expect(text).not.toContain('Hospital D');
    expect(text).not.toContain('Hospital E');
    unmount();

    render(<DiagnosisGroups visits={MANY_HOSPITALS.slice(0, 3)} />);
    const three = rowOf('K29').textContent ?? '';
    expect(three).toContain('院所：Hospital A、Hospital B、Hospital C');
    expect(three).not.toContain('等');
  });

  it('沒有任何診斷時顯示「尚無診斷資料」並隱藏工具列', () => {
    render(<DiagnosisGroups visits={[]} />);
    expect(screen.getByRole('region', { name: '診斷彙總' })).toBeTruthy();
    expect(screen.getByText('尚無診斷資料')).toBeTruthy();
    expect(screen.queryByText('沒有符合條件的診斷群組')).toBeNull();
    expect(screen.queryByRole('textbox', { name: '搜尋診斷' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: '診斷排序' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('診斷皆缺少代碼或就診沒有診斷時同樣視為尚無資料', () => {
    const date = new Date(2025, 0, 1);
    render(
      <DiagnosisGroups
        visits={[visit(date, '台大醫院', []), visit(date, '榮總', [{ code: ' . ', name: '無代碼診斷' }])]}
      />,
    );
    expect(screen.getByText('尚無診斷資料')).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('visits 變動時重新彙總', () => {
    const { rerender } = render(<DiagnosisGroups visits={[]} />);
    expect(screen.getByText('尚無診斷資料')).toBeTruthy();

    rerender(<DiagnosisGroups visits={SAMPLE} />);
    expect(visibleRoots()).toEqual(['J00', 'E11', 'I10']);
    expect(statusText()).toBe('顯示 3 / 3 個診斷群組');

    rerender(<DiagnosisGroups visits={SAMPLE.slice(0, 1)} />);
    expect(visibleRoots()).toEqual(['E11', 'I10']);
    expect(statusText()).toBe('顯示 2 / 2 個診斷群組');
  });

  it('診斷名稱為空時以代碼作為群組標題', () => {
    render(<DiagnosisGroups visits={[visit(new Date(2025, 0, 1), '台大醫院', [{ code: 'Z99', name: '' }])]} />);
    expect(within(rowOf('Z99')).getByRole('heading', { level: 3, name: 'Z99' })).toBeTruthy();
  });

  it('所有顏色類別都有 dark: 變體', () => {
    const { container, unmount } = render(<DiagnosisGroups visits={SAMPLE} />);
    for (const button of screen.getAllByRole('button', { name: /^展開/ })) fireEvent.click(button);
    expect(screen.getAllByRole('list', { name: /細項診斷碼$/ })).toHaveLength(3);
    expect(missingDarkVariants(container)).toEqual([]);
    fireEvent.change(searchBox(), { target: { value: 'zzz' } });
    expect(missingDarkVariants(container)).toEqual([]);
    unmount();

    const empty = render(<DiagnosisGroups visits={[]} />);
    expect(missingDarkVariants(empty.container)).toEqual([]);
  });
});
