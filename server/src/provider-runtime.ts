import { getCachedModelsDevProvider } from './models-dev.js';
import type { ProviderState } from './settings-store.js';

/**
 * How a provider gets wired to a runtime, in one place.
 *
 * A provider runs only when three things line up: a runtime package the server
 * can execute, an endpoint to call, and at least one key. The catalog supplies
 * the first two for the providers it knows and nothing at all for the rest, so a
 * provider an operator adds by hand is inert until settings declare them. That
 * is the whole reason a gateway endpoint could not be used from the console: the
 * console could set a key and a model, but not the runtime, and the failure only
 * ever surfaced as a request that answered "no enabled keys" long after the
 * screen that caused it.
 *
 * Both sides of that need the same answer. `resolveProvider` in
 * provider-registry executes it, `operator-settings` reports it as readiness
 * before anything is asked of a model. Neither imports the other: this module
 * imports only the catalog and the settings types, so the rule stays written
 * once and cannot drift between "what works" and "what the console believes".
 */

/**
 * The runtime package for a provider: what settings declare, else what the
 * catalog knows. Settings win because that is the only place an operator can
 * describe an endpoint the catalog has never heard of.
 */
export function runtimePackageFor(providerId: string, state?: ProviderState): string | null {
  const declared = state?.npm?.trim();
  if (declared) return declared;
  const fromCatalog = getCachedModelsDevProvider(providerId)?.npm;
  return typeof fromCatalog === 'string' && fromCatalog.length > 0 ? fromCatalog : null;
}

/**
 * Packages that carry their own endpoint.
 *
 * The gateway SDK knows where Vercel AI Gateway lives; asking an operator for a
 * base URL on top of that is asking them for something the package already
 * knows, and getting it wrong breaks a provider that would otherwise work.
 */
const SELF_ENDPOINTED_PACKAGES = new Set(['@ai-sdk/gateway']);

/** The base URL to call: a settings override, else the catalog's endpoint. */
export function providerEndpointFor(providerId: string, state?: ProviderState): string | null {
  const override = state?.url?.trim();
  if (override) return override;
  const api = getCachedModelsDevProvider(providerId)?.api;
  return typeof api === 'string' && api.length > 0 ? api : null;
}

/**
 * Why this provider cannot run, or null when nothing stands in the way.
 *
 * `isPackageSupported` is injected because the list of runnable packages is the
 * registry's, which imports this module. The message names the field to fill in
 * and where to fill it: a provider that is enabled, keyed and routed to, but
 * inert, is a configuration state an operator can fix in one click.
 */
export function providerResolutionProblem(
  providerId: string,
  state: ProviderState,
  isPackageSupported: (npm: string) => boolean,
  supportedPackages: readonly string[] = [],
): string | null {
  const npm = runtimePackageFor(providerId, state);
  if (!npm) {
    return `Provider "${providerId}" is enabled and routed to, but the model catalog does not know it and settings declare no runtime package. Set its runtime package and base URL in Settings → Providers, or pick a catalog provider.`;
  }
  if (!isPackageSupported(npm)) {
    const alternatives = supportedPackages.length > 0 ? ` Supported here: ${supportedPackages.join(', ')}.` : '';
    return `Provider "${providerId}" declares runtime package "${npm}", which this build cannot run.${alternatives}`;
  }
  if (!providerEndpointFor(providerId, state) && !SELF_ENDPOINTED_PACKAGES.has(npm)) {
    return `Provider "${providerId}" has no endpoint. Set a base URL in Settings → Providers.`;
  }
  return null;
}