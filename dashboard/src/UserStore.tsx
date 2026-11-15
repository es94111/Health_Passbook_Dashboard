import { useCallback, useMemo, type ReactNode } from 'react';
import type { UserProfile, UserPreferences } from './api';
import { updatePreferences } from './api';
import { UserStoreContext, type UserStoreValue } from './userStoreContext';

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
