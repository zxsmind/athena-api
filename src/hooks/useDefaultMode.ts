import { useState, useEffect, useCallback } from 'react';
import type { DeepDepth } from '../lib/api';

type SearchMode = 'quick' | 'deep';

const MODE_STORAGE_KEY = 'athena-default-mode';
const DEPTH_STORAGE_KEY = 'athena-default-depth';
const DEPTH_VALUES: DeepDepth[] = ['low', 'med', 'high', 'ultra'];

function readStoredMode(): SearchMode {
  const saved = localStorage.getItem(MODE_STORAGE_KEY);
  return saved === 'deep' ? 'deep' : 'quick';
}

export function getDefaultMode(): SearchMode {
  return readStoredMode();
}

export function getDefaultDepth(): DeepDepth {
  const saved = localStorage.getItem(DEPTH_STORAGE_KEY);
  return DEPTH_VALUES.includes(saved as DeepDepth) ? saved as DeepDepth : 'med';
}

export function setDefaultMode(mode: SearchMode): void {
  localStorage.setItem(MODE_STORAGE_KEY, mode);
}

export function setDefaultDepth(depth: DeepDepth): void {
  localStorage.setItem(DEPTH_STORAGE_KEY, depth);
}

export function useDefaultMode(): [SearchMode, (mode: SearchMode) => void, DeepDepth, (depth: DeepDepth) => void] {
  const [mode, setMode] = useState<SearchMode>(readStoredMode);
  const [depth, setDepth] = useState<DeepDepth>(getDefaultDepth);

  useEffect(() => {
    localStorage.setItem(MODE_STORAGE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem(DEPTH_STORAGE_KEY, depth);
  }, [depth]);

  const setModePersisted = useCallback((m: SearchMode) => {
    setMode(m);
  }, []);

  const setDepthPersisted = useCallback((d: DeepDepth) => {
    setDepth(d);
  }, []);

  return [mode, setModePersisted, depth, setDepthPersisted];
}
