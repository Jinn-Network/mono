import { resolveSolverPlugin } from '../plugins/index.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import type { RuntimePlugin } from '../harnesses/types.js';
import { canonicalHarnessName, CLAUDE_CODE_HARNESS } from '../harnesses/names.js';
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
  plugins?: SolverPluginEntry[];
  disabledDefaultPlugins?: string[];
}

export interface LoadedSolverNet {
  name: string;
  enabled: boolean;
  solverType: string;
  /** Active operator roles (non-empty after load). */
  roles: SolverNetOperatorRole[];
  contract: SolverNetContract;
  harness: string;
  model?: string;
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

function rolesFromJoinedConfig(net: JoinedSolverNetConfig): SolverNetOperatorRole[] {
  const roles: SolverNetOperatorRole[] = [];
  for (const role of net.roles) {
    if (role === 'solver') roles.push('solving');
    if (role === 'evaluator') roles.push('evaluating');
  }
  return Array.from(new Set(roles));
}

function defaultRuntimePluginsForSolverType(solverType: string): SolverPluginEntry[] {
  if (solverType === 'swe-rebench-v2.v1') {
    return ['bundled:swe-rebench-v2-runtime'];
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

  forSolverType(solverType: string, taskRole?: SolverNetTaskRole): LoadedSolverNet | undefined {
    return [...this.nets.values()].find((net) =>
      net.enabled &&
      net.solverType === solverType &&
      (taskRole === undefined ||
        net.roles.some((r) => {
          const tr = taskRoleForOperatorRole(r);
          return tr !== undefined && tr === taskRole;
        })),
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
 * Parse the legacy operator-config `solverType` string (`'<id>.<version>'`)
 * into a `{ id, version }` ref so we can call the contract registry's
 * non-deprecated lookup signature. The operator config field itself is
 * carried forward for now (Task 8 of
 * `spec/2026-05-05-solvernet-creation-and-launch.md` — internal dispatch
 * keeps `solverType` as a routing alias; Task 30 removes it).
 */
function parseSolverTypeRef(solverType: string): { id: string; version: string } | undefined {
  const dot = solverType.lastIndexOf('.');
  if (dot <= 0 || dot === solverType.length - 1) return undefined;
  return { id: solverType.slice(0, dot), version: solverType.slice(dot + 1) };
}

export async function loadSolverNets(
  config: {
    solverNets: Record<string, SolverNetConfig>;
    joinedSolverNets?: Record<string, JoinedSolverNetConfig>;
  },
): Promise<SolverNetRegistry> {
  const registry = new SolverNetRegistry();
  async function registerFromConfig(name: string, net: SolverNetConfig): Promise<void> {
    if (!net.enabled) return;
    const ref = parseSolverTypeRef(net.solverType);
    const contract = ref ? getSolverNetContract(ref) : undefined;
    if (!contract) {
      throw new Error(`SolverNet ${name} has no registered SolverNetContract for ${net.solverType}`);
    }
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
      enabled: net.enabled,
      solverType: net.solverType,
      roles: rolesFromConfig(net),
      contract,
      harness: canonicalHarnessName(net.harness),
      ...(net.model ? { model: net.model } : {}),
      runtimePlugins,
      taskGenerator: net.taskGenerator,
    });
  }

  for (const [cid, joined] of Object.entries(config.joinedSolverNets ?? {})) {
    if (!joined.contract) continue;
    const solverType = `${joined.contract.id}.${joined.contract.version}`;
    const contract = getSolverNetContract(joined.contract);
    if (!contract) continue;
    const roles = rolesFromJoinedConfig(joined);
    if (roles.length === 0) continue;
    const disabledDefaults = joined.disabledDefaultPlugins ?? [];
    const defaultPlugins = defaultRuntimePluginsForSolverType(solverType)
      .filter((plugin) => !defaultPluginDisabled(plugin, disabledDefaults));
    const harness = joined.roles.includes('solver')
      ? joined.harness ?? CLAUDE_CODE_HARNESS
      : evaluatorHarnessNameForContract(contract) ?? joined.harness ?? CLAUDE_CODE_HARNESS;
    await registerFromConfig(joined.name ?? cid, {
      enabled: true,
      solverType,
      roles,
      harness,
      ...(joined.model ? { model: joined.model } : {}),
      plugins: [...defaultPlugins, ...(joined.plugins ?? [])],
      taskGenerator: { enabled: false },
    });
  }

  for (const [name, net] of Object.entries(config.solverNets)) {
    await registerFromConfig(name, net);
  }
  return registry;
}
