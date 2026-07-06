import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { UserProfile, UserPreferences, DateRangePreset } from './api';
import { updatePreferences } from './api';

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
];

// ── Store shape ─────────────────────────────────────────────────────────────────

interface UserStoreValue {
  profile: UserProfile;
  token: string | null;
  preferences: UserPreferences;
  // pins
  isLabPinned: (subItem: string) => boolean;
  toggleLabPin: (subItem: string) => void;
  isMedicationPinned: (code: string) => boolean;
  toggleMedicationPin: (code: string) => void;
  // sections
  isSectionHidden: (key: string) => boolean;
  toggleSection: (key: string) => void;
  // misc preferences
  setDefaultDateRange: (range: DateRangePreset) => void;
  setLastActiveTab: (tab: string) => void;
  isAlertAcknowledged: (id: string) => boolean;
  acknowledgeAlert: (id: string) => void;
}

const UserStoreContext = createContext<UserStoreValue | null>(null);

export function useUserStore(): UserStoreValue {
  const ctx = useContext(UserStoreContext);
  if (!ctx) throw new Error('useUserStore must be used within a UserStoreProvider');
  return ctx;
}

interface ProviderProps {
  profile: UserProfile;
  onProfileUpdate: (patch: Partial<UserProfile>) => void;
  children: ReactNode;
}

export function UserStoreProvider({ profile, onProfileUpdate, children }: ProviderProps) {
  const preferences = profile.preferences;

  // Apply a patch optimistically, then persist. `previous` is the state the patch
  // was computed against, so a failed save rolls back to exactly that value.
  const patchPreferences = useCallback(
    (patch: Partial<UserPreferences>, previous: UserPreferences) => {
      onProfileUpdate({ preferences: { ...previous, ...patch } });
      updatePreferences(patch)
        .then((serverPrefs) => onProfileUpdate({ preferences: serverPrefs }))
        .catch((err) => {
          console.error('[UserStore] 偏好設定儲存失敗，已還原：', err);
          onProfileUpdate({ preferences: previous });
        });
    },
    [onProfileUpdate],
  );

  const value = useMemo<UserStoreValue>(() => {
    const toggleInArray = (key: 'pinnedLabItems' | 'pinnedMedications' | 'hiddenSections', item: string) => {
      const list = preferences[key];
      const next = list.includes(item) ? list.filter((v) => v !== item) : [...list, item];
      patchPreferences({ [key]: next } as Partial<UserPreferences>, preferences);
    };
    return {
      profile,
      token: localStorage.getItem('nhi_token'),
      preferences,
      isLabPinned: (subItem) => preferences.pinnedLabItems.includes(subItem),
      toggleLabPin: (subItem) => toggleInArray('pinnedLabItems', subItem),
      isMedicationPinned: (code) => preferences.pinnedMedications.includes(code),
      toggleMedicationPin: (code) => toggleInArray('pinnedMedications', code),
      isSectionHidden: (key) => preferences.hiddenSections.includes(key),
      toggleSection: (key) => toggleInArray('hiddenSections', key),
      setDefaultDateRange: (range) => patchPreferences({ defaultDateRange: range }, preferences),
      setLastActiveTab: (tab) => {
        if (preferences.lastActiveTab === tab) return;
        patchPreferences({ lastActiveTab: tab }, preferences);
      },
      isAlertAcknowledged: (id) => preferences.acknowledgedAlerts.includes(id),
      acknowledgeAlert: (id) => {
        if (preferences.acknowledgedAlerts.includes(id)) return;
        patchPreferences({ acknowledgedAlerts: [...preferences.acknowledgedAlerts, id] }, preferences);
      },
    };
  }, [profile, preferences, patchPreferences]);

  return <UserStoreContext.Provider value={value}>{children}</UserStoreContext.Provider>;
}
