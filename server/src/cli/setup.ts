import { checkbox, confirm, input, password, search, select } from '@inquirer/prompts';
import { getModelsDevSnapshot } from '../models-dev.js';
import { listSupportedPackages } from '../provider-registry.js';
import { BACK_CHOICE, BACK_LABEL, createStepMachine } from './steps.js';
import { getAdminKey } from '../admin-auth.js';
import { readiness } from './config-edit.js';
import { checkKeyName } from './admin.js';
import { ApiPlatformStore } from '../api-platform-store.js';
import {
  loadSettings,
  saveSettings,
  type ProviderState,
  type SearchProviderState,
  type SettingsStore,
} from '../settings-store.js';
import { getDataPath } from '../storage.js';
import * as ui from './ui.js';

/** The search backends the setup wizard offers, in try order. */
export const SEARCH_BACKEND_CHOICES: Array<{ id: string; label: string; needsZone: boolean; keyless?: boolean }> = [
  { id: 'serper', label: 'Serper (Google SERP)', needsZone: false },
  { id: 'youcom', label: 'You.com web search', needsZone: false },
  { id: 'serpapi', label: 'SerpApi (Google engine)', needsZone: false },
  { id: 'tavily', label: 'Tavily search', needsZone: false },
  { id: 'linkup', label: 'Linkup search', needsZone: false },
  { id: 'brave', label: 'Brave web search', needsZone: false },
  { id: 'parallel', label: 'Parallel v1 search', needsZone: false },
  { id: 'octen', label: 'Octen web search', needsZone: false },
  { id: 'firecrawl', label: 'Firecrawl v2 search', needsZone: false },
  { id: 'exa', label: 'Exa search', needsZone: false },
  { id: 'brightdata', label: 'Bright Data SERP (Google)', needsZone: true },
  { id: 'serply', label: 'Serply Google search', needsZone: false },
  { id: 'valyu', label: 'Valyu web search', needsZone: false },
  { id: 'jina', label: 'Jina Reader search', needsZone: false },
  { id: 'freeserp', label: 'FreeSerp search (keyless, no key needed)', needsZone: false, keyless: true },
];

/**
 * Splits pasted key/model lists on commas, whitespace, or newlines and drops
 * empties, so `a, b\nc` and `a b c` both work.
 */
export function parseList(raw: string): string[] {
  return raw.split(/[\s,;]+/).map((part) => part.trim()).filter((part) => part.length > 0);
}

/** One-line summary of an LLM provider entry. */
export function summarizeProvider(id: string, state: ProviderState): string {
  const keys = state.keys.length === 1 ? '1 key' : `${state.keys.length} keys`;
  const models = state.models.length === 0 ? 'all catalog models' : state.models.join(', ');
  const custom = state.npm ? ` via ${state.npm}` : '';
  return `${state.enabled ? 'on' : 'off'} ${id}${custom} — ${keys}, models: ${models}`;
}

/** One-line summary of a search backend entry. */
export function summarizeSearch(id: string, state: SearchProviderState): string {
  const keys = state.keyless === true
    ? 'keyless'
    : state.keys.length === 1 ? '1 key' : `${state.keys.length} keys`;
  const zone = state.zone ? `, zone ${state.zone}` : '';
  return `${id} — ${keys}${zone}`;
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
 * Collects API keys for one provider or backend.
 *
 * The prompt names the thing the key belongs to, then asks for the key itself,
 * so a label like "keys" can never be mistaken for a name to type into.
 */
async function askKeys(existing: string[], owner: string): Promise<string[]> {
  const keys = [...existing];
  if (existing.length > 0) {
    const keep = await confirm({
      message: `${owner}: keep the ${existing.length} key(s) already saved?`,
      default: true,
    });
    if (keep) {
      const more = await confirm({ message: `${owner}: add another key?`, default: false });
      if (!more) return keys;
    }
  }
  for (;;) {
    const prompt = keys.length === 0
      ? `Paste the API key for ${owner}`
      : `Paste another key for ${owner} (empty to finish)`;
    const key = await password({ message: prompt, mask: true });
    if (!key.trim()) {
      if (keys.length > 0) return keys;
      ui.warn(`${owner} needs at least one API key.`);
      continue;
    }
    keys.push(key.trim());
    ui.success(`${owner}: key ${keys.length} stored (shown later as …${key.trim().slice(-4)}).`);
    const more = await confirm({ message: `${owner}: add another key?`, default: false });
    if (!more) return keys;
  }
}

/**
 * Scores one provider against the search terms.
 *
 * Higher is better, `-1` means no match. The ranking exists so the intended
 * provider lands in the first visible row instead of being buried by an
 * alphabetical list: an exact id beats a name prefix, which beats an id
 * substring, which beats a name substring, which beats a subsequence match.
 */
export function scoreProvider(entry: CatalogEntry, terms: string[]): number {
  if (terms.length === 0) return 0;
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();

  let total = 0;
  for (const term of terms) {
    if (id === term) total += 1000;
    else if (id.startsWith(term)) total += 500;
    else if (name.startsWith(term)) total += 300;
    else if (id.includes(term)) total += 200;
    else if (name.includes(term)) total += 100;
    else if (isSubsequence(term, id)) total += 20;
    else return -1;
  }
  /* Every extra term matched narrows the result, so rank it higher. */
  return total + terms.length;
}

/** True when `needle`'s characters appear in `haystack` in order. */
function isSubsequence(needle: string, haystack: string): boolean {
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Filters and orders providers for the search prompt.
 *
 * Every match is returned. An earlier version truncated to 30 entries, which
 * hid most of the catalog when the prompt opened with an empty term. Ordering is
 * score first, then provider count, then alphabetically, so the result is
 * stable between keystrokes.
 */
export function rankProviders(catalog: CatalogEntry[], term: string): CatalogEntry[] {
  const terms = term.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ entry: CatalogEntry; score: number }> = [];
  for (const entry of catalog) {
    const score = scoreProvider(entry, terms);
    if (score >= 0) scored.push({ entry, score });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || b.entry.modelCount - a.entry.modelCount
    || a.entry.id.localeCompare(b.entry.id)
  ));
  return scored.map((item) => item.entry);
}

