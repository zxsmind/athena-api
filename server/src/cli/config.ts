import { confirm, input, password, search, select } from '@inquirer/prompts';
import { checkbox } from '@inquirer/prompts';
import { getModelsDevSnapshot } from '../models-dev.js';
import { listSupportedPackages } from '../provider-registry.js';
import { normalizeKeyName } from '../api-platform-store.js';
import type { SettingsStore } from '../settings-store.js';
import { getDataPath } from '../storage.js';
import { rankProviders, SEARCH_BACKEND_CHOICES, parseList } from './setup.js';
import * as edit from './config-edit.js';
import * as ui from './ui.js';

/** Last four characters of a key, which is enough to tell keys apart. */
export function maskKey(key: string): string {
  return `…${key.slice(-4)}`;
}

interface CatalogEntry {
  id: string;
  name: string;
  modelCount: number;
}

async function loadCatalog(): Promise<CatalogEntry[]> {
  try {
    const snapshot = await getModelsDevSnapshot();
    return Object.values(snapshot.providers)
      .map((provider) => ({ id: provider.id, name: provider.name ?? provider.id, modelCount: Object.keys(provider.models ?? {}).length }))
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch {
    return [];
  }
}

/**
 * Points each research mode at a model.
 *
 * This exists because the setting was writable and unreadable in practice: the
 * routes were keyed by stage (`title`, `reasoning`) rather than by mode, two of
 * the four modes had no key at all, and the engine looked up `deep`
 * unconditionally. Configuring a route therefore had no observable effect on the
 * mode it named. Each mode now reads its own route, and the context-window
 * resolution that depends on it falls back to the only configured provider when
 * a mode is left unset.
 */
async function manageRouting(settings: SettingsStore): Promise<void> {
  const modes = ['instant', 'default', 'deep', 'max'] as const;

  for (;;) {
    ui.section('Model routing');
    ui.line(ui.color.dim('  Which model serves each research mode. Left unset, the router picks from the providers you enabled.'));
    ui.table(
      ['MODE', 'PRIMARY', 'FALLBACKS'],
      modes.map((mode) => {
        const route = settings.modelRouting[mode];
        const primary = route.primary.model ? `${route.primary.providerId}/${route.primary.model}` : ui.color.dim('router picks');
        return [mode, primary, route.fallback.length > 0 ? String(route.fallback.length) : ui.color.dim('-')];
      }),
    );

    const action = await select({
      message: 'Routing',
      choices: [
        { value: 'set', name: 'Choose the model for a mode' },
        { value: 'clear', name: 'Clear a mode, letting the router choose' },
        { value: 'done', name: 'Done' },
      ],
    });
    if (action === 'done') return;

    const mode = await select({ message: 'Which mode?', choices: modes.map((m) => ({ value: m })) });

    if (action === 'clear') {
      edit.setModelRoute(settings, mode, { primary: { providerId: '', model: '' }, fallback: [] });
      ui.success(`${mode} will use the router's choice.`);
      continue;
    }

    /* Offered models come from the providers already set up, not from the whole
       catalog: a route naming a provider with no key would fail at call time,
       and the catalog has 225 providers to choose from at this point. */
    const choices = Object.entries(settings.providers)
      .filter(([, provider]) => provider.enabled && provider.models.length > 0)
      .flatMap(([providerId, provider]) =>
        provider.models.map((model) => ({ value: { providerId, model }, name: `${providerId}/${model}` })),
      );
    if (choices.length === 0) {
      ui.warn('No enabled provider has a model configured. Add one under LLM providers first.');
      continue;
    }
    const chosen = await select<{ providerId: string; model: string }>({ message: `${mode}: which model?`, choices });
    edit.setModelRoute(settings, mode, { primary: chosen, fallback: [] });
    ui.success(`${mode} -> ${chosen.providerId}/${chosen.model}.`);
  }
}

function printProviders(settings: SettingsStore): void {
  const rows = edit.summarizeProviders(settings);
  if (rows.length === 0) {
    ui.line(ui.color.dim('  no LLM providers yet'));
    return;
  }
  ui.table(
    ['PROVIDER', 'STATE', 'KEYS', 'MODELS', 'NOTE'],
    rows.map((row) => [
      row.id,
      row.ready ? ui.color.green('ready') : row.enabled ? ui.color.yellow('no key') : ui.color.dim('disabled'),
      row.keyCount === 0 ? '0' : row.keyCount === 1 ? `1 (${maskKey(settings.providers[row.id].keys[0])})` : String(row.keyCount),
      row.modelCount === 0 ? 'all catalog' : String(row.modelCount),
      row.custom ? 'custom endpoint' : '',
    ]),
  );
}

function printSearches(settings: SettingsStore): void {
  const order = edit.searchOrder(settings);
  if (order.length === 0) {
    ui.line(ui.color.dim('  no search backends yet'));
    return;
  }
  ui.table(
    ['#', 'BACKEND', 'KEYS', 'ZONE', 'ENDPOINT'],
    order.map((id, index) => {
      const state = settings.searchProviders[id];
      return [
        String(index + 1),
        id,
        state.keys.length === 0 ? ui.color.red('0') : String(state.keys.length),
        state.zone ?? '',
        state.url ? 'custom' : 'default',
      ];
    }),
  );
}

async function pickProvider(settings: SettingsStore, catalog: CatalogEntry[]): Promise<string | 'new'> {
  const existing = edit.summarizeProviders(settings).map((row) => row.id);
  const useCustom = await select({
    message: 'Add or change which provider?',
    choices: [
      ...existing.map((id) => ({ value: id, name: `${id}${settings.providers[id].enabled && settings.providers[id].keys.length > 0 ? '' : ' (needs a key)'}` })),
      { value: '__new__', name: '＋ Add a new provider' },
    ],
  });
  if (useCustom === '__new__') return 'new';

  if (catalog.length === 0) {
    const id = await input({
      message: 'Provider id',
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? true : 'Use letters, digits, or dashes.'),
    });
    return id.trim();
  }
  return search({
    message: 'Provider (type to search)',
    pageSize: 12,
    source: async (term) => rankProviders(catalog, term ?? '').map((entry) => ({
      value: entry.id,
      name: `${entry.name}  (${entry.id}, ${entry.modelCount} models)${existing.includes(entry.id) ? ' — already added' : ''}`,
    })),
  });
}

