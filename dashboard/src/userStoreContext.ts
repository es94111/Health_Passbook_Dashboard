import { createContext, useContext } from 'react';
import type { UserProfile, UserPreferences, DateRangePreset } from './api';

// ── Store shape ─────────────────────────────────────────────────────────────────

export interface UserStoreValue {
  profile: UserProfile;
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

export const UserStoreContext = createContext<UserStoreValue | null>(null);

export function useUserStore(): UserStoreValue {
  const ctx = useContext(UserStoreContext);
  if (!ctx) throw new Error('useUserStore must be used within a UserStoreProvider');
  return ctx;
}
