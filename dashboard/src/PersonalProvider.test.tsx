import { act, cleanup, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, type ClientEncryptedRecords } from './api';
import { parseNHIJson } from './parsers/nhi-parser';
import type { NHIData } from './parsers/types';
import { usePersonal } from './personalContext';
import { emptyPersonal, isPersonalEmpty, type PersonalData } from './personalData';
import PersonalProvider, { type PersonalSaveResult } from './PersonalProvider';

const envelope = { revision: 'test-revision' } as unknown as ClientEncryptedRecords;

function addNote(id: string) {
  return (current: PersonalData): PersonalData => ({
    ...current,
    notes: [...current.notes, { id, date: '2026-10-01', kind: 'note', text: `筆記 ${id}` }],
  });
}

function noteIds(personal: PersonalData | undefined): string[] {
  return (personal?.notes ?? []).map((note) => note.id);
}

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function fakeVault(options: { initial?: PersonalData; beforeSave?: (call: number) => Promise<void> } = {}) {
  const started: PersonalData[] = [];
  const make = (personal: PersonalData): NHIData => ({
    ...parseNHIJson({}),
    personal,
    savePersonal: async (next) => {
      started.push(next);
      await options.beforeSave?.(started.length);
      return { data: make(next), envelope };
    },
  });
  return { first: make(options.initial ?? emptyPersonal()), started };
}

function mount(initial: NHIData) {
  const state = { data: initial, onSaved: vi.fn<(result: PersonalSaveResult) => void>() };
  const onSaved = state.onSaved;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <PersonalProvider data={state.data} onSaved={state.onSaved}>
      {children}
    </PersonalProvider>
  );
  const view = renderHook(() => usePersonal(), { wrapper });
  return {
    view,
    state,
    onSaved,
    apply(next: NHIData) {
      state.data = next;
      view.rerender();
    },
  };
}

afterEach(cleanup);