async function addProvider(settings: SettingsStore, catalog: CatalogEntry[]): Promise<void> {
  const choice = await pickProvider(settings, catalog);
  if (choice === 'new') {
    const id = await input({
      message: 'Provider id (letters, digits, dashes)',
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? true : 'Use letters, digits, or dashes.'),
    });
    const npm = await select({ message: `Runtime package for ${id}`, choices: listSupportedPackages().map((name) => ({ value: name })) });
    const url = await input({ message: 'Endpoint base URL', validate: (value) => (value.trim() ? true : 'A custom endpoint needs its URL.') });
    const models = parseList(await input({ message: 'Model ids, comma separated' }));
    edit.upsertProvider(settings, id.trim(), { npm, url: url.trim(), models, keys: [], enabled: true });
    ui.success(`Provider ${id} added. Add its API key next.`);
    await manageProviderKeys(settings, id.trim());
    return;
  }
  edit.upsertProvider(settings, choice, {});
  ui.success(`Provider ${choice} added.`);
  await manageProviderKeys(settings, choice);
}

async function manageProviderKeys(settings: SettingsStore, id: string): Promise<void> {
  for (;;) {
    const provider = settings.providers[id];
    ui.section(`API keys — ${id}`);
    if (provider.keys.length === 0) ui.line(ui.color.dim('  none yet'));
    else ui.table(['#', 'KEY'], provider.keys.map((key, index) => [String(index + 1), maskKey(key)]));
    const action = await select({
      message: `${id}: what do you want to do?`,
      choices: [
        { value: 'add', name: 'Add an API key' },
        ...(provider.keys.length > 0 ? [{ value: 'remove', name: 'Remove an API key' }] : []),
        { value: 'done', name: 'Done' },
      ],
    });
    if (action === 'done') return;
    if (action === 'add') {
      const key = await password({ message: `Paste the API key for ${id}`, mask: true });
      if (!key.trim()) {
        ui.warn('Empty key ignored.');
        continue;
      }
      if (edit.addProviderKey(settings, id, key)) ui.success(`Added ${maskKey(key.trim())}.`);
      else ui.warn('That exact key is already stored for this provider.');
      continue;
    }
    const index = await select({
      message: `${id}: which key to remove?`,
      choices: provider.keys.map((key, position) => ({ value: String(position), name: `${position + 1}. ${maskKey(key)}` })),
    });
    const removed = provider.keys.splice(Number(index), 1)[0];
    ui.success(`Removed ${maskKey(removed)}.`);
  }
}

