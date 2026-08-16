// Decides whether a pull request needs platform verification to run.
//
// `platform-verification.yml` fans into the union of stack-published domain lanes
// through `workflow_call`, and GitHub does not evaluate `paths:` filters for
// `workflow_call` invocations. Every pull request therefore pays for those lanes
// regardless of what changed.
//
// Selection is computed from the dependency closure of the changed packages, not
// from their catalog `domain` label: the catalog carries hundreds of cross-domain
// edges (for example `packages/discovery/facts/evidence` consumes
// `@jinn-network/evidence-discovery`), so a label-only gate would skip lanes that
// must run.
//
// The default is fail-safe. A changed path that maps to no catalogued package and
// is not explicitly ignorable selects every lane.

import { resolve } from 'node:path';
import { loadCatalogPackages, loadPlatformCatalog, RUNTIME_DEPENDENCY_SECTIONS, stackPublishedReleaseGroupIds } from './platform-catalog.mjs';

export const GATE_DOMAINS = new Map([
  ['benchmarking-ci', 'benchmarking'],
  ['environments-ci', 'environments'],
  ['evidence-ci', 'evidence'],
  ['marketplace-ci', 'marketplace'],
  ['record-discovery-ci', 'discovery'],
  ['task-execution-ci', 'task-execution'],
  ['task-supply-ci', 'task-supply'],
  ['trust-ci', 'trust'],
]);

// Sections whose entries mean "a change here can change this package's build or tests".
const DEPENDENCY_SECTIONS = [...RUNTIME_DEPENDENCY_SECTIONS, 'devDependencies'];

// Changes here alter how verification runs, or what it claims to verify.
export const GLOBAL_SELECTORS = [
  '.github/',
  'architecture/platform-packages.v1.json',
  'architecture/platform-packages.schema.json',
];

// Changes here cannot affect any catalogued package's build or tests. Generated
// architecture output is excluded because `generate-architecture.mjs --check`
// already guards it in the always-on `platform-architecture-control` job.
export const IGNORABLE_PREFIXES = [
  '.agents/',
  '.beads/',
  '.claude/',
  '.codex/',
  '.cursor/',
  'architecture/generated/',
  'docs/',
  'growth/',
  'legacy/',
  'log/',
  'spec/',
];

function isUnder(path, prefix) {
  if (prefix.endsWith('/')) return path.startsWith(prefix);
  return path === prefix;
}

function requireGateCoverage(repoRoot) {
  const catalog = loadPlatformCatalog(repoRoot);
  const declared = [...new Set(
    stackPublishedReleaseGroupIds(catalog)
      .flatMap((groupId) => catalog.releaseGroups[groupId].requiredGateIds),
  )].sort();
  const mapped = [...GATE_DOMAINS.keys()].sort();
  if (declared.join(',') !== mapped.join(',')) {
    throw new Error(
      `GATE_DOMAINS does not cover stack-published requiredGateIds: declared=${declared.join(',')} mapped=${mapped.join(',')}`,
    );
  }
  return new Set(mapped.map((gateId) => GATE_DOMAINS.get(gateId)));
}

/**
 * Build `name -> directory` and `directory -> dependents` for the catalogued packages.
 */
function buildGraph(repoRoot) {
  const packages = loadCatalogPackages(repoRoot);
  const directoryByName = new Map();
  for (const pkg of packages) directoryByName.set(pkg.name, pkg.directory);

  const dependents = new Map();
  for (const pkg of packages) dependents.set(pkg.directory, new Set());

  for (const pkg of packages) {
    for (const section of DEPENDENCY_SECTIONS) {
      for (const dependencyName of Object.keys(pkg.manifest?.[section] ?? {})) {
        const dependencyDirectory = directoryByName.get(dependencyName);
        // A change to `dependencyDirectory` can break `pkg`, so `pkg` depends on it.
        if (dependencyDirectory !== undefined && dependencyDirectory !== pkg.directory) {
          dependents.get(dependencyDirectory).add(pkg.directory);
        }
      }
    }
  }

  return { packages, dependents };
}

