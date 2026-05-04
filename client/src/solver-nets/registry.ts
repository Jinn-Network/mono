import { resolveSolverPlugin } from '../plugins/index.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import type { RuntimePlugin } from '../harnesses/types.js';
import { getSolverNetContract, type SolverNetContract } from './contracts.js';

export const JINN_NETWORK_TOOLS_PLUGIN = 'bundled:network-tools' as const;

export interface SolverNetConfig {
  enabled: boolean;
  solverType: string;
  harness: string;
  plugins: SolverPluginEntry[];
  taskGenerator: { enabled: boolean };
}

export interface LoadedSolverNet {
  name: string;
  enabled: boolean;
  solverType: string;
  contract: SolverNetContract;
  harness: string;
  runtimePlugins: RuntimePlugin[];
  taskGenerator: { enabled: boolean };
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
    this.nets.set(net.name, net);
  }

  get(name: string): LoadedSolverNet | undefined {
    return this.nets.get(name);
  }

  forSolverType(solverType: string): LoadedSolverNet | undefined {
    return [...this.nets.values()].find((net) =>
      net.enabled && net.solverType === solverType,
    );
  }

  list(): LoadedSolverNet[] {
    return [...this.nets.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  harnessSelections(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const net of this.nets.values()) {
      if (net.enabled) out[net.solverType] = net.harness;
    }
    return out;
  }
}

export async function loadSolverNets(
  config: { solverNets: Record<string, SolverNetConfig> },
): Promise<SolverNetRegistry> {
  const registry = new SolverNetRegistry();
  for (const [name, net] of Object.entries(config.solverNets)) {
    if (!net.enabled) continue;
    const contract = getSolverNetContract(net.solverType);
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

    for (const entry of [JINN_NETWORK_TOOLS_PLUGIN, ...contract.defaultRuntimePlugins]) {
      await addRuntimePlugin(entry, 'default');
    }
    for (const entry of net.plugins ?? []) {
      await addRuntimePlugin(entry, 'configured');
    }
    registry.register({
      name,
      enabled: net.enabled,
      solverType: net.solverType,
      contract,
      harness: net.harness,
      runtimePlugins,
      taskGenerator: net.taskGenerator,
    });
  }
  return registry;
}
