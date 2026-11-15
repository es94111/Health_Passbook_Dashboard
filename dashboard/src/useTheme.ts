import { createContext, useContext } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

interface ThemeContextValue {
  theme: ThemeMode;
  setTheme: (mode: ThemeMode) => Promise<void>;
}

export const ThemeContext = createContext<ThemeContextValue>({
  theme: 'system',
  setTheme: async () => {},
});

export function useTheme() {
  return useContext(ThemeContext);
}
