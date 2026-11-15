import { useEffect, useState, type ReactNode } from 'react';
import { updateTheme } from './api';
import { ThemeContext, type ThemeMode } from './useTheme';

function applyTheme(mode: ThemeMode) {
  const root = document.documentElement;
  if (mode === 'dark') {
    root.classList.add('dark');
  } else if (mode === 'light') {
    root.classList.remove('dark');
  } else {
    // system
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }
}

interface ThemeProviderProps {
  children: ReactNode;
  initialTheme?: ThemeMode;
}

export function ThemeProvider({ children, initialTheme = 'system' }: ThemeProviderProps) {
  const [theme, setThemeState] = useState<ThemeMode>(initialTheme);
  const [prevInitialTheme, setPrevInitialTheme] = useState(initialTheme);

  // Sync theme when initialTheme changes (e.g. after user profile loads).
  // State is adjusted during render instead of in an effect:
  // https://react.dev/learn/you-might-not-need-an-effect
  if (initialTheme !== prevInitialTheme) {
    setPrevInitialTheme(initialTheme);
    setThemeState(initialTheme);
  }

  useEffect(() => {
    applyTheme(theme);

    if (theme !== 'system') return;

    // Listen for OS dark mode changes when in system mode
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => applyTheme('system');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [theme]);

  async function setTheme(mode: ThemeMode) {
    setThemeState(mode);
    await updateTheme(mode);
  }

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>
      {children}
    </ThemeContext.Provider>
  );
}
