import {
  RUNTIME_DEPENDENCY_SECTIONS,
  loadCatalogPackages,
} from './platform-catalog.mjs';

// Publish-manifest rewriting and validation still inspect every npm dependency
// section. Graph construction below deliberately uses only the catalog's runtime
// sections so dev-only relationships never affect publication order.
export const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

export function discoverStackPackages(repoRoot, { releaseGroup = 'platform-v1' } = {}) {
  return loadCatalogPackages(repoRoot, { releaseGroup }).map(({
    directory,
    name,
    manifest,
    manifestPath,
  }) => ({ directory, name, manifest, manifestPath }));
}

export function buildDependencyGraph(packages) {
  const names = new Set(packages.map((pkg) => pkg.name));
  const graph = new Map();
  for (const pkg of packages) {
    const edges = new Set();
    for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
      for (const dependency of Object.keys(pkg.manifest?.[section] ?? {})) {
        if (dependency !== pkg.name && names.has(dependency)) edges.add(dependency);
      }
    }
    graph.set(pkg.name, edges);
  }
  return graph;
}

export function topologicalWaves(graph) {
  const remaining = new Set(graph.keys());
  const waves = [];
  while (remaining.size > 0) {
    const wave = [...remaining]
      .filter((name) => [...graph.get(name)].every((dependency) => !remaining.has(dependency)))
      .sort();
    if (wave.length === 0) {
      throw new Error(`dependency cycle among platform packages: ${[...remaining].sort().join(', ')}`);
    }
    for (const name of wave) remaining.delete(name);
    waves.push(wave);
  }
  return waves;
}
