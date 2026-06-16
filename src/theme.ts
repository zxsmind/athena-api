import { createTheme } from '@mui/material/styles';

function getMode(): 'light' | 'dark' {
  if (typeof document !== 'undefined') {
    return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
  }
  return 'light';
}

const theme = createTheme({
  palette: {
    mode: getMode(),
    primary: { main: '#0a0a12' },
    secondary: { main: '#4a6fa5' },
    background: { default: '#f0f0f4', paper: 'rgba(255,255,255,0.52)' },
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
});

export default theme;