/** Returns `BACK_CHOICE` when the user asked to go back. */
async function askProviderId(
  catalog: CatalogEntry[],
  already: Set<string>,
  canGoBack: boolean,
): Promise<{ id: string; custom: boolean } | 'back'> {
  const choices = [
    { value: 'catalog', name: `Catalog (${catalog.length || 200}+ providers from models.dev)` },
    { value: 'custom', name: 'Custom endpoint (self-hosted, proxy, local model)' },
  ];
  if (canGoBack) {
    choices.push({ value: BACK_CHOICE, name: BACK_LABEL });
  }
  const kind = await select({ message: 'LLM provider source', choices });
  if (kind === BACK_CHOICE) return 'back';
  if (kind === 'custom') {
    const id = await input({
      message: 'Custom provider id (letters, digits, dashes)',
      validate: (value) => (/^[a-z0-9][a-z0-9-]*$/i.test(value.trim()) ? true : 'Use letters, digits, or dashes.'),
    });
    return { id: id.trim(), custom: true };
  }
  if (catalog.length === 0) {
    ui.warn('No model catalog available (offline and nothing cached). Use a custom endpoint instead.');
    return askProviderId(catalog, already, canGoBack);
  }
  return {
    id: await search({
      message: 'Provider (type to search, ↑↓ to move, enter to pick)',
      pageSize: 12,
      source: async (term) => {
        const matches = rankProviders(catalog, term ?? '');
        return matches.map((entry) => ({
          value: entry.id,
          name: `${entry.name}  (${entry.id}, ${entry.modelCount} models)${already.has(entry.id) ? ' — configured' : ''}`,
        }));
      },
    }),
    custom: false,
  };
}

/** Picks models from the catalog for a known provider; free text otherwise. */
async function askModels(id: string, catalog: CatalogEntry[], custom: boolean, existing: string[]): Promise<string[]> {
  if (custom) {
    const raw = await input({ message: 'Models, comma separated (at least one)', default: existing.join(', ') });
    return parseList(raw);
  }
  const entry = catalog.find((item) => item.id === id);
  if (!entry) return existing;
  const snapshot = await getModelsDevSnapshot();
  const models = Object.keys(snapshot.providers[id]?.models ?? {}).sort();
  if (models.length === 0) return existing;
  const mode = await select({
    message: 'Which models should this provider serve?',
    choices: [
      { value: 'all', name: `All catalog models (${models.length})` },
      { value: 'pick', name: 'Choose a subset' },
      { value: 'text', name: 'Type model ids manually' },
    ],
  });
  if (mode === 'all') return [];
  if (mode === 'text') {
    const raw = await input({ message: 'Models, comma separated', default: existing.join(', ') });
    return parseList(raw);
  }
  const chosen = await checkbox({
    message: 'Select models (space to toggle, enter to confirm)',
    pageSize: 12,
    choices: models.map((model) => ({ value: model, name: model, checked: existing.includes(model) })),
  });
  return chosen;
}