/**
 * Records what a provider charges for a model, in US dollars per million tokens.
 *
 * The models.dev catalog has no entry for a self-hosted or newly released
 * model, and `cli stats` reported those as unpriced rather than inventing a
 * number. This is where the operator supplies it. Leaving a field blank bills
 * that stream at zero, so only write what the provider actually charges.
 */
async function manageModelPrices(settings: SettingsStore, id: string): Promise<void> {
  const provider = settings.providers[id];
  const models = provider.models.length > 0 ? provider.models : await catalogModelIds(id);
  if (models.length === 0) {
    ui.warn(`No models known for ${id}. Set the model list first, then price them.`);
    return;
  }
  for (;;) {
    ui.section(`Prices — ${id}`);
    ui.line(ui.color.dim('  US dollars per million tokens. Blank omits that field; a model with no fields reads as unpriced.'));
    const rows = models.map((model) => {
      const price = provider.modelPrices?.[model];
      return [
        model,
        price?.input === undefined ? '-' : String(price.input),
        price?.output === undefined ? '-' : String(price.output),
        price?.cacheRead === undefined ? '-' : String(price.cacheRead),
      ];
    });
    ui.table(['MODEL', 'INPUT', 'OUTPUT', 'CACHE READ'], rows);

    const action = await select({
      message: `${id}: prices`,
      choices: [
        { value: 'set', name: 'Enter or change a price' },
        { value: 'clear', name: 'Remove a price' },
        { value: 'done', name: 'Done' },
      ],
    });
    if (action === 'done') return;
    if (action === 'clear') {
      const target = await select({ message: 'Which model?', choices: models.map((model) => ({ value: model })) });
      if (provider.modelPrices) delete provider.modelPrices[target];
      edit.upsertProvider(settings, id, { modelPrices: provider.modelPrices ?? {} });
      ui.success(`${target} is unpriced again.`);
      continue;
    }
    const target = await select({ message: 'Which model?', choices: models.map((model) => ({ value: model })) });
    const current = provider.modelPrices?.[target] ?? {};
    const read = async (label: string, previous?: number): Promise<number | undefined> => {
      const answer = await input({
        message: `${label} price per 1M tokens (blank to omit)`,
        default: previous === undefined ? '' : String(previous),
        validate: (value) => (value.trim() === '' || (/^\d+(\.\d+)?$/.test(value.trim()) ? true : 'Enter a number, or leave blank to omit this field.')),
      });
      const trimmed = answer.trim();
      /* Blank means "not supplied", which is kept as an absent field rather than
         a zero. A zero would report a stream as free, and free is a claim about
         the provider that this operator cannot make on their behalf. */
      return trimmed === '' ? undefined : Number(trimmed);
    };
    const inputPrice = await read('Input', current.input);
    const outputPrice = await read('Output', current.output);
    const cacheReadPrice = await read('Cache read', current.cacheRead);
    const price: Record<string, number> = {};
    if (inputPrice !== undefined) price.input = inputPrice;
    if (outputPrice !== undefined) price.output = outputPrice;
    if (cacheReadPrice !== undefined) price.cacheRead = cacheReadPrice;
    const nextPrices = { ...(provider.modelPrices ?? {}) };
    /* An empty entry is removed rather than stored as all-zeros, so the model
       reads as unpriced instead of free. */
    if (Object.keys(price).length === 0) delete nextPrices[target];
    else nextPrices[target] = price;
    edit.upsertProvider(settings, id, { modelPrices: nextPrices });
    ui.success(`${target} priced. \`cli stats\` will report it.`);
  }
}

