import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, formatLocalDate, parseLocalDate, useNow } from './clock';

describe('calendar helpers', () => {
  it('counts calendar days regardless of the time of day', () => {
    expect(daysBetween(new Date(2026, 0, 1, 23, 59), new Date(2026, 0, 2, 0, 1))).toBe(1);
    expect(daysBetween(new Date(2026, 0, 2), new Date(2026, 0, 1))).toBe(-1);
    expect(daysBetween(new Date(2026, 4, 5, 8), new Date(2026, 4, 5, 20))).toBe(0);
  });

  it('counts across month, leap day and year boundaries', () => {
    expect(daysBetween(new Date(2024, 1, 28), new Date(2024, 2, 1))).toBe(2);
    expect(daysBetween(new Date(2025, 1, 28), new Date(2025, 2, 1))).toBe(1);
    expect(daysBetween(new Date(2025, 11, 31), new Date(2026, 0, 1))).toBe(1);
  });

  it('adds days on the local calendar and drops the time', () => {
    const next = addDays(new Date(2026, 0, 30, 15, 30), 3);
    expect(formatLocalDate(next)).toBe('2026-02-02');
    expect(next.getHours()).toBe(0);
    expect(formatLocalDate(addDays(new Date(2026, 2, 1), -1))).toBe('2026-02-28');
  });

  it('formats and parses local dates symmetrically', () => {
    expect(formatLocalDate(new Date(2026, 8, 5, 0, 30))).toBe('2026-09-05');
    expect(formatLocalDate(new Date(2026, 8, 5, 23, 59))).toBe('2026-09-05');
    expect(parseLocalDate('2026-09-05').getTime()).toBe(new Date(2026, 8, 5).getTime());
    expect(formatLocalDate(parseLocalDate('2024-02-29'))).toBe('2024-02-29');
  });
});

describe('useNow', () => {
  it('prefers the injected time', () => {
    const fixed = new Date(2026, 5, 1);
    const { result } = renderHook(() => useNow(fixed));
    expect(result.current).toBe(fixed);
  });

  it('keeps the same instant across re-renders', () => {
    const { result, rerender } = renderHook(() => useNow());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
