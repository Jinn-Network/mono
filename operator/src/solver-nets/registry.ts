import {
  defaultSolverPluginVendorRoot,
  gcOrphanedBundledLocalVendorCopies,
  remoteVendorNamesFromEntries,
  resolveSolverPlugin,
} from '../plugins/index.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import type { RuntimePlugin } from '../harnesses/types.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS } from '../harnesses/names.js';
import type { ProviderRef } from '../harnesses/provider-ref.js';
import type { ExecutionWiringConfigEntry } from '../config/shape-v2.js';
import { contractRefFromWorkKind, digestMatchesCid } from '../config/participation.js';
import { getSolverNetContract, type SolverNetContract } from './contracts.js';

export const JINN_NETWORK_TOOLS_PLUGIN = 'bundled:network-tools' as const;

export type SolverNetOperatorRole = 'solving' | 'evaluating';
export type SolverNetTaskRole = 'restoration' | 'evaluation';

export interface SolverNetConfig {
  enabled: boolean;
  solverType: string;
  /**
   * Non-empty subset of operator roles this SolverNet runs concurrently.
   * Optional only because legacy callers (pre-migration helpers) may omit it;
   * the config loader normalises absence to `['solving']` and migrates any
   * legacy singular `role` to `[role]`.
   */
  roles?: SolverNetOperatorRole[];
  harness: string;
  model?: string;
  /** Provider route for the model (issue #1243). See {@link ProviderRef}. */
  provider?: ProviderRef;
  plugins: SolverPluginEntry[];
  taskGenerator: { enabled: boolean };
}

export interface JoinedSolverNetConfig {
  manifestCid: string;
  name?: string;
  contract?: { id: string; version: string };
  roles: Array<'solver' | 'evaluator'>;
  harness?: string;
  model?: string;
  /** Provider route for the model (issue #1243). See {@link ProviderRef}. */
  provider?: ProviderRef;
  plugins?: SolverPluginEntry[];
  disabledDefaultPlugins?: string[];
}

export interface LoadedSolverNet {
  name: string;
  /**
   * IPFS CID of the joined SolverNet's manifest — the key the operator
   * joined under (`config.joinedSolverNets`). Distinct from `name` (the
   * registry's collision-resistant lookup key, which defaults to this CID
   * but can be overridden by a display name). Used to disambiguate two
   * joined SolverNets sharing a `solverType` by the specific manifest a
   * task pins via `task.solverNetManifestCid` (issue #2039).
   */
  manifestCid: string;
  enabled: boolean;
  solverType: string;
  /** Active operator roles (non-empty after load). */
  roles: SolverNetOperatorRole[];
  contract: SolverNetContract;
  harness: string;
  model?: string;
  /** Provider route for the model (issue #1243). See {@link ProviderRef}. */
  provider?: ProviderRef;
  runtimePlugins: RuntimePlugin[];
  taskGenerator: { enabled: boolean };
}

export function taskRoleForOperatorRole(role: SolverNetOperatorRole): SolverNetTaskRole | undefined {
  if (role === 'solving') return 'restoration';
  if (role === 'evaluating') return 'evaluation';
  return undefined;
}

/**
 * Resolve a non-empty roles array from a config entry. Falls back to
 * `['solving']` for shapes that omit `roles` entirely (e.g. a stub used by
 * unit tests or a legacy migration helper that hasn't run through the zod
 * preprocessor). Deduplicates to keep set semantics simple.
 */
function rolesFromConfig(net: SolverNetConfig): SolverNetOperatorRole[] {
  if (net.roles && net.roles.length > 0) return Array.from(new Set(net.roles));
  return ['solving'];
}

export function rolesFromJoinedConfig(net: JoinedSolverNetConfig): SolverNetOperatorRole[] {
  const roles: SolverNetOperatorRole[] = [];
  for (const role of net.roles) {
    if (role === 'solver') roles.push('solving');
    if (role === 'evaluator') roles.push('evaluating');
  }
  return Array.from(new Set(roles));
}

/**
 * Format a joined-entry contract back into the `<id>.<version>` solverType
 * string the runtime uses for dispatch. Returns `undefined` when the joined
 * entry has no contract (mid-migration synthesized entries can land here).
 */
