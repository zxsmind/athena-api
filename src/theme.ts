import { createTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { useMemo } from 'react';

function useDetectMode(): 'light' | 'dark' {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)');
  const classDark = typeof document !== 'undefined'
    ? document.documentElement.classList.contains('dark')
    : false;
  return classDark ? 'dark' : (prefersDark ? 'dark' : 'light');
}

export function useTheme() {
  const mode = useDetectMode();

  return useMemo(() => createTheme({
    palette: {
      mode,
      primary: { main: '#0a0a12' },
      secondary: { main: '#4a6fa5' },
      background: {
        default: mode === 'dark' ? '#0a0a12' : '#f0f0f4',
        paper: mode === 'dark' ? 'rgba(20,20,30,0.52)' : 'rgba(255,255,255,0.52)',
      },
    },
    typography: {
      fontFamily: "'Manrope', ui-sans-serif, system-ui, -apple-system, sans-serif",
      h1: { fontFamily: "'Outfit', sans-serif", fontWeight: 300, letterSpacing: '-0.03em' },
      h2: { fontFamily: "'Outfit', sans-serif", fontWeight: 400, letterSpacing: '-0.02em' },
    },
    shape: { borderRadius: 16 },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: {
            backgroundColor: 'var(--athena-bg)',
            color: 'var(--athena-text)',
            transition: 'background-color 500ms, color 400ms',
          },
        },
      },
    },
  }), [mode]);
}

export default useTheme;
