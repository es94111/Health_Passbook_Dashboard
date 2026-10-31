import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { computeFreshness } from '../lib/freshness';
import DataFreshness from './DataFreshness';

afterEach(cleanup);

const NOW = new Date(2026, 9, 31, 12);
const freshnessOf = (daysOld: number) => computeFreshness(new Date(2026, 9, 31 - daysOld), NOW);

describe('DataFreshness', () => {
  it('renders nothing when there are no dated records', () => {
    const { container } = render(<DataFreshness freshness={computeFreshness(null, NOW)} />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the newest record date and its age', () => {
    const { container } = render(<DataFreshness freshness={freshnessOf(11)} />);
    expect(container.textContent).toContain('資料最新到 2026-10-20（距今 11 天）');
    expect(container.textContent).not.toContain('已超過');
  });

  it('says today when the newest record is from today', () => {
    const { container } = render(<DataFreshness freshness={freshnessOf(0)} />);
    expect(container.textContent).toContain('資料最新到 2026-10-31（今天）');
  });

  it('does not warn at exactly the threshold', () => {
    const { container } = render(<DataFreshness freshness={freshnessOf(90)} />);
    expect(container.textContent).toContain('距今 90 天');
    expect(container.textContent).not.toContain('已超過');
  });

  it('warns in words once the data is older than the threshold', () => {
    const { container } = render(<DataFreshness freshness={freshnessOf(91)} />);
    expect(container.textContent).toContain('資料最新到 2026-08-01（距今 91 天）');
    expect(container.textContent).toContain('已超過 90 天沒有新資料');
    expect(container.textContent).toContain('重新匯出並匯入最新資料');
  });

  it('uses the amber attention colour only for stale data', () => {
    const fresh = render(<DataFreshness freshness={freshnessOf(5)} />);
    expect(fresh.container.firstElementChild?.className).toContain('text-gray-500');
    expect(fresh.container.firstElementChild?.className).not.toContain('text-amber-700');
    cleanup();

    const stale = render(<DataFreshness freshness={freshnessOf(200)} />);
    expect(stale.container.firstElementChild?.className).toContain('text-amber-700');
    expect(stale.container.firstElementChild?.className).toContain('dark:text-amber-400');
  });
});
