import type { JinnConfig } from '../config.js';
import { resolveSolverPlugin } from '../plugins/index.js';
import type { SolverPluginEntry } from '../plugins/types.js';
import type { RuntimePlugin } from '../harnesses/types.js';

export interface SolverNetConfig {
  enabled: boolean;
  solverType: string;
  canonicalPlugin: SolverPluginEntry;
  harness: string;
  plugins: SolverPluginEntry[];
  taskGenerator: { enabled: boolean };
}

export interface LoadedSolverNet {
  name: string;
  enabled: boolean;
  solverType: string;
  harness: string;
  canonicalPlugin: RuntimePlugin;
  plugins: RuntimePlugin[];
  taskGenerator: { enabled: boolean };
}

function runtimePluginFrom(
  plugin: Awaited<ReturnType<typeof resolveSolverPlugin>>,
  role: RuntimePlugin['role'],
): RuntimePlugin {
  return {
    name: plugin.name,
    version: plugin.version,
    solverType: plugin.solverType,
    root: plugin.root,
    manifestPath: plugin.manifestPath,
    sha256: plugin.sha256,
    ...(plugin.cid ? { cid: plugin.cid } : {}),
    role,
  };
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
    const canonical = await resolveSolverPlugin(net.canonicalPlugin);
    if (canonical.solverType !== net.solverType) {
      throw new Error(
        `SolverNet ${name} solverType mismatch: config=${net.solverType} plugin=${canonical.solverType}`,
      );
    }
    const extras = [];
    for (const entry of net.plugins) {
      const plugin = await resolveSolverPlugin(entry);
      if (plugin.solverType !== net.solverType) {
        throw new Error(
          `SolverNet ${name} extra plugin ${plugin.name} solverType mismatch: config=${net.solverType} plugin=${plugin.solverType}`,
        );
      }
      extras.push(runtimePluginFrom(plugin, 'extra'));
    }
    registry.register({
      name,
      enabled: net.enabled,
      solverType: net.solverType,
      harness: net.harness,
      canonicalPlugin: runtimePluginFrom(canonical, 'canonical'),
      plugins: extras,
      taskGenerator: net.taskGenerator,
    });
  }
  return registry;
}
