import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const STACK_ROOTS = [
  'packages/benchmarking',
  'packages/discovery',
  'packages/evidence',
  'packages/marketplace',
  'packages/task-execution',
  'packages/trust',
];

const SCOPE = '@jinn-network/';

function toPosix(value) {
  return value.split(sep).join('/');
}

function manifestPaths(absoluteDir, relativeDir, found) {
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const childAbsolute = join(absoluteDir, entry.name);
    const childRelative = `${relativeDir}/${entry.name}`;
    const childManifest = join(childAbsolute, 'package.json');
    let isFile = false;
    try {
      isFile = statSync(childManifest).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) found.push({ directory: childRelative, manifestPath: childManifest });
    manifestPaths(childAbsolute, childRelative, found);
  }
  return found;
}

export function discoverStackPackages(repoRoot) {
  const root = resolve(repoRoot);
  const located = [];
  for (const stackRoot of STACK_ROOTS) {
    manifestPaths(join(root, ...stackRoot.split('/')), stackRoot, located);
  }
  const packages = located.map(({ directory, manifestPath }) => {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(`${directory}: cannot read package.json: ${error?.message ?? String(error)}`);
    }
    if (typeof manifest.name !== 'string' || !manifest.name.startsWith(SCOPE)) {
      throw new Error(`${directory}: platform packages must be named under ${SCOPE}, got ${manifest.name ?? '<missing>'}`);
    }
    if (manifest.publishConfig?.access !== 'public') {
      throw new Error(`${directory}: platform packages must declare publishConfig.access "public"`);
    }
    return { directory: toPosix(directory), name: manifest.name, manifest, manifestPath };
  });
  packages.sort((left, right) => (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));
  const seen = new Set();
  for (const pkg of packages) {
    if (seen.has(pkg.name)) throw new Error(`duplicate platform package name ${pkg.name}`);
    seen.add(pkg.name);
  }
  return packages;
}
