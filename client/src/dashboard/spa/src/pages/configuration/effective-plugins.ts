import { canonicalHarnessName, HERMES_AGENT_HARNESS } from './harnessNames.js';

/**
 * Effective-plugin computation for a joined SolverNet.
 *
 * The shape of "what plugins are active" is computed from four inputs:
 *
 *   1. `harness` — determines which bundled plugins are auto-included
 *      (e.g. Hermes owns its own learner loop, so claude-code-learner
 *      is dropped from its default set).
 *   2. `catalogCompatible` — plugins the SolverNet manifest's catalog
 *      entry advertises as compatible. A subset of these are flagged as
 *      default-included by `DEFAULT_COMPATIBLE_PLUGINS`.
 *   3. `explicit` — plugins the operator has explicitly added to their
 *      config (overrides above defaults).
 *   4. `disabledDefaults` — bundled/default plugins the operator has
 *      explicitly turned off.
 *
 * Used by the configuration `PluginPicker` (the membership editor) and
 * by the operator dashboard's `ActivityCard` (the read-only settings
 * panel). Centralising the rule means the dashboard never says "None"
 * when Settings says "2 default plugins active".
 */

export interface CatalogPluginOption {
  name: string;
  version: string;
  source: string;
}

export interface EffectivePlugin {
  name: string;
  /** Human-readable name for display. Falls back to `name` if unmapped. */
  displayName: string;
  /** Underlying plugin source: bundled (ships with the daemon) or catalog (manifest-advertised). */
  source: 'bundled' | 'catalog' | 'custom';
  /** Plugin version string. */
  version: string;
  /** True if this plugin is on by default (i.e. its presence doesn't require explicit operator opt-in). */
  defaultIncluded: boolean;
}

/**
 * Bundled plugins — ship with the daemon, no manifest required. The
 * subset that's default-on depends on the harness (see
 * `includedBundledPluginsFor`).
 */
const ALL_BUNDLED_PLUGINS: ReadonlyArray<{
  name: string;
  version: string;
  defaultIncluded: true;
}> = [
  { name: 'network-tools', version: '0.1.0', defaultIncluded: true },
  { name: 'claude-code-learner', version: '0.2.0', defaultIncluded: true },
];

/**
 * Catalog-advertised plugins that, when present in the SolverNet's
 * `compatiblePlugins`, are default-included. Operators don't need to
 * opt in — the membership picks them up automatically.
 */
const DEFAULT_COMPATIBLE_PLUGINS: ReadonlySet<string> = new Set([
  'swe-rebench-v2-runtime',
]);

/**
 * Human-readable name mapping. Falls back to `name` for unmapped plugins.
 */
const DISPLAY_NAMES: Record<string, string> = {
  'network-tools': 'Network Tools',
  'claude-code-learner': 'Learner',
  'swe-rebench-v2-runtime': 'SWE-rebench v2 Runtime',
  'jinn-prediction-plugin': 'Prediction Runtime',
};

const BUNDLED_PREFIX = 'bundled:';

export function displayName(name: string): string {
  return DISPLAY_NAMES[name] ?? name;
}

export function stripBundledPrefix(value: string): string {
  return value.startsWith(BUNDLED_PREFIX) ? value.slice(BUNDLED_PREFIX.length) : value;
}

export function pluginConfigValue(option: { source: string; name: string }): string {
  return option.source === 'bundled' ? `${BUNDLED_PREFIX}${option.name}` : option.name;
}

/**
 * Bundled plugins that should be on by default for a given harness. Hermes
 * owns its own learning loop, so the Learner plugin is dropped from its
 * default set (it would be redundant + collision-prone).
 */
export function includedBundledPluginsFor(harness: string | undefined): EffectivePlugin[] {
  const isHermes = canonicalHarnessName(harness) === HERMES_AGENT_HARNESS;
  return ALL_BUNDLED_PLUGINS.filter((p) => !(isHermes && p.name === 'claude-code-learner')).map(
    (p) => ({
      name: p.name,
      displayName: displayName(p.name),
      source: 'bundled' as const,
      version: p.version,
      defaultIncluded: true,
    }),
  );
}

export interface ComputeEffectivePluginsInput {
  harness: string | undefined;
  explicit: string[];
  disabledDefaults: string[];
  catalogCompatible?: CatalogPluginOption[];
}

/**
 * Compute the effective set of plugins active on a joined SolverNet. The
 * order is stable (bundled defaults first, then catalog defaults, then
 * explicit overrides) so consumers can render the list deterministically.
 */
export function computeEffectivePlugins({
  harness,
  explicit,
  disabledDefaults,
  catalogCompatible = [],
}: ComputeEffectivePluginsInput): EffectivePlugin[] {
  const disabledSet = new Set(disabledDefaults.map(stripBundledPrefix));
  const explicitSet = new Set(explicit.map(stripBundledPrefix));
  const explicitValues = new Map(
    explicit.map((v) => [stripBundledPrefix(v), v] as const),
  );

  const out: EffectivePlugin[] = [];
  const seen = new Set<string>();

  // 1. Bundled defaults for the harness (minus operator-disabled).
  for (const p of includedBundledPluginsFor(harness)) {
    if (seen.has(p.name)) continue;
    seen.add(p.name);
    if (disabledSet.has(p.name)) continue;
    out.push(p);
  }

  // 2. Catalog-advertised plugins. Those in DEFAULT_COMPATIBLE_PLUGINS are
  //    default-included; others are only active if the operator added them
  //    explicitly.
  for (const cat of catalogCompatible) {
    if (seen.has(cat.name)) continue;
    seen.add(cat.name);
    const isDefault = DEFAULT_COMPATIBLE_PLUGINS.has(cat.name);
    const explicitlyAdded = explicitSet.has(cat.name);
    if (!isDefault && !explicitlyAdded) continue;
    if (isDefault && disabledSet.has(cat.name)) continue;
    out.push({
      name: cat.name,
      displayName: displayName(cat.name),
      source: 'catalog',
      version: cat.version,
      defaultIncluded: isDefault,
    });
  }

  // 3. Anything explicit that's not yet covered (a custom add).
  for (const value of explicit) {
    const name = stripBundledPrefix(value);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      displayName: displayName(name),
      source: value.startsWith(BUNDLED_PREFIX) ? 'bundled' : 'custom',
      version: 'configured',
      defaultIncluded: false,
    });
  }

  // Silence the unused-Map warning while keeping the lookup available for
  // future use (e.g. an "override of default" indicator).
  void explicitValues;

  return out;
}