async function configureLlmProvider(
  catalog: CatalogEntry[],
  settings: SettingsStore,
  picked: { id: string; custom: boolean },
): Promise<void> {
  const { id, custom } = picked;
  const existing = settings.providers[id];
  const npm = custom
    ? await select({ message: `Runtime package for ${id}`, choices: listSupportedPackages().map((name) => ({ value: name })) })
    : existing?.npm;
  const url = await input({
    message: custom ? 'Endpoint base URL (required)' : 'Base URL override (empty = catalog default)',
    default: existing?.url ?? '',
    validate: custom
      ? (value) => (value.trim().length > 0 ? true : 'A custom endpoint needs its URL.')
      : undefined,
  });
  const keys = await askKeys(existing?.keys ?? [], `API key for ${id}`);
  const models = await askModels(id, catalog, custom, existing?.models ?? []);
  const entry: ProviderState = {
    enabled: existing?.enabled ?? true,
    keys,
    models,
    ...(url.trim() ? { url: url.trim() } : {}),
    ...(npm ? { npm } : {}),
  };
  settings.providers[id] = entry;
}

/** Backend picker, with a back entry when there is a step to return to. */
async function askSearchBackendChoice(settings: SettingsStore, canGoBack: boolean): Promise<string[] | 'back'> {
  const choices: Array<{ value: string; name: string; checked?: boolean }> = SEARCH_BACKEND_CHOICES.map((backend) => ({
    value: backend.id,
    name: backend.label,
    checked: (settings.searchProviders[backend.id]?.keys.length ?? 0) > 0 ||
      settings.searchProviders[backend.id]?.keyless === true,
  }));
  if (canGoBack) choices.push({ value: BACK_CHOICE, name: BACK_LABEL });
  const selected = await checkbox({
    message: 'Search backends to configure (space to toggle, enter to continue)',
    pageSize: 14,
    choices,
  });
  /* Back only counts when it is the sole selection, so it cannot be picked
     together with real backends. */
  if (selected.length === 1 && selected[0] === BACK_CHOICE) return 'back';
  return selected.filter((id) => id !== BACK_CHOICE);
}

async function configureSearch(settings: SettingsStore, selected: string[]): Promise<void> {
  const next: Record<string, SearchProviderState> = {};
  for (const id of selected) {
    const backend = SEARCH_BACKEND_CHOICES.find((item) => item.id === id);
    const existing = settings.searchProviders[id];
    /* Keyless backends need no key prompt: selecting them is the opt-in. */
    const entry: SearchProviderState = backend?.keyless === true
      ? { keys: [], keyless: true }
      : { keys: await askKeys(existing?.keys ?? [], `API key for ${id}`) };
    const url = await input({ message: `${id}: endpoint override (empty = default)`, default: existing?.url ?? '' });
    if (url.trim()) entry.url = url.trim();
    if (backend?.needsZone) {
      const zone = await input({
        message: `${id}: SERP zone name (required)`,
        default: existing?.zone ?? '',
        validate: (value) => (value.trim().length > 0 ? true : 'Bright Data needs its SERP zone name.'),
      });
      entry.zone = zone.trim();
    }
    next[id] = entry;
  }
  settings.searchProviders = next;
  settings.searchProviderOrder = selected;
}

function printSummary(settings: SettingsStore): void {
  ui.section('Review');
  ui.line(ui.color.dim('  LLM providers'));
  const ids = Object.keys(settings.providers);
  if (ids.length === 0) ui.bullet(ui.color.dim('none configured'));
  for (const id of ids) ui.bullet(summarizeProvider(id, settings.providers[id]));
  ui.line(ui.color.dim('  Search backends'));
  const sids = Object.keys(settings.searchProviders);
  if (sids.length === 0) ui.bullet(ui.color.dim('none configured'));
  for (const id of sids) ui.bullet(summarizeSearch(id, settings.searchProviders[id]));
}