async function catalogModelIds(id: string): Promise<string[]> {
  const snapshot = await getModelsDevSnapshot();
  return Object.keys(snapshot.providers[id]?.models ?? {}).sort();
}

async function manageModels(settings: SettingsStore, id: string): Promise<void> {
  const provider = settings.providers[id];
  ui.section(`Models — ${id}`);
  if (provider.models.length === 0) {
    ui.info('No model list set, so every model in the catalog is offered to the router.');
  } else {
    ui.table(['#', 'MODEL'], provider.models.map((model, index) => [String(index + 1), model]));
  }
  const action = await select({
    message: `${id}: models`,
    choices: [
      { value: 'all', name: 'Use every catalog model' },
      { value: 'pick', name: 'Choose specific models' },
      { value: 'text', name: 'Type model ids' },
      { value: 'price', name: 'Set a price per model (for what `cli stats` reports)' },
      ...(provider.models.length > 0 ? [{ value: 'add', name: 'Add models' }, { value: 'remove', name: 'Remove a model' }] : []),
      { value: 'done', name: 'Done' },
    ],
  });
  if (action === 'done') return;
  if (action === 'price') {
    await manageModelPrices(settings, id);
    return;
  }
  if (action === 'all') {
    edit.setProviderModels(settings, id, []);
    ui.success(`${id} will serve every catalog model.`);
    return;
  }
  if (action === 'text') {
    const raw = await input({ message: 'Model ids, comma separated', default: provider.models.join(', ') });
    edit.setProviderModels(settings, id, parseList(raw));
    ui.success(`${id}: model list updated.`);
    return;
  }
  if (action === 'add' || action === 'remove') {
    const snapshot = await getModelsDevSnapshot();
    const all = Object.keys(snapshot.providers[id]?.models ?? {}).sort();
    if (all.length === 0) {
      ui.warn(`The catalog has no models for ${id}; use "Type model ids".`);
      return;
    }
    const picked = await checkbox({
      message: action === 'add' ? `Add models to ${id}` : `Remove models from ${id}`,
      pageSize: 12,
      choices: all.map((model) => ({ value: model, name: model, checked: action === 'remove' ? provider.models.includes(model) : false })),
    });
    const next = action === 'add'
      ? [...new Set([...provider.models, ...picked])]
      : provider.models.filter((model) => !picked.includes(model));
    edit.setProviderModels(settings, id, next);
    ui.success(`${id}: ${next.length === 0 ? 'every catalog model' : `${next.length} model(s)`}.`);
    return;
  }
  const snapshot = await getModelsDevSnapshot();
  const all = Object.keys(snapshot.providers[id]?.models ?? {}).sort();
  if (all.length === 0) {
    ui.warn(`The catalog has no models for ${id}; use "Type model ids".`);
    return;
  }
  const picked = await checkbox({
    message: `Models ${id} will serve (space to toggle)`,
    pageSize: 12,
    choices: all.map((model) => ({ value: model, name: model, checked: provider.models.includes(model) })),
  });
  edit.setProviderModels(settings, id, picked);
  ui.success(`${id}: ${picked.length === 0 ? 'every catalog model' : `${picked.length} model(s)`}.`);
}

