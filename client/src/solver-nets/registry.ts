import type { JinnConfig } from '../config.js';
import { resolveSolverPlugin } from '../plugins/index.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import type { RuntimePlugin } from '../harnesses/types.js';
import { getSolverNetContract, type SolverNetContract } from './contracts.js';

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
  plugins: RuntimePlugin[];
  taskGenerator: { enabled: boolean };
}

function runtimePluginFrom(plugin: Awaited<ReturnType<typeof resolveSolverPlugin>>): RuntimePlugin {
  return {
    name: plugin.name,
    version: plugin.version,
    supports: plugin.supports,
    root: plugin.root,
    manifestPath: plugin.manifestPath,
    sha256: plugin.sha256,
    ...(plugin.cid ? { cid: plugin.cid } : {}),
  };
}

function assertPluginSupportsSolverNet(
  netName: string,
  solverType: string,
  plugin: Awaited<ReturnType<typeof resolveSolverPlugin>>,
): void {
  if (plugin.supports.length > 0 && !plugin.supports.includes(solverType)) {
    throw new Error(
      `SolverNet ${netName} plugin ${plugin.name} does not support ${solverType}; supports=${plugin.supports.join(',')}`,
    );
  }
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
    return [...this.nets.values()].find((net) => net.enabled && net.solverType === solverType);
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
  config: Pick<JinnConfig, 'solverNets'>,
): Promise<SolverNetRegistry> {
  const registry = new SolverNetRegistry();
  for (const [name, net] of Object.entries(config.solverNets)) {
    if (!net.enabled) continue;
    const contract = getSolverNetContract(net.solverType);
    if (!contract) {
      throw new Error(`SolverNet ${name} has no registered SolverNetContract for solverType ${net.solverType}`);
    }
    const extras = [];
    for (const entry of net.plugins) {
      const plugin = await resolveSolverPlugin(entry);
      assertPluginSupportsSolverNet(name, net.solverType, plugin);
      extras.push(runtimePluginFrom(plugin));
    }
    registry.register({
      name,
      enabled: net.enabled,
      solverType: net.solverType,
      contract,
      harness: net.harness,
      plugins: extras,
      taskGenerator: net.taskGenerator,
    });
  }
  return registry;
}
