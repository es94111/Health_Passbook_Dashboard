// ── Hideable dashboard sections ─────────────────────────────────────────────────
// Section keys are stored in preferences.hiddenSections. Tab sections are prefixed
// with `tab:` so they never collide with the standalone section keys.

export const SECTION_KEY = {
  keySummary: 'keySummary',
  summaryStats: 'summaryStats',
} as const;

export function tabSectionKey(tab: string): string {
  return `tab:${tab}`;
}

export interface HideableSection {
  key: string;
  label: string;
}

export const HIDEABLE_SECTIONS: HideableSection[] = [
  { key: SECTION_KEY.keySummary, label: '重點摘要' },
  { key: SECTION_KEY.summaryStats, label: '統計總覽' },
  { key: tabSectionKey('門診'), label: '門診分頁' },
  { key: tabSectionKey('住院'), label: '住院分頁' },
  { key: tabSectionKey('檢驗'), label: '檢驗分頁' },
  { key: tabSectionKey('牙科'), label: '牙科分頁' },
  { key: tabSectionKey('預防保健'), label: '預防保健分頁' },
  { key: tabSectionKey('醫療報告'), label: '醫療報告分頁' },
  { key: tabSectionKey('影像報告'), label: '影像報告分頁' },
  { key: tabSectionKey('用藥'), label: '用藥分頁' },
  { key: tabSectionKey('自我量測'), label: '自我量測分頁' },
  { key: tabSectionKey('健康檔案'), label: '健康檔案分頁' },
  { key: tabSectionKey('看診摘要'), label: '看診摘要分頁' },
  { key: tabSectionKey('同步紀錄'), label: '同步紀錄分頁' },
];
