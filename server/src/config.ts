import 'dotenv/config';
import { loadSettings, getEnabledProviders } from './settings-store.js';

export function getPublicConfig() {
  const store = loadSettings();
  return {
    keyCount: store.providers.groq.keys.length,
    serperKeyCount: store.serper.keys.length,
    providerCount: getEnabledProviders().length,
  };
}

export const config = {
  groqUrl: 'https://api.groq.com/openai/v1/chat/completions',
  serperUrl: 'https://google.serper.dev/search',
};

let _port = 3001;
let _host = '0.0.0.0';

export function initPort() {
  const store = loadSettings();
  _port = parseInt(process.env.PORT || '', 10) || store.port || 3001;
  // Always bind to all interfaces so the backend is reachable on the local network / Tailscale.
  _host = '0.0.0.0';
}

export function getPort(): number {
  return _port;
}

export function getHost(): string {
  return _host;
}

initPort();
