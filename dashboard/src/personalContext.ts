import { createContext, useContext } from 'react';
import { emptyPersonal, type PersonalData } from './personalData';

export interface PersonalContextValue {
  personal: PersonalData;
  /** 已解鎖並可加密寫回；沒有 provider 或資料庫未載入時為 false。 */
  canEdit: boolean;
  saving: boolean;
  error: string | null;
  clearError: () => void;
  /**
   * 以最新的個人資料為基礎套用變更並加密儲存。
   * 多次呼叫會依序執行，後一次看到前一次的結果；成功回傳 true，失敗回傳 false 並設定 error。
   * mutator 必須是純函式，不可直接修改傳入的物件。
   */
  update: (mutator: (current: PersonalData) => PersonalData) => Promise<boolean>;
}

export const EMPTY_PERSONAL: PersonalData = emptyPersonal();

const READ_ONLY: PersonalContextValue = {
  personal: EMPTY_PERSONAL,
  canEdit: false,
  saving: false,
  error: null,
  clearError: () => {},
  update: async () => false,
};

export const PersonalContext = createContext<PersonalContextValue>(READ_ONLY);

export function usePersonal(): PersonalContextValue {
  return useContext(PersonalContext);
}
