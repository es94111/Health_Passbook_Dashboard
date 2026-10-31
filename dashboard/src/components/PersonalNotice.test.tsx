import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_PERSONAL, PersonalContext, type PersonalContextValue } from '../personalContext';
import PersonalNotice from './PersonalNotice';

afterEach(cleanup);

const value = (overrides: Partial<PersonalContextValue> = {}): PersonalContextValue => ({
  personal: EMPTY_PERSONAL,
  canEdit: true,
  saving: false,
  error: null,
  clearError: () => {},
  update: async () => true,
  ...overrides,
});

describe('PersonalNotice', () => {
  it('explains the read-only state when rendered without a provider', () => {
    render(<PersonalNotice />);
    expect(screen.getByText(/目前為唯讀狀態/)).toBeTruthy();
  });

  it('stays silent while editing is available and idle', () => {
    const { container } = render(
      <PersonalContext.Provider value={value()}>
        <PersonalNotice />
      </PersonalContext.Provider>,
    );
    expect(container.textContent).toBe('');
  });

  it('shows the saving state', () => {
    render(
      <PersonalContext.Provider value={value({ saving: true })}>
        <PersonalNotice />
      </PersonalContext.Provider>,
    );
    expect(screen.getByRole('status').textContent).toContain('儲存中');
  });

  it('shows the error as an alert that can be dismissed', () => {
    const clearError = vi.fn();
    render(
      <PersonalContext.Provider value={value({ error: '儲存失敗：網路中斷', clearError })}>
        <PersonalNotice />
      </PersonalContext.Provider>,
    );
    expect(screen.getByRole('alert').textContent).toContain('儲存失敗：網路中斷');
    fireEvent.click(screen.getByRole('button', { name: '關閉錯誤訊息' }));
    expect(clearError).toHaveBeenCalledTimes(1);
  });
});