/** Wizard sections, in order. Back navigation walks this list. */
export const SETUP_STEPS = ['server', 'llm', 'search', 'review'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

/**
 * Full setup wizard.
 *
 * Steps are driven by an explicit machine rather than a linear script, so a
 * prompt can offer `← Back` and land on the previous section instead of
 * restarting the whole wizard. Settings are written once at the end, so any
 * number of back-and-forward moves changes nothing on disk until then.
 */
export async function runSetup(): Promise<void> {
  ui.section('Setup');
  ui.kv('Data directory', getDataPath());
  ui.kv('Settings file', getDataPath('settings.yaml'));
  ui.info('Nothing is written until the last step. Ctrl+C cancels without saving.');

  const settings = loadSettings();
  const machine = createStepMachine<SetupStep>(SETUP_STEPS);
  let catalog: CatalogEntry[] = [];

  for (;;) {
    if (machine.current === 'server') {
      settings.port = Number(await input({ message: 'HTTP port', default: String(settings.port) })) || settings.port;
      settings.host = await input({ message: 'Bind address', default: settings.host });
      if (machine.next() === 'finish') return;
      continue;
    }

    if (machine.current === 'llm') {
      ui.section('LLM providers');
      if (catalog.length === 0) {
        catalog = await ui.step('Loading model catalog', () => loadCatalog());
        if (catalog.length > 0) ui.info(`${catalog.length} catalog providers available.`);
        else ui.warn('Catalog unavailable; only custom endpoints can be configured.');
      }
      for (;;) {
        const picked = await askProviderId(catalog, new Set(Object.keys(settings.providers)), !machine.atStart);
        if (picked === 'back') {
          if (machine.back() === 'abort') return;
          break;
        }
        await configureLlmProvider(catalog, settings, picked);
        const more = await confirm({ message: 'Add another LLM provider?', default: false });
        if (!more) break;
      }
      if (machine.current !== 'llm') continue;
      const enabled = Object.entries(settings.providers).filter(([, state]) => state.enabled);
      if (enabled.length > 0) {
        const disable = await checkbox({
          message: 'Disable any of them? (space to toggle, enter to keep all enabled)',
          choices: enabled.map(([id]) => ({ value: id, name: id, checked: false })),
        });
        for (const id of disable) settings.providers[id].enabled = false;
      }
      if (machine.next() === 'finish') return;
      continue;
    }

    if (machine.current === 'search') {
      ui.section('Search backends');
      const chosen = await askSearchBackendChoice(settings, !machine.atStart);
      if (chosen === 'back') {
        if (machine.back() === 'abort') return;
        continue;
      }
      await configureSearch(settings, chosen);
      if (machine.next() === 'finish') return;
      continue;
    }

    printSummary(settings);
    const decision = await select({
      message: 'What next?',
      choices: [
        { value: 'save', name: 'Save these settings' },
        { value: 'search', name: '← Back to search backends' },
        { value: 'llm', name: '← Back to LLM providers' },
        { value: 'discard', name: 'Discard and exit without saving' },
      ],
    });
    if (decision === 'save') break;
    if (decision === 'discard') {
      ui.warn('Nothing was written.');
      return;
    }
    machine.goto(SETUP_STEPS.indexOf(decision));
  }

  saveSettings(settings);
  ui.success(`Saved to ${getDataPath('settings.yaml')}`);

  /* The server refuses to start unconfigured, but even configured it needs a
     client key to call the API, so one is created here. */
  await offerClientKey();
  ui.section('Admin key');
  ui.kv('Key', ui.color.bold(getAdminKey()));
  ui.line();
  ui.warn('/v1/keys and /v1/analytics need it as X-Admin-Key. Rotate any time with: athena admin-key rotate');
  ui.info('Start the server with: npm run dev   (inside server/)');
}

/** Creates a first API key so the setup leaves a usable installation. */
async function offerClientKey(): Promise<void> {
  const report = readiness(loadSettings());
  if (!report.ready) {
    ui.line();
    ui.warn('The server still needs more configuration before it will start:');
    for (const problem of report.problems) ui.line(ui.color.red(`    ${problem}`));
    ui.info(`Finish it any time with: athena config`);
    return;
  }
  const store = new ApiPlatformStore();
  try {
    const existing = store.listApiKeys().filter((record) => !record.revokedAt);
    if (existing.length > 0) {
      ui.info(`${existing.length} API key(s) already exist. Manage them with: athena keys list`);
      return;
    }
    const name = await input({
      message: 'Name for your first API key (letters, digits, spaces)',
      default: 'my app',
      validate: (value) => checkKeyName(value) ?? true,
    });
    const plan = await select({
      message: 'Plan for this key',
      choices: [
        { value: 'free', name: 'free — 1 USD/day' },
        { value: 'paid', name: 'paid — 50 USD/day' },
        { value: 'enterprise', name: 'enterprise — 500 USD/day' },
      ],
      default: 'free',
    });
    const { record, secret } = store.createApiKey(name, plan);
    ui.section('Your API key');
    ui.kv('Id', record.id);
    ui.kv('Name', record.name);
    ui.kv('Plan', record.plan);
    ui.kv('Secret', ui.color.bold(secret));
    ui.line();
    ui.warn('The secret is shown once and only its hash is stored. Copy it now.');
  } finally {
    store.close();
  }
}
