import { describe, it, expect, beforeEach } from 'vitest';
import {
  UpdateSettingsSchema,
  UnservedRouteError,
  applySettingsPatch,
  catalogModelsOf,
  defaultModesOf,
  describeSettings,
  maskSecret,
  reconcileSecrets,
  unusableProviders,
  unservedRoutes,
} from '../src/operator-settings.js';
import { loadSettings, resetSettingsCache, saveSettings, type SettingsStore } from '../src/settings-store.js';

/* Shaped like a real credential so masking behaves realistically, but never a
   live one: a committed secret is a leaked secret. Distinct last four on
   purpose — the mask is derived from exactly that, and shared endings would
   make the assertions below pass or fail by accident. */
const SECRET_A = 'openrouter-test-key-alpha-1111';
const SECRET_B = 'tavily-test-key-bravo-2222';

function seed(partial: Partial<SettingsStore>): SettingsStore {
  const store = { ...loadSettings(), ...partial };
  /* Routes are not inert: when the file omits them, normalize fills them from
     `providerOrder[0]` and `general.titleModel`, so one test's leftovers can
     decide whether another's save validates. A test that cares about routing
     says so; everything else starts from an unset route. */
  if (!partial.modelRouting) {
    store.modelRouting = {
      instant: { primary: { providerId: '', model: '' }, fallback: [] },
      default: { primary: { providerId: '', model: '' }, fallback: [] },
      deep: { primary: { providerId: '', model: '' }, fallback: [] },
      max: { primary: { providerId: '', model: '' }, fallback: [] },
    };
  }
  saveSettings(store);
  return loadSettings();
}

beforeEach(() => {
  resetSettingsCache();
});

describe('maskSecret', () => {
  it('shows only the last four characters', () => {
    expect(maskSecret(SECRET_A)).toBe(`…${SECRET_A.slice(-4)}`);
    expect(maskSecret(SECRET_A)).not.toContain(SECRET_A.slice(0, -4));
  });

  it('collides on a shared last four, which is why reconcile consumes by order', () => {
    /* The mask alone cannot tell these apart. It does not have to: the mask is
       never used to *select* a secret by content, only to recognise "this is the
       one that was here", and each stored secret can be claimed once. */
    expect(maskSecret('aaaa-key-1234')).toBe(maskSecret('bbbb-key-1234'));
    expect(reconcileSecrets(['aaaa-key-1234', 'bbbb-key-1234'], ['…1234', '…1234'])).toEqual([
      'aaaa-key-1234',
      'bbbb-key-1234',
    ]);
  });
});

describe('reconcileSecrets', () => {
  it('turns a mask back into the secret it came from', () => {
    expect(reconcileSecrets([SECRET_A], [maskSecret(SECRET_A)])).toEqual([SECRET_A]);
  });

  it('appends a newly typed secret while keeping the masked one', () => {
    const result = reconcileSecrets([SECRET_A], [maskSecret(SECRET_A), SECRET_B]);
    expect(result).toEqual([SECRET_A, SECRET_B]);
  });

  it('drops a masked entry when the secret behind it is gone', () => {
    /* Never store the mask itself as a credential. */
    const result = reconcileSecrets([SECRET_A], [maskSecret('key-that-was-deleted-000000000000000000')]);
    expect(result).toEqual([]);
    expect(result.join()).not.toContain('…');
  });

  it('keeps two stored secrets that share a last four distinct', () => {
    const first = 'aaaa-key-1234';
    const second = 'bbbb-key-1234';
    const result = reconcileSecrets([first, second], [maskSecret(first), maskSecret(second)]);
    expect(result).toEqual([first, second]);
    expect(new Set(result).size).toBe(2);
  });

  it('ignores blank entries and repeated copies of one secret', () => {
    expect(reconcileSecrets([], ['', '   ', SECRET_A, SECRET_A])).toEqual([SECRET_A]);
  });

  it('removes a secret the operator deleted', () => {
    expect(reconcileSecrets([SECRET_A, SECRET_B], [maskSecret(SECRET_B)])).toEqual([SECRET_B]);
  });

  it('clears every secret when the list comes back empty', () => {
    expect(reconcileSecrets([SECRET_A], [])).toEqual([]);
  });
});

