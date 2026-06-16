import { useState, useEffect, useCallback } from 'react';

type SearchMode = 'quick' | 'deep';

const STORAGE_KEY = 'athena-default-mode';

export function useDefaultMode(): [SearchMode, (mode: SearchMode) => void] {
  const [mode, setMode] = useState<SearchMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'deep' ? 'deep' : 'quick';
  });

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, mode);
  }, [mode]);

  const set = useCallback((m: SearchMode) => {
    setMode(m);
  }, []);

  return [mode, set];
}

export function getDefaultMode(): SearchMode {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'deep' ? 'deep' : 'quick';
}
