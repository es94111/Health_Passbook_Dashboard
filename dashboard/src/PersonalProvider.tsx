import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ApiError, type ClientEncryptedRecords } from './api';
import type { NHIData } from './parsers/types';
import type { PersonalData } from './personalData';
import { EMPTY_PERSONAL, PersonalContext, type PersonalContextValue } from './personalContext';

export interface PersonalSaveResult {
  data: NHIData;
  envelope: ClientEncryptedRecords;
}

interface Props {
  data: NHIData;
  /** 儲存成功後呼叫；元件已卸載（例如已鎖定或登出）時不會呼叫。 */
  onSaved: (result: PersonalSaveResult) => void;
  children: ReactNode;
}

const INVALID_PREFIX = '加密個人資料已損壞：';
const UNAVAILABLE = '目前無法儲存個人資料，請先解鎖並載入加密病歷';
const CONFLICT = '資料已在其他分頁或裝置更新，請重新解鎖後再試';

function describeError(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return CONFLICT;
  const message = err instanceof Error ? err.message : '';
  if (message.startsWith(INVALID_PREFIX)) return `輸入內容不符合格式：${message.slice(INVALID_PREFIX.length)}`;
  return message ? `儲存失敗：${message}` : '儲存失敗，請稍後再試';
}

export default function PersonalProvider({ data, onSaved, children }: Props) {
  const [pending, setPending] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(data);
  const savedHandler = useRef(onSaved);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const mounted = useRef(true);
  // 已被自己的儲存取代的舊畫面資料；延遲的重新渲染不可讓它們倒灌回 latest。
  const superseded = useRef(new WeakSet<NHIData>());

  useLayoutEffect(() => {
    savedHandler.current = onSaved;
    if (!superseded.current.has(data)) latest.current = data;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const update = useCallback((mutator: (current: PersonalData) => PersonalData) => {
    setError(null);
    setPending((n) => n + 1);
    const run = async (): Promise<boolean> => {
      const session = latest.current;
      const save = session.savePersonal;
      if (!save) {
        if (mounted.current) setError(UNAVAILABLE);
        return false;
      }
      try {
        const result = await save(mutator(session.personal ?? EMPTY_PERSONAL));
        superseded.current.add(session);
        latest.current = result.data;
        if (mounted.current) savedHandler.current(result);
        return true;
      } catch (err) {
        if (mounted.current) setError(describeError(err));
        return false;
      }
    };
    const task = queue.current.then(run);
    queue.current = task;
    return task.finally(() => {
      if (mounted.current) setPending((n) => n - 1);
    });
  }, []);

  const personal = data.personal ?? EMPTY_PERSONAL;
  const canEdit = Boolean(data.savePersonal);
  const value = useMemo<PersonalContextValue>(
    () => ({ personal, canEdit, saving: pending > 0, error, clearError, update }),
    [personal, canEdit, pending, error, clearError, update],
  );

  return <PersonalContext.Provider value={value}>{children}</PersonalContext.Provider>;
}