describe('catalogModelsOf', () => {
  const catalog = ['alpha', 'beta', 'gamma'];

  it('returns nothing for a provider that is not configured', () => {
    expect(catalogModelsOf(undefined, catalog)).toEqual([]);
  });

  it('treats an empty whitelist as every catalog model', () => {
    /* This is the reading the router has always used; /v1/models used to read
       it the other way and listed nothing at all. */
    expect(catalogModelsOf({ enabled: true, keys: ['k'], models: [] }, catalog)).toEqual(catalog);
  });

  it('keeps catalog order when a whitelist narrows the list', () => {
    const state = { enabled: true, keys: ['k'], models: ['gamma', 'alpha'] };
    expect(catalogModelsOf(state, catalog)).toEqual(['alpha', 'gamma']);
  });

  it('drops whitelist ids the catalog does not have', () => {
    const state = { enabled: true, keys: ['k'], models: ['alpha', 'nope'] };
    expect(catalogModelsOf(state, catalog)).toEqual(['alpha']);
  });
});

describe('defaultModesOf', () => {
  const routing = () => loadSettings().modelRouting;

  it('names every mode whose primary is this exact model', () => {
    seed({
      modelRouting: {
        instant: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
        default: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
        deep: { primary: { providerId: 'openrouter', model: 'm2' }, fallback: [] },
        max: { primary: { providerId: 'other', model: 'm1' }, fallback: [] },
      },
    });
    expect(defaultModesOf(routing(), 'openrouter', 'm1').sort()).toEqual(['default', 'instant']);
    expect(defaultModesOf(routing(), 'openrouter', 'm2')).toEqual(['deep']);
    expect(defaultModesOf(routing(), 'other', 'm1')).toEqual(['max']);
    expect(defaultModesOf(routing(), 'openrouter', 'nope')).toEqual([]);
  });
});