async function manageProvider(settings: SettingsStore, id: string): Promise<void> {
  const provider = settings.providers[id];
  ui.section(`Provider — ${id}`);
  ui.kv('Enabled', String(provider.enabled));
  ui.kv('API keys', String(provider.keys.length));
  ui.kv('Models', provider.models.length === 0 ? 'all catalog models' : `${provider.models.length} selected`);
  ui.kv('Endpoint', provider.url ?? 'catalog default');
  ui.kv('Package', provider.npm ?? 'catalog default');
  const action = await select({
    message: `${id}:`,
    choices: [
      { value: 'keys', name: 'Add or remove API keys' },
      { value: 'models', name: 'Choose models' },
      { value: 'enable', name: provider.enabled ? 'Disable this provider' : 'Enable this provider' },
      { value: 'url', name: 'Change the endpoint URL' },
      { value: 'rename', name: 'Change the provider id' },
      { value: 'remove', name: 'Remove this provider' },
      { value: 'done', name: 'Done' },
    ],
  });
  if (action === 'done') return;
  if (action === 'keys') await manageProviderKeys(settings, id);
  if (action === 'models') await manageModels(settings, id);
  if (action === 'enable') {
    provider.enabled = !provider.enabled;
    ui.success(`${id} is now ${provider.enabled ? 'enabled' : 'disabled'}.`);
  }
  if (action === 'url') {
    const url = await input({ message: `Endpoint base URL for ${id} (empty = catalog default)`, default: provider.url ?? '' });
    if (url.trim()) provider.url = url.trim();
    else delete provider.url;
    ui.success(`${id}: endpoint updated.`);
  }
  if (action === 'rename') {
    const next = await input({
      message: `New id for ${id}`,
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) && value.trim() !== id ? true : 'Use letters, digits, or dashes, and change something.'),
    });
    const trimmed = next.trim();
    if (trimmed in settings.providers) {
      ui.warn(`${trimmed} already exists.`);
      return;
    }
    settings.providers[trimmed] = provider;
    delete settings.providers[id];
    settings.providerOrder = settings.providerOrder.map((entry) => (entry === id ? trimmed : entry));
    ui.success(`Renamed ${id} to ${trimmed}.`);
  }
  if (action === 'remove') {
    const sure = await confirm({ message: `Remove ${id} and its ${provider.keys.length} key(s)?`, default: false });
    if (sure) {
      edit.removeProvider(settings, id);
      ui.success(`${id} removed.`);
    }
  }
}

async function manageSearchKeys(settings: SettingsStore, id: string): Promise<void> {
  const backend = settings.searchProviders[id];
  for (;;) {
    ui.section(`API keys — ${id}`);
    if (backend.keys.length === 0) ui.line(ui.color.dim('  none yet'));
    else ui.table(['#', 'KEY'], backend.keys.map((key, index) => [String(index + 1), maskKey(key)]));
    const action = await select({
      message: `${id}: what do you want to do?`,
      choices: [
        { value: 'add', name: 'Add an API key' },
        ...(backend.keys.length > 0 ? [{ value: 'remove', name: 'Remove an API key' }] : []),
        { value: 'zone', name: 'Change the SERP zone' },
        { value: 'url', name: 'Change the endpoint URL' },
        { value: 'done', name: 'Done' },
      ],
    });
    if (action === 'done') return;
    if (action === 'add') {
      const key = await password({ message: `Paste the API key for ${id}`, mask: true });
      if (!key.trim()) {
        ui.warn('Empty key ignored.');
        continue;
      }
      if (edit.addSearchKey(settings, id, key)) ui.success(`Added ${maskKey(key.trim())}.`);
      else ui.warn('That exact key is already stored for this backend.');
      continue;
    }
    if (action === 'remove') {
      const index = await select({
        message: `${id}: which key to remove?`,
        choices: backend.keys.map((key, position) => ({ value: String(position), name: `${position + 1}. ${maskKey(key)}` })),
      });
      const removed = backend.keys.splice(Number(index), 1)[0];
      ui.success(`Removed ${maskKey(removed)}.`);
      continue;
    }
    if (action === 'zone') {
      const zone = await input({ message: `SERP zone name for ${id} (empty to clear)`, default: backend.zone ?? '' });
      if (zone.trim()) backend.zone = zone.trim();
      else delete backend.zone;
      ui.success(`${id}: zone updated.`);
      continue;
    }
    const url = await input({ message: `Endpoint base URL for ${id} (empty = default)`, default: backend.url ?? '' });
    if (url.trim()) backend.url = url.trim();
    else delete backend.url;
    ui.success(`${id}: endpoint updated.`);
  }
}

