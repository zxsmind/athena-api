/** Browser-side credentials. The API key is a dev aid kept per origin; the
 *  admin key lives in sessionStorage so closing the tab ends the session. */

const API_KEY_STORAGE = 'athena.apiKey';
const ADMIN_KEY_STORAGE = 'athena.adminKey';

export function getApiKey(): string {
  try {
    return localStorage.getItem(API_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setApiKey(value: string): void {
  try {
    if (value) localStorage.setItem(API_KEY_STORAGE, value);
    else localStorage.removeItem(API_KEY_STORAGE);
  } catch {
    /* private mode: the key simply does not persist */
  }
}

export function getAdminKey(): string {
  try {
    return sessionStorage.getItem(ADMIN_KEY_STORAGE) ?? '';
  } catch {
    return '';
  }
}

export function setAdminKey(value: string): void {
  try {
    if (value) sessionStorage.setItem(ADMIN_KEY_STORAGE, value);
    else sessionStorage.removeItem(ADMIN_KEY_STORAGE);
  } catch {
    /* private mode: the key simply does not persist */
  }
}

export function maskedKey(key: string): string {
  if (key.length <= 12) return key ? '••••' : '';
  return `${key.slice(0, 10)}${'•'.repeat(8)}`;
}