describe('describeSettings', () => {
  it('masks every stored secret and counts them', () => {
    seed({ providers: { openrouter: { enabled: true, keys: [SECRET_A, SECRET_B], models: [] } } });
    const view = describeSettings();
    expect(view.providers.openrouter.keys).toEqual([maskSecret(SECRET_A), maskSecret(SECRET_B)]);
    expect(view.providers.openrouter.keyCount).toBe(2);
    expect(JSON.stringify(view)).not.toContain(SECRET_A);
    expect(JSON.stringify(view)).not.toContain(SECRET_B);
  });

  it('reports a provider that serves the whole catalog', () => {
    seed({ providers: { openrouter: { enabled: true, keys: [SECRET_A], models: [] } } });
    expect(describeSettings().providers.openrouter.servesWholeCatalog).toBe(true);

    seed({ providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m1'] } } });
    expect(describeSettings().providers.openrouter.servesWholeCatalog).toBe(false);
  });

  it('exposes port and host as read-only context', () => {
    const view = describeSettings();
    expect(view.server.port).toBeGreaterThan(0);
    expect(typeof view.server.host).toBe('string');
  });

  it('lists the search backends it knows about', () => {
    const ids = describeSettings().catalog.search.map((backend) => backend.id);
    expect(ids).toContain('exa');
    expect(ids).toContain('tavily');
  });
});

describe('applySettingsPatch', () => {
  it('changes one provider and leaves the others alone', () => {
    seed({
      providers: {
        openrouter: { enabled: true, keys: [SECRET_A], models: ['m1'] },
        anthropic: { enabled: true, keys: [SECRET_B], models: ['m2'] },
      },
    });
    applySettingsPatch({ providers: { openrouter: { models: ['m1', 'm3'] } } });
    const after = loadSettings();
    expect(after.providers.openrouter.models).toEqual(['m1', 'm3']);
    expect(after.providers.openrouter.keys).toEqual([SECRET_A]);
    expect(after.providers.anthropic.models).toEqual(['m2']);
    expect(after.providers.anthropic.keys).toEqual([SECRET_B]);
  });

  it('writes the change to disk, not just to memory', () => {
    seed({ general: { ...loadSettings().general, maxSources: 8 } });
    applySettingsPatch({ general: { maxSources: 12 } });
    resetSettingsCache();
    expect(loadSettings().general.maxSources).toBe(12);
  });

  it('round-trips a masked key without touching the stored secret', () => {
    seed({ providers: { openrouter: { enabled: true, keys: [SECRET_A], models: [] } } });
    const before = describeSettings().providers.openrouter.keys;
    applySettingsPatch({ providers: { openrouter: { keys: [...before] } } });
    expect(loadSettings().providers.openrouter.keys).toEqual([SECRET_A]);
    expect(describeSettings().providers.openrouter.keys).toEqual(before);
  });

  it('removes a provider when the entry is null', () => {
    seed({ providers: { openrouter: { enabled: true, keys: [SECRET_A], models: [] } } });
    applySettingsPatch({ providers: { openrouter: null } });
    expect(loadSettings().providers.openrouter).toBeUndefined();
    expect(loadSettings().providerOrder).not.toContain('openrouter');
  });

  it('adds a provider the file did not have', () => {
    seed({ providers: {} });
    applySettingsPatch({ providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m1'] } } });
    const after = loadSettings();
    expect(after.providers.openrouter.enabled).toBe(true);
    expect(after.providers.openrouter.models).toEqual(['m1']);
    expect(after.providerOrder).toContain('openrouter');
  });

  it('drops ids from an order that no longer name a provider', () => {
    seed({ providers: { openrouter: { enabled: true, keys: [], models: [] } } });
    applySettingsPatch({ providerOrder: ['openrouter', 'gone'] });
    expect(loadSettings().providerOrder).toEqual(['openrouter']);
  });

  it('writes the general section without inventing fields', () => {
    /* `general` holds one value now: the rest lost their readers in the
       research-loop rebuild and are not read back. */
    seed({ general: { maxSources: 8 } });
    applySettingsPatch({ general: { maxSources: 20 } });
    expect(loadSettings().general).toEqual({ maxSources: 20 });
  });

  it('merges one api field and keeps the rest', () => {
    const before = loadSettings().api;
    applySettingsPatch({ api: { maxActiveJobs: 7 } });
    const after = loadSettings().api;
    expect(after.maxActiveJobs).toBe(7);
    expect(after.defaultMaxConcurrent).toBe(before.defaultMaxConcurrent);
    expect(after.defaultMode).toBe(before.defaultMode);
  });

  it('points one mode at a model without moving the others', () => {
    seed({
      /* Both providers have to be able to serve what the routes name, or the
         save is refused for a reason this test is not about. */
      providers: {
        openrouter: { enabled: true, keys: [SECRET_A], models: ['m1'] },
        anthropic: { enabled: true, keys: [SECRET_B], models: ['sonnet'] },
      },
      modelRouting: {
        instant: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
        default: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
        deep: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
        max: { primary: { providerId: 'openrouter', model: 'm1' }, fallback: [] },
      },
    });
    applySettingsPatch({ modelRouting: { deep: { primary: { providerId: 'anthropic', model: 'sonnet' } } } });
    const routing = loadSettings().modelRouting;
    expect(routing.deep.primary).toEqual({ providerId: 'anthropic', model: 'sonnet' });
    expect(routing.default.primary.model).toBe('m1');
    expect(routing.instant.primary.model).toBe('m1');
  });

  it('clears a mode by naming neither a provider nor a model', () => {
    applySettingsPatch({ modelRouting: { instant: { primary: { providerId: '', model: '' } } } });
    expect(loadSettings().modelRouting.instant.primary).toEqual({ providerId: '', model: '' });
  });

  it('round-trips a search backend key through its mask', () => {
    seed({ searchProviders: { exa: { keys: [SECRET_B] } } });
    const masked = describeSettings().searchProviders.exa.keys;
    expect(masked[0]).toBe(maskSecret(SECRET_B));
    applySettingsPatch({ searchProviders: { exa: { keys: masked } } });
    expect(loadSettings().searchProviders.exa.keys).toEqual([SECRET_B]);
  });
});

describe('UpdateSettingsSchema', () => {
  it('accepts an empty model whitelist, which means the whole catalog', () => {
    expect(UpdateSettingsSchema.safeParse({ providers: { openrouter: { models: [] } } }).success).toBe(true);
  });

  it('rejects an empty patch', () => {
    const parsed = UpdateSettingsSchema.safeParse({});
    expect(parsed.success).toBe(false);
  });

  it('accepts a patch that names only one mode', () => {
    /* Zod 4 makes an enum-keyed `z.record` exhaustive, so requiring all four
       modes turned "move the deep default" into a 400. One mode in, one mode
       out; the rest are left alone. */
    const parsed = UpdateSettingsSchema.safeParse({
      modelRouting: { deep: { primary: { providerId: 'openrouter', model: 'm1' } } },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && Object.keys(parsed.data.modelRouting ?? {})).toEqual(['deep']);
  });

  it('rejects an unknown mode', () => {
    expect(UpdateSettingsSchema.safeParse({ modelRouting: { banana: {} } }).success).toBe(false);
  });

  it('rejects a route that names a provider but no model', () => {
    expect(
      UpdateSettingsSchema.safeParse({ modelRouting: { default: { primary: { providerId: 'openrouter', model: '' } } } }).success,
    ).toBe(false);
  });

  it('rejects a provider id that is not an id', () => {
    expect(UpdateSettingsSchema.safeParse({ providers: { '../../etc/passwd': { models: [] } } }).success).toBe(false);
  });

  it('rejects a count outside its range', () => {
    expect(UpdateSettingsSchema.safeParse({ general: { maxSources: 0 } }).success).toBe(false);
    expect(UpdateSettingsSchema.safeParse({ general: { maxSources: 500 } }).success).toBe(false);
  });
});

/** All four modes pointed at one provider and model. */
const routeTo = (providerId: string, model: string) => ({
  instant: { primary: { providerId, model }, fallback: [] },
  default: { primary: { providerId, model }, fallback: [] },
  deep: { primary: { providerId, model }, fallback: [] },
  max: { primary: { providerId, model }, fallback: [] },
});

describe('a route naming a model the provider does not serve', () => {
  it('accepts a mode that points at a served model', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m-served'] } },
      modelRouting: routeTo('openrouter', 'm-served'),
    });
    expect(unservedRoutes(loadSettings())).toEqual([]);
  });

  it('accepts an empty whitelist, which means the whole catalog', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: [] } },
      modelRouting: routeTo('openrouter', 'anything-at-all'),
    });
    expect(unservedRoutes(loadSettings())).toEqual([]);
  });

  it('names every mode left pointing at a model the provider dropped', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m-kept'] } },
      modelRouting: routeTo('openrouter', 'm-gone'),
    });
    const problems = unservedRoutes(loadSettings());
    expect(problems).toHaveLength(4);
    expect(problems[0]).toContain('openrouter does not serve');
    expect(problems[0]).toContain('m-gone');
  });

  it('reports a mode pointing at a provider that is not enabled', () => {
    seed({
      providers: { openrouter: { enabled: false, keys: [], models: [] } },
      modelRouting: routeTo('openrouter', 'm'),
    });
    expect(unservedRoutes(loadSettings())[0]).toContain('not enabled');
  });

  it('puts the contradiction in readiness, where the settings screen reads it', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m-kept'] } },
      modelRouting: routeTo('openrouter', 'm-gone'),
    });
    const view = describeSettings();
    expect(view.readiness.ready).toBe(false);
    expect(view.readiness.problems.join(' | ')).toContain('does not serve');
  });

  it('refuses the save that would drop the model a mode starts from', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m-first', 'm-second'] } },
      modelRouting: routeTo('openrouter', 'm-first'),
    });

    expect(() => applySettingsPatch({ providers: { openrouter: { models: ['m-second'] } } })).toThrow(UnservedRouteError);

    /* Refused means untouched — the store still holds both models, so nothing
       was half-written on the way to the error. */
    expect(loadSettings().providers.openrouter.models).toEqual(['m-first', 'm-second']);
  });

  it('accepts the same change once every mode has been moved first', () => {
    seed({
      providers: { openrouter: { enabled: true, keys: [SECRET_A], models: ['m-first', 'm-second'] } },
      modelRouting: routeTo('openrouter', 'm-first'),
    });

    applySettingsPatch({ modelRouting: routeTo('openrouter', 'm-second') });
    applySettingsPatch({ providers: { openrouter: { models: ['m-second'] } } });

    expect(loadSettings().providers.openrouter.models).toEqual(['m-second']);
    expect(unservedRoutes(loadSettings())).toEqual([]);
  });
});

