'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { ThemeName } from '@/lib/theme';

export const THEME_STORAGE_KEY = 'gpu-monitoring-theme';

const ThemeContext = createContext<{ theme: ThemeName; setTheme: (t: ThemeName) => void }>({
  theme: 'dark', setTheme: () => {},
});

/** The current theme, and a setter that persists it.
 *
 *  Panels that paint to the DOM or to SVG do not need this — they use `var(--…)` tokens
 *  and the browser repaints them. Only a canvas panel does, because Chart.js resolves
 *  colours once when it builds; such a panel puts `theme` in its effect deps so a switch
 *  re-resolves them. */
export function useTheme() {
  return useContext(ThemeContext);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // Starts at the value the boot script already wrote to <html>, so the first client
  // render agrees with what is on screen instead of flipping it.
  const [theme, setThemeState] = useState<ThemeName>('dark');

  useEffect(() => {
    const applied = document.documentElement.getAttribute('data-theme');
    if (applied === 'light' || applied === 'dark') setThemeState(applied);
  }, []);

  const setTheme = useCallback((next: ThemeName) => {
    setThemeState(next);
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Private-mode or storage-disabled: the theme still applies for this page, it
      // just will not be remembered. Not worth surfacing.
    }
  }, []);

  return (
    <ThemeContext.Provider value={{ theme, setTheme }}>{children}</ThemeContext.Provider>
  );
}

/** Runs before first paint, so a light-mode reader never sees a dark flash and back.
 *  Inlined in <head> as a plain string: a React effect would run after the first paint,
 *  which is exactly the flash this avoids. */
export const THEME_BOOT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem('${THEME_STORAGE_KEY}');
    var theme = stored === 'light' || stored === 'dark' ? stored
      : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light' : 'dark');
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
})();
`;