async function manageSearch(settings: SettingsStore, id: string): Promise<void> {
  const backend = settings.searchProviders[id];
  ui.section(`Search backend — ${id}`);
  ui.kv('API keys', String(backend.keys.length));
  ui.kv('Zone', backend.zone ?? ui.color.dim('none'));
  ui.kv('Endpoint', backend.url ?? 'default');
  const action = await select({
    message: `${id}:`,
    choices: [
      { value: 'keys', name: 'Add or remove API keys' },
      { value: 'rename', name: 'Change the backend id' },
      { value: 'remove', name: 'Remove this backend' },
      { value: 'done', name: 'Done' },
    ],
  });
  if (action === 'done') return;
  if (action === 'keys') await manageSearchKeys(settings, id);
  if (action === 'rename') {
    const next = await input({
      message: `New id for ${id}`,
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) && value.trim() !== id ? true : 'Use letters, digits, or dashes, and change something.'),
    });
    const trimmed = next.trim();
    if (trimmed in settings.searchProviders) {
      ui.warn(`${trimmed} already exists.`);
      return;
    }
    settings.searchProviders[trimmed] = backend;
    delete settings.searchProviders[id];
    edit.setSearchOrder(settings, edit.searchOrder(settings).map((entry) => (entry === id ? trimmed : entry)));
    ui.success(`Renamed ${id} to ${trimmed}.`);
  }
  if (action === 'remove') {
    const sure = await confirm({ message: `Remove ${id}?`, default: false });
    if (sure) {
      edit.removeSearch(settings, id);
      ui.success(`${id} removed.`);
    }
  }
}

async function manageSearchList(settings: SettingsStore): Promise<void> {
  const catalog = SEARCH_BACKEND_CHOICES.map((backend) => backend.id);
  const missing = catalog.filter((id) => !(id in settings.searchProviders));
  ui.section('Search backends');
  printSearches(settings);
  const action = await select({
    message: 'Search backends',
    choices: [
      ...edit.searchOrder(settings).map((id) => ({ value: `manage:${id}`, name: `Change ${id}` })),
      ...(missing.length > 0 ? [{ value: 'add', name: `＋ Add a backend (${missing.length} available)` }] : []),
      { value: 'order', name: 'Change the order they are tried in' },
      { value: 'done', name: 'Done' },
    ],
  });
  if (action === 'done') return;
  if (action === 'add') {
    const picked = await checkbox({
      message: 'Which backends do you want to add? (space to toggle)',
      pageSize: 14,
      choices: missing.map((id) => ({ value: id, name: SEARCH_BACKEND_CHOICES.find((b) => b.id === id)?.label ?? id })),
    });
    for (const id of picked) {
      const entry = edit.upsertSearch(settings, id, { keys: [] });
      if (SEARCH_BACKEND_CHOICES.find((b) => b.id === id)?.needsZone) {
        const zone = await input({ message: `${id}: SERP zone name (required)`, validate: (value) => (value.trim() ? true : 'This backend needs a zone.') });
        entry.zone = zone.trim();
      }
      ui.success(`${id} added. Add its API key next.`);
      await manageSearchKeys(settings, id);
    }
    return;
  }
  if (action === 'order') {
    const current = edit.searchOrder(settings);
    const picked = await checkbox({
      message: 'Top of the list is tried first (toggle to reorder, enter to keep)',
      pageSize: 14,
      choices: current.map((id) => ({ value: id, name: id, checked: true })),
    });
    /* Keep the unticked ones after the ticked ones so a backend is never lost. */
    const rest = current.filter((id) => !picked.includes(id));
    edit.setSearchOrder(settings, [...picked, ...rest]);
    ui.success('Search order updated.');
    return;
  }
  await manageSearch(settings, action.replace(/^manage:/, ''));
}

