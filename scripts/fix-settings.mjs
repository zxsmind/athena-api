import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = resolve(__dirname, '..', 'server', 'data', 'settings.json');
const backupPath = resolve(__dirname, '..', 'server', 'data', 'settings.json.backup');

if (!existsSync(settingsPath)) {
  console.error(`Settings file not found: ${settingsPath}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(settingsPath, 'utf-8'));
let changed = false;

// Remove gemini-3-flash from any provider model list (it returns 404)
for (const [pid, provider] of Object.entries(raw.providers || {})) {
  const p = provider;
  if (Array.isArray(p.models)) {
    const before = p.models.length;
    p.models = p.models.filter((m) => m !== 'gemini-3-flash');
    if (p.models.length !== before) {
      console.log(`Removed gemini-3-flash from ${pid} models`);
      changed = true;
    }
  }
}

if (changed) {
  copyFileSync(settingsPath, backupPath);
  writeFileSync(settingsPath, JSON.stringify(raw, null, 2), 'utf-8');
  console.log(`Backup saved to: ${backupPath}`);
  console.log(`Updated settings saved to: ${settingsPath}`);
} else {
  console.log('No changes needed.');
}