describe('PersonalProvider', () => {
  it('falls back to an empty read-only context without a provider', async () => {
    const { result } = renderHook(() => usePersonal());
    expect(isPersonalEmpty(result.current.personal)).toBe(true);
    expect(result.current.canEdit).toBe(false);
    expect(result.current.saving).toBe(false);
    expect(result.current.error).toBeNull();
    await expect(result.current.update((current) => current)).resolves.toBe(false);
  });

  it('exposes the stored personal data and whether it can be saved', () => {
    const stored = addNote('stored')(emptyPersonal());
    const editable = mount(fakeVault({ initial: stored }).first);
    expect(editable.view.result.current.personal).toBe(stored);
    expect(editable.view.result.current.canEdit).toBe(true);

    const readOnly = mount({ ...parseNHIJson({}), personal: stored });
    expect(readOnly.view.result.current.personal).toBe(stored);
    expect(readOnly.view.result.current.canEdit).toBe(false);
  });

  it('treats a vault without a personal section as empty and read-only', () => {
    const { view } = mount(parseNHIJson({}));
    expect(isPersonalEmpty(view.result.current.personal)).toBe(true);
    expect(view.result.current.canEdit).toBe(false);
  });

  it('saves what the mutator returns and hands the result to the parent', async () => {
    const vault = fakeVault();
    const { view, onSaved } = mount(vault.first);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await view.result.current.update(addNote('n1'));
    });

    expect(ok).toBe(true);
    expect(vault.started.map(noteIds)).toEqual([['n1']]);
    expect(onSaved).toHaveBeenCalledTimes(1);
    const saved = onSaved.mock.calls[0][0];
    expect(noteIds(saved.data.personal)).toEqual(['n1']);
    expect(saved.envelope).toBe(envelope);
    expect(view.result.current.error).toBeNull();
    expect(view.result.current.saving).toBe(false);
  });

  it('shows the saved data once the parent applies the result', async () => {
    const vault = fakeVault();
    const { view, onSaved, apply } = mount(vault.first);
    await act(async () => {
      await view.result.current.update(addNote('n1'));
    });
    act(() => apply(onSaved.mock.calls[0][0].data));

    expect(noteIds(view.result.current.personal)).toEqual(['n1']);
    expect(view.result.current.canEdit).toBe(true);
  });

  it('starts from empty data when the vault has no personal section yet', async () => {
    const vault = fakeVault();
    const { view } = mount({ ...vault.first, personal: undefined });
    const mutator = vi.fn((current: PersonalData) => addNote('n1')(current));
    await act(async () => {
      await view.result.current.update(mutator);
    });

    expect(isPersonalEmpty(mutator.mock.calls[0][0])).toBe(true);
    expect(vault.started.map(noteIds)).toEqual([['n1']]);
  });

  it('runs overlapping updates one at a time, each starting from the previous result', async () => {
    const gate = deferred();
    const vault = fakeVault({
      beforeSave: async (call) => {
        if (call === 1) await gate.promise;
      },
    });
    const { view, onSaved } = mount(vault.first);

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = view.result.current.update(addNote('a'));
      second = view.result.current.update(addNote('b'));
    });
    await act(async () => {});
    expect(vault.started).toHaveLength(1);
    expect(view.result.current.saving).toBe(true);

    gate.release();
    await act(async () => {
      await Promise.all([first, second]);
    });

    expect(vault.started.map(noteIds)).toEqual([['a'], ['a', 'b']]);
    expect(onSaved).toHaveBeenCalledTimes(2);
    expect(view.result.current.saving).toBe(false);
  });

  it('keeps building on the newest data when a stale render arrives before the parent applies a save', async () => {
    const vault = fakeVault();
    const { view, apply } = mount(vault.first);
    await act(async () => {
      await view.result.current.update(addNote('a'));
    });
    act(() => apply(vault.first));
    await act(async () => {
      await view.result.current.update(addNote('b'));
    });

    expect(vault.started.map(noteIds)).toEqual([['a'], ['a', 'b']]);
  });

  it('does not advance the base after a failed save', async () => {
    const vault = fakeVault({
      beforeSave: async (call) => {
        if (call === 1) throw new Error('offline');
      },
    });
    const { view, onSaved } = mount(vault.first);
    let failed: boolean | undefined;
    let retried: boolean | undefined;
    await act(async () => {
      failed = await view.result.current.update(addNote('a'));
    });
    expect(failed).toBe(false);
    expect(onSaved).not.toHaveBeenCalled();
    await act(async () => {
      retried = await view.result.current.update(addNote('b'));
    });

    expect(retried).toBe(true);
    expect(vault.started.map(noteIds)).toEqual([['a'], ['b']]);
    expect(view.result.current.error).toBeNull();
  });

  it('explains a revision conflict and lets the user dismiss it', async () => {
    const vault = fakeVault({
      beforeSave: async () => {
        throw new ApiError('conflict', 409);
      },
    });
    const { view, onSaved } = mount(vault.first);
    let ok: boolean | undefined;
    await act(async () => {
      ok = await view.result.current.update(addNote('a'));
    });

    expect(ok).toBe(false);
    expect(view.result.current.error).toBe('資料已在其他分頁或裝置更新，請重新解鎖後再試');
    expect(onSaved).not.toHaveBeenCalled();
    act(() => view.result.current.clearError());
    expect(view.result.current.error).toBeNull();
  });

  it.each([
    ['an invalid payload', new Error('加密個人資料已損壞：notes[0].date'), '輸入內容不符合格式：notes[0].date'],
    ['a network failure', new Error('Failed to fetch'), '儲存失敗：Failed to fetch'],
    ['an error without a message', new Error(''), '儲存失敗，請稍後再試'],
    ['a rejection that is not an error', 'boom', '儲存失敗，請稍後再試'],
  ])('describes %s', async (_name, failure, expected) => {
    const vault = fakeVault({
      beforeSave: async () => {
        throw failure;
      },
    });
    const { view } = mount(vault.first);
    await act(async () => {
      await view.result.current.update(addNote('a'));
    });

    expect(view.result.current.error).toBe(expected);
  });

  it('clears the previous error when a new attempt starts', async () => {
    const vault = fakeVault({
      beforeSave: async (call) => {
        if (call === 1) throw new Error('offline');
      },
    });
    const { view } = mount(vault.first);
    await act(async () => {
      await view.result.current.update(addNote('a'));
    });
    expect(view.result.current.error).not.toBeNull();
    await act(async () => {
      await view.result.current.update(addNote('b'));
    });

    expect(view.result.current.error).toBeNull();
  });

  it('refuses to save when no vault session is available', async () => {
    const mutator = vi.fn((current: PersonalData) => current);
    const { view } = mount(parseNHIJson({}));
    let ok: boolean | undefined;
    await act(async () => {
      ok = await view.result.current.update(mutator);
    });

    expect(ok).toBe(false);
    expect(mutator).not.toHaveBeenCalled();
    expect(view.result.current.error).toBe('目前無法儲存個人資料，請先解鎖並載入加密病歷');
  });

  it('reports a throwing mutator without saving and keeps the queue usable', async () => {
    const vault = fakeVault();
    const { view } = mount(vault.first);
    let bad: boolean | undefined;
    let good: boolean | undefined;
    await act(async () => {
      bad = await view.result.current.update(() => {
        throw new Error('壞資料');
      });
    });

    expect(bad).toBe(false);
    expect(vault.started).toHaveLength(0);
    expect(view.result.current.error).toBe('儲存失敗：壞資料');
    await act(async () => {
      good = await view.result.current.update(addNote('a'));
    });
    expect(good).toBe(true);
    expect(view.result.current.error).toBeNull();
  });

  it('does not notify the parent after the provider unmounts', async () => {
    const gate = deferred();
    const vault = fakeVault({ beforeSave: () => gate.promise });
    const { view, onSaved } = mount(vault.first);
    let pending!: Promise<boolean>;
    act(() => {
      pending = view.result.current.update(addNote('a'));
    });
    await act(async () => {});
    view.unmount();
    gate.release();

    await expect(pending).resolves.toBe(true);
    expect(vault.started).toHaveLength(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('always calls the most recent onSaved handler', async () => {
    const vault = fakeVault();
    const { view, state, onSaved } = mount(vault.first);
    const replacement = vi.fn<(result: PersonalSaveResult) => void>();
    state.onSaved = replacement;
    view.rerender();
    await act(async () => {
      await view.result.current.update(addNote('a'));
    });

    expect(replacement).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('keeps the context value stable across unrelated renders', () => {
    const { view, state } = mount(fakeVault().first);
    const before = view.result.current;
    state.onSaved = vi.fn();
    view.rerender();

    expect(view.result.current).toBe(before);
  });
});
