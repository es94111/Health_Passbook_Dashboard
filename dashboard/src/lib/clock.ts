import { useState } from 'react';

/** 取得元件掛載當下的時間；測試可傳入 `override` 固定日期。 */
export function useNow(override?: Date): Date {
  const [mounted] = useState(() => new Date());
  return override ?? mounted;
}

/** 兩個日曆日之間相差的天數（忽略時間），後者較晚時為正。 */
export function daysBetween(from: Date, to: Date): number {
  const start = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const end = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((end - start) / 86_400_000);
}

/** 以本地日曆加減天數，回傳當日 00:00 的新 Date。 */
export function addDays(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** 本地日期轉 YYYY-MM-DD；不可用 toISOString，否則 UTC+8 凌晨會差一天。 */
export function formatLocalDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${String(date.getFullYear()).padStart(4, '0')}-${month}-${day}`;
}

/** 將 YYYY-MM-DD 解析為本地當日 00:00；呼叫端需先確認格式有效。 */
export function parseLocalDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}
