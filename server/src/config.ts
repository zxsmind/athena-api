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
export function initPort() {
  const store = loadSettings();
  _port = parseInt(process.env.PORT || '', 10) || store.port || 3001;
}

export function getPort(): number {
  return _port;
}

initPort();