/**
 * Longest matching catalog path wins: both `client` and `client/src/dashboard/spa`
 * are catalogued, and a change under the latter must not be attributed to the former.
 */
function matchPackage(changedPath, packages) {
  let matched;
  for (const pkg of packages) {
    if (changedPath === pkg.directory || changedPath.startsWith(`${pkg.directory}/`)) {
      if (matched === undefined || pkg.directory.length > matched.directory.length) matched = pkg;
    }
  }
  return matched;
}

/**
 * @param {{ repoRoot: string, changedFiles: string[] }} input
 * @returns {{ run: boolean, reason: string, selectedDomains: string[], unmatchedPaths: string[] }}
 */
export function selectVerification({ repoRoot, changedFiles }) {
  if (!Array.isArray(changedFiles)) throw new Error('changedFiles must be an array');
  const root = resolve(repoRoot);
  const laneDomains = requireGateCoverage(root);

  // No changed files reported means we cannot prove the change is irrelevant.
  if (changedFiles.length === 0) {
    return { run: true, reason: 'no changed files reported', selectedDomains: [...laneDomains].sort(), unmatchedPaths: [] };
  }

  const normalized = changedFiles.map((path) => path.trim()).filter((path) => path !== '');

  for (const path of normalized) {
    for (const selector of GLOBAL_SELECTORS) {
      if (isUnder(path, selector)) {
        return {
          run: true,
          reason: `global selector ${selector} matched ${path}`,
          selectedDomains: [...laneDomains].sort(),
          unmatchedPaths: [],
        };
      }
    }
  }

  const { packages, dependents } = buildGraph(root);
  const changedDirectories = new Set();
  const unmatchedPaths = [];

  for (const path of normalized) {
    const matched = matchPackage(path, packages);
    if (matched !== undefined) {
      changedDirectories.add(matched.directory);
      continue;
    }
    if (IGNORABLE_PREFIXES.some((prefix) => isUnder(path, prefix))) continue;
    unmatchedPaths.push(path);
  }

  // Fail-safe: an unrecognised path could belong to anything.
  if (unmatchedPaths.length > 0) {
    return {
      run: true,
      reason: `unmatched paths default to full verification: ${unmatchedPaths.slice(0, 5).join(', ')}`,
      selectedDomains: [...laneDomains].sort(),
      unmatchedPaths,
    };
  }

  // Transitive dependents: a change to a package can break everything that consumes it.
  const affected = new Set(changedDirectories);
  const queue = [...changedDirectories];
  while (queue.length > 0) {
    const directory = queue.pop();
    for (const dependent of dependents.get(directory) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const domainByDirectory = new Map(packages.map((pkg) => [pkg.directory, pkg.catalog.domain]));
  const selectedDomains = new Set();
  for (const directory of affected) {
    const domain = domainByDirectory.get(directory);
    if (domain !== undefined && laneDomains.has(domain)) selectedDomains.add(domain);
  }

  const sorted = [...selectedDomains].sort();
  return {
    run: sorted.length > 0,
    reason: sorted.length > 0
      ? `affected lane domains: ${sorted.join(', ')}`
      : 'no changed package reaches a verified lane domain',
    selectedDomains: sorted,
    unmatchedPaths: [],
  };
}

function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd(), changedFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--repo-root') {
      if (value === undefined) throw new Error('--repo-root requires a value');
      parsed.repoRoot = value;
      index += 1;
    } else if (flag === '--changed-file') {
      if (value === undefined) throw new Error('--changed-file requires a value');
      parsed.changedFiles.push(value);
      index += 1;
    } else {
      throw new Error(`unknown flag ${flag}`);
    }
  }
  return parsed;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const { repoRoot, changedFiles } = parseArgs(process.argv.slice(2));
  // stdin is the normal path: `git diff --name-only base...head | node this-script.mjs`
  const stdinFiles = process.stdin.isTTY
    ? []
    : (await new Promise((resolveInput) => {
      let buffer = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => { buffer += chunk; });
      process.stdin.on('end', () => resolveInput(buffer));
    })).split('\n');

  const result = selectVerification({ repoRoot, changedFiles: [...changedFiles, ...stdinFiles] });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