export function solverTypeFromJoinedContract(
  net: Pick<JoinedSolverNetConfig, 'contract'>,
): string | undefined {
  if (!net.contract) return undefined;
  return `${net.contract.id}.${net.contract.version}`;
}

/**
 * Operator-facing display name for a joined SolverNet — the registry
 * `name` field if present, otherwise the manifest CID. Mirrors the same
 * resolution the registry uses when registering entries.
 */
export function joinedDisplayName(
  cid: string,
  net: Pick<JoinedSolverNetConfig, 'name'>,
): string {
  return net.name ?? cid;
}

/**
 * Find a joined SolverNet entry by its operator-facing display name. The
 * lookup also matches against the manifest CID so callers that resolve a
 * net by either identifier (legacy short-name or post-join CID) keep
 * working. Returns the matched entry, or `undefined` if no match.
 */
export function findJoinedByName(
  joinedSolverNets: Record<string, JoinedSolverNetConfig> | undefined,
  needle: string,
): JoinedSolverNetConfig | undefined {
  if (!joinedSolverNets) return undefined;
  for (const [cid, entry] of Object.entries(joinedSolverNets)) {
    if (joinedDisplayName(cid, entry) === needle) return entry;
    if (entry.manifestCid === needle) return entry;
  }
  return undefined;
}

function defaultRuntimePluginsForSolverType(solverType: string): SolverPluginEntry[] {
  if (solverType === 'swe-rebench-v2.v1') {
    return ['bundled:swe-rebench-v2-runtime'];
  }
  if (solverType === 'jinn-repo.v1') {
    return ['bundled:jinn-repo-runtime'];
  }
  return [];
}

function defaultPluginDisabled(plugin: SolverPluginEntry, disabled: string[]): boolean {
  if (typeof plugin !== 'string') {
    const name = plugin.name ?? plugin.source;
    return disabled.includes(name) || disabled.includes(plugin.source);
  }
  const bare = plugin.startsWith('bundled:') ? plugin.slice('bundled:'.length) : plugin;
  return disabled.includes(plugin) || disabled.includes(bare);
}

function evaluatorHarnessNameForContract(contract: SolverNetContract): string | undefined {
  const implementation = contract.evaluationFunction.implementation;
  if (implementation.includes('swe-rebench-v2-evaluator')) return 'swe-rebench-v2-evaluator';
  if (implementation.includes('prediction-v1-evaluator')) return 'prediction-v1-evaluator';
  return undefined;
}

function runtimePluginFrom(
  plugin: Awaited<ReturnType<typeof resolveSolverPlugin>>,
  provenance: RuntimePlugin['provenance'],
): RuntimePlugin {
  return {
    name: plugin.name,
    version: plugin.version,
    source: plugin.source,
    sourceKind: plugin.sourceKind,
    solverType: plugin.solverType,
    supports: plugin.supports,
    root: plugin.root,
    manifestPath: plugin.manifestPath,
    sha256: plugin.sha256,
    ...(plugin.cid ? { cid: plugin.cid } : {}),
    provenance,
  };
}

/**
 * A runtime plugin (e.g. Network Tools) declares `supports: ['jinn.runtime']` —
 * it isn't tied to a SolverType, so the supports-includes-solverType check
 * does not apply to it. The manifest validator enforces that no plugin mixes
 * 'jinn.runtime' with SolverType identifiers, so this check cannot be abused
 * by a SolverType plugin claiming runtime status.
 */
function isRuntimePlugin(plugin: Awaited<ReturnType<typeof resolveSolverPlugin>>): boolean {
  return plugin.supports.includes('jinn.runtime');
}

export class SolverNetRegistry {
  private readonly nets = new Map<string, LoadedSolverNet>();

  register(net: LoadedSolverNet): void {
    let key = net.name;
    let suffix = 2;
    while (this.nets.has(key)) {
      key = `${net.name}#${suffix}`;
      suffix += 1;
    }
    this.nets.set(key, net);
  }

  get(name: string): LoadedSolverNet | undefined {
    return this.nets.get(name);
  }