describe('a provider that cannot run is reported before anything is asked of it', () => {
  const gateway = {
    enabled: true,
    keys: ['vck_test_gateway_key_3333'],
    models: ['xiaomi/mimo-v2.6-flash'],
  };

  it('names the missing runtime package, because that is the field the console fills', () => {
    /* The failure this pins: a provider outside the model catalog, enabled,
       keyed and routed to, and answering every request with "no enabled
       keys" � which sent the reader looking for a key that was already there.
       The readiness banner exists so this is visible on the screen that caused
       it, and the message has to name what to fill in. */
    const store = { ...loadSettings(), providers: { gateway: { ...gateway } } };
    const problems = unusableProviders(store);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gateway');
    expect(problems[0]).toContain('runtime package');
  });

  it('accepts the same provider once the console supplies npm and a base URL', () => {
    const store = {
      ...loadSettings(),
      providers: { gateway: { ...gateway, npm: '@ai-sdk/openai-compatible', url: 'https://ai-gateway.vercel.sh/v1' } },
    };

    expect(unusableProviders(store)).toEqual([]);
  });

  it('still reports one that has a runtime but no endpoint', () => {
    const store = {
      ...loadSettings(),
      providers: { gateway: { ...gateway, npm: '@ai-sdk/openai-compatible' } },
    };

    expect(unusableProviders(store)[0]).toContain('no endpoint');
  });

  it('rejects a runtime package this build cannot run', () => {
    const store = {
      ...loadSettings(),
      providers: { gateway: { ...gateway, npm: 'not-a-real-sdk', url: 'https://example.com/v1' } },
    };

    expect(unusableProviders(store)[0]).toContain('cannot run');
  });

  it('leaves a disabled provider alone, because nothing will call it', () => {
    const store = { ...loadSettings(), providers: { gateway: { ...gateway, enabled: false } } };

    expect(unusableProviders(store)).toEqual([]);
  });
});