async function manageServer(settings: SettingsStore): Promise<void> {
  ui.section('Server');
  ui.kv('Bind address', settings.host);
  ui.kv('Port', String(settings.port));
  const action = await select({
    message: 'Server settings',
    choices: [
      { value: 'port', name: 'Change the port' },
      { value: 'host', name: 'Change the bind address' },
      { value: 'done', name: 'Done' },
    ],
  });
  if (action === 'done') return;
  if (action === 'port') {
    const port = await input({ message: 'HTTP port', default: String(settings.port), validate: (value) => (/^\d{1,5}$/.test(value.trim()) && Number(value) > 0 && Number(value) < 65536 ? true : 'Enter a port between 1 and 65535.') });
    settings.port = Number(port.trim());
    ui.success(`Port set to ${settings.port}.`);
    return;
  }
  const host = await input({ message: 'Bind address (0.0.0.0 to accept connections from any interface)', default: settings.host });
  settings.host = host.trim() || settings.host;
  ui.success(`Bind address set to ${settings.host}.`);
}

function printStatus(settings: SettingsStore): void {
  const report = edit.readiness(settings);
  ui.section('Current configuration');
  ui.kv('Settings file', getDataPath('settings.yaml'));
  ui.kv('Bind', `${settings.host}:${settings.port}`);
  ui.line();
  ui.line(ui.color.dim('  LLM providers'));
  printProviders(settings);
  ui.line();
  ui.line(ui.color.dim('  Search backends'));
  printSearches(settings);
  ui.line();
  if (report.ready) ui.success('Ready: the server will start.');
  else {
    ui.warn('Not ready yet:');
    for (const problem of report.problems) ui.line(ui.color.red(`    ${problem}`));
    for (const hint of report.hints) ui.line(ui.color.dim(`    ${hint}`));
  }
  ui.line();
}

/**
 * The repeatable configuration command. Every change is written to disk as it
 * is made, so the server can be restarted at any point with the new settings.
 */
export async function runConfig(): Promise<void> {
  const settings = edit.readSettings();
  let catalog: CatalogEntry[] | null = null;
  const ensureCatalog = async (): Promise<CatalogEntry[]> => {
    if (catalog === null) catalog = await ui.step('Loading model catalog', () => loadCatalog());
    if (catalog.length === 0) ui.warn('Catalog unavailable; only custom endpoints can be configured.');
    return catalog;
  };

  for (;;) {
    printStatus(settings);
    const action = await select({
      message: 'What do you want to change?',
      choices: [
        { value: 'llm', name: 'LLM providers' },
        { value: 'routing', name: 'Which model serves each research mode' },
        { value: 'search', name: 'Search backends' },
        { value: 'server', name: 'Server address and port' },
        { value: 'save', name: 'Save and exit' },
      ],
    });
    if (action === 'save') break;

    if (action === 'routing') {
      await manageRouting(settings);
      continue;
    }

    if (action === 'llm') {
      for (;;) {
        ui.section('LLM providers');
        printProviders(settings);
        const choice = await select({
          message: 'LLM providers',
          choices: [
            ...edit.summarizeProviders(settings).map((row) => ({ value: `manage:${row.id}`, name: `Change ${row.id}` })),
            { value: 'add', name: '＋ Add a provider' },
            { value: 'done', name: 'Done' },
          ],
        });
        if (choice === 'done') break;
        if (choice === 'add') {
          await addProvider(settings, await ensureCatalog());
        } else {
          await manageProvider(settings, choice.replace(/^manage:/, ''));
        }
        edit.writeSettings(settings);
        ui.success('Saved.');
      }
      continue;
    }

    if (action === 'search') {
      await manageSearchList(settings);
      edit.writeSettings(settings);
      ui.success('Saved.');
      continue;
    }

    await manageServer(settings);
    edit.writeSettings(settings);
    ui.success('Saved.');
  }

  edit.writeSettings(settings);
  ui.success(`Configuration saved to ${getDataPath('settings.yaml')}.`);
  ui.info('Restart the server to apply: npm run dev');
}

export { normalizeKeyName };