  private matchesTaskRole(net: LoadedSolverNet, taskRole?: SolverNetTaskRole): boolean {
    if (taskRole === undefined) return true;
    return net.roles.some((r) => taskRoleForOperatorRole(r) === taskRole);
  }

  forSolverType(solverType: string, taskRole?: SolverNetTaskRole): LoadedSolverNet | undefined {
    return [...this.nets.values()].find((net) =>
      net.enabled && net.solverType === solverType && this.matchesTaskRole(net, taskRole),
    );
  }

  /**
   * Resolve a joined SolverNet by its manifest CID rather than by
   * `solverType` registration order. Preferred over `forSolverType` whenever
   * the caller has a task's `solverNetManifestCid` in hand — two joined
   * SolverNets can share a `solverType`, and only the manifest CID
   * disambiguates which one a given task is actually pinned to (issue
   * #2039 AC2).
   */
  forManifestCid(manifestCid: string, taskRole?: SolverNetTaskRole): LoadedSolverNet | undefined {
    return [...this.nets.values()].find((net) =>
      net.enabled
      && (net.manifestCid === manifestCid || digestMatchesCid(net.manifestCid, manifestCid))
      && this.matchesTaskRole(net, taskRole),
    );
  }

  list(): LoadedSolverNet[] {
    return [...this.nets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  harnessSelections(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const net of this.nets.values()) {
      if (net.enabled && out[net.solverType] === undefined) out[net.solverType] = net.harness;
    }
    return out;
  }

  claudeModelSelections(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const net of this.nets.values()) {
      if (net.enabled && net.model && out[net.solverType] === undefined) out[net.solverType] = net.model;
    }
    return out;
  }
}

/**
 * Register a single joined SolverNet into `registry`, reproducing exactly the
 * derivation + plugin-resolution the boot loop runs (default-plugin seeding,
 * harness defaulting, role mapping). Called by `loadSolverNets` at boot; the
 * live join applier that used to share it retired in Wave-4 D1.
 *
 * No-ops when the joined entry has no resolvable contract or no roles.
 */
export async function registerJoinedNet(
  registry: SolverNetRegistry,
  cid: string,
  joined: JoinedSolverNetConfig,
): Promise<void> {
  if (!joined.contract) {
    console.warn(
      `[solver-nets] joinedSolverNets[${cid}] missing contract field — entry will not participate in claim flow`,
    );
    return;
  }
  const solverType = `${joined.contract.id}.${joined.contract.version}`;
  const contract = getSolverNetContract(joined.contract);
  if (!contract) {
    console.warn(
      `[solver-nets] joinedSolverNets[${cid}] contract ${solverType} did not resolve to a known SolverNet — entry will not participate in claim flow`,
    );
    return;
  }
  const roles = rolesFromJoinedConfig(joined);
  if (roles.length === 0) return;
  const disabledDefaults = joined.disabledDefaultPlugins ?? [];
  const defaultPlugins = defaultRuntimePluginsForSolverType(solverType)
    .filter((plugin) => !defaultPluginDisabled(plugin, disabledDefaults));
  const harness = joined.roles.includes('solver')
    ? joined.harness ?? CLAUDE_CODE_HARNESS
    : evaluatorHarnessNameForContract(contract) ?? joined.harness ?? CLAUDE_CODE_HARNESS;

  const net: SolverNetConfig = {
    enabled: true,
    solverType,
    roles,
    harness,
    ...(joined.model ? { model: joined.model } : {}),
    ...(joined.provider !== undefined ? { provider: joined.provider } : {}),
    plugins: [...defaultPlugins, ...(joined.plugins ?? [])],
    taskGenerator: { enabled: false },
  };
  const name = joined.name ?? cid;

  if (!net.enabled) return;
  const runtimePlugins: RuntimePlugin[] = [];
  const seenSources = new Set<string>();
  const seenNames = new Set<string>();

  async function addRuntimePlugin(
    entry: SolverPluginEntry,
    provenance: RuntimePlugin['provenance'],
  ): Promise<void> {
    const plugin = await resolveSolverPlugin(entry);
    if (seenSources.has(plugin.source) || seenNames.has(plugin.name)) return;
    if (!isRuntimePlugin(plugin) && !plugin.supports.includes(net.solverType)) {
      throw new Error(
        `SolverNet ${name} runtime plugin ${plugin.name} solverType mismatch: config=${net.solverType} plugin supports=${plugin.supports.join(',')}`,
      );
    }
    runtimePlugins.push(runtimePluginFrom(plugin, provenance));
    seenSources.add(plugin.source);
    seenNames.add(plugin.name);
  }

  // Per `spec/2026-05-05-solvernet-creation-and-launch.md` §8/§9, runtime
  // plugins are operator-configured — the SolverNet contract no longer
  // carries `defaultRuntimePlugins`. Network Tools is the one runtime-
  // scoped default (`supports: ['jinn.runtime']`) auto-loaded so every
  // operator's daemon can talk to the Jinn MCP surface. SolverType-bound
  // plugins (e.g. the bundled prediction plugin) flow through
  // `net.plugins`; the launcher seeds quick-start defaults into operator
  // config rather than binding them to the contract.
  for (const entry of [JINN_NETWORK_TOOLS_PLUGIN]) {
    await addRuntimePlugin(entry, 'default');
  }
  for (const entry of net.plugins ?? []) {
    await addRuntimePlugin(entry, 'configured');
  }
  registry.register({
    name,
    manifestCid: cid,
    enabled: net.enabled,
    solverType: net.solverType,
    roles: rolesFromConfig(net),
    contract,
    harness: canonicalHarnessName(net.harness),
    ...(net.model ? { model: net.model } : {}),
    ...(net.provider !== undefined ? { provider: net.provider } : {}),
    runtimePlugins,
    taskGenerator: net.taskGenerator,
  });
}

