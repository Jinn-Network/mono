import type { LoadedSolverPlugin, SolverPluginEntry, ResolveSolverPluginOptions } from './types.js';
import { resolveSolverPlugin } from './resolvers.js';

export class SolverPluginRegistry {
  private readonly plugins = new Map<string, LoadedSolverPlugin>();

  register(plugin: LoadedSolverPlugin): void {
    this.plugins.set(plugin.name, plugin);
  }

  get(name: string): LoadedSolverPlugin | undefined {
    return this.plugins.get(name);
  }

  forSolverType(solverType: string): LoadedSolverPlugin[] {
    return [...this.plugins.values()].filter((plugin) => plugin.supports.includes(solverType));
  }

  list(): LoadedSolverPlugin[] {
    return [...this.plugins.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

export async function loadSolverPlugins(
  entries: readonly SolverPluginEntry[],
  opts: ResolveSolverPluginOptions = {},
): Promise<SolverPluginRegistry> {
  const registry = new SolverPluginRegistry();
  for (const entry of entries) {
    registry.register(await resolveSolverPlugin(entry, opts));
  }
  return registry;
}
