import React, { createContext, useContext, useEffect, useState } from 'react';

type Mode = 'light' | 'dark';

interface ColorModeContextType {
  mode: Mode;
  toggle: () => void;
  setMode: (m: Mode) => void;
}

const ColorModeContext = createContext<ColorModeContextType>({
  mode: 'light',
  toggle: () => {},
  setMode: () => {},
});

export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<Mode>(() => {
    const saved = localStorage.getItem('athena-color-mode');
    if (saved === 'light' || saved === 'dark') return saved;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    const root = document.documentElement;
    if (mode === 'dark') {
      root.classList.add('dark');
      root.classList.remove('light');
    } else {
      root.classList.add('light');
      root.classList.remove('dark');
    }
    localStorage.setItem('athena-color-mode', mode);
  }, [mode]);

  const toggle = () => setModeState(m => m === 'light' ? 'dark' : 'light');
  const setMode = (m: Mode) => setModeState(m);

  return (
    <ColorModeContext.Provider value={{ mode, toggle, setMode }}>
      {children}
    </ColorModeContext.Provider>
  );
}

export function useColorMode() {
  return useContext(ColorModeContext);
}