export async function registerWiringEntry(
  registry: SolverNetRegistry,
  entry: ExecutionWiringConfigEntry,
): Promise<void> {
  const contractRef = contractRefFromWorkKind(entry.workKind);
  if (!contractRef) {
    console.warn(
      `[solver-nets] executionWiring workKind ${entry.workKind} did not resolve to a known SolverNet — entry will not participate in claim flow`,
    );
    return;
  }
  await registerJoinedNet(registry, entry.legacyManifestDigest ?? entry.workKind, {
    manifestCid: entry.legacyManifestDigest ?? entry.workKind,
    name: entry.workKind,
    contract: contractRef,
    roles: ['solver'],
    harness: entry.harness,
    model: entry.model,
    plugins: [...entry.plugins],
  });
}

export interface LoadSolverNetsOptions {
  /**
   * Run one-shot vendor cleanup for legacy bundled/local copies. Only the
   * daemon boot path opts in — eval/UX helpers call loadSolverNets with a
   * partial wiring slice and must not GC remote materializations (#1242).
   */
  gcOrphanedVendorCopies?: boolean;
  /**
   * Vendor root the cleanup targets. Defaults to
   * `defaultSolverPluginVendorRoot()` — the operator's real
   * `~/.jinn-operator/solver-plugins`. Tests must pass a temp directory so no
   * test run can resolve, let alone delete inside, the default root.
   */
  vendorRoot?: string;
}

export async function loadSolverNets(
  config: {
    executionWiring?: readonly ExecutionWiringConfigEntry[];
  },
  opts: LoadSolverNetsOptions = {},
): Promise<SolverNetRegistry> {
  if (opts.gcOrphanedVendorCopies) {
    const pluginEntriesForGc: SolverPluginEntry[] = [JINN_NETWORK_TOOLS_PLUGIN];
    for (const wiring of config.executionWiring ?? []) {
      pluginEntriesForGc.push(...wiring.plugins);
      const contractRef = contractRefFromWorkKind(wiring.workKind);
      if (contractRef) {
        const solverType = `${contractRef.id}.${contractRef.version}`;
        pluginEntriesForGc.push(...defaultRuntimePluginsForSolverType(solverType));
      }
    }
    gcOrphanedBundledLocalVendorCopies(
      opts.vendorRoot ?? defaultSolverPluginVendorRoot(),
      remoteVendorNamesFromEntries(pluginEntriesForGc),
    );
  }

  const registry = new SolverNetRegistry();
  for (const entry of config.executionWiring ?? []) {
    await registerWiringEntry(registry, entry);
  }

  return registry;
}
