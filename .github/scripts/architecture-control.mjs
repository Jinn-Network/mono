#!/usr/bin/env node

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlatformCatalog } from './platform-catalog.mjs';
import { enumeratePublicSurfaceAssets } from './public-surface-assets.mjs';
import {
  repositoryCandidateFiles,
  repositoryCandidateInventory,
} from './repository-candidates.mjs';

export { resolveConformanceSources } from './public-surface-assets.mjs';
export { repositoryCandidateFiles } from './repository-candidates.mjs';

export const REQUIRED_ARCHITECTURE_OWNERS = ['@oaksprout', '@ritsukai'];
const USERNAME = /^@[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/u;
const SURFACE_DIRECTORIES = new Set([
  'schema', 'schemas', 'profile', 'profiles', 'fixture', 'fixtures',
  'conformance', 'test', 'tests', 'testing',
]);
const EXCLUDED_DIRECTORIES = new Set([
  '.git', '.yarn', 'build', 'coverage', 'dist', 'generated', 'node_modules',
]);
const STATIC_CONTROL = [
  ['architecture', 'staticControl'],
  ['architecture/platform-packages.v1.json', 'catalogSchema'],
  ['architecture/platform-packages.schema.json', 'catalogSchema'],
  ['docs/superpowers/specs', 'staticControl'],
  ['contracts', 'staticControl'],
  ['.github/scripts', 'staticControl'],
  ['.github/workflows', 'staticControl'],
  ['.github/CODEOWNERS', 'staticControl'],
  ['packages/marketplace/binding', 'marketplaceControl'],
  ['packages/marketplace/testing', 'marketplaceControl'],
];

function sameOwnerSet(left, right) {
  return Array.isArray(left)
    && left.length === right.length
    && new Set(left).size === left.length
    && right.every((owner) => left.includes(owner));
}

function escapeRegex(character) {
  return /[\\^$+?.()|{}[\]]/u.test(character) ? `\\${character}` : character;
}

function compilePattern(pattern, line) {
  if (!pattern.startsWith('/')) throw new Error(`CODEOWNERS line ${line}: patterns must be root-anchored`);
  if (pattern.includes('!') || pattern.includes('[') || pattern.includes(']') || pattern.includes('\\') || pattern.includes('?')) {
    throw new Error(`CODEOWNERS line ${line}: unsupported pattern ${pattern}`);
  }
  const directory = pattern.endsWith('/');
  const body = pattern.slice(1, directory ? -1 : undefined);
  if (body === '' || body.includes('//')) throw new Error(`CODEOWNERS line ${line}: malformed pattern ${pattern}`);
  let source = '';
  for (let index = 0; index < body.length;) {
    if (body[index] !== '*') {
      source += escapeRegex(body[index]);
      index += 1;
      continue;
    }
    let end = index;
    while (body[end] === '*') end += 1;
    const width = end - index;
    if (width > 2) throw new Error(`CODEOWNERS line ${line}: unsupported star sequence in ${pattern}`);
    if (width === 1) {
      source += '[^/]*';
    } else if (body[end] === '/') {
      source += '(?:.*/)?';
      end += 1;
    } else {
      source += '.*';
    }
    index = end;
  }
  return new RegExp(`^${source}${directory ? '(?:/.*)?' : ''}$`, 'u');
}

export function parseCodeowners(source) {
  if (typeof source !== 'string') throw new Error('CODEOWNERS source must be text');
  const rules = [];
  for (const [index, raw] of source.split(/\r?\n/u).entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.includes('#')) throw new Error(`CODEOWNERS line ${index + 1}: inline comments are unsupported`);
    const fields = line.split(/\s+/u);
    const [pattern, ...owners] = fields;
    if (owners.length === 0) throw new Error(`CODEOWNERS line ${index + 1}: at least one owner is required`);
    if (new Set(owners).size !== owners.length || owners.some((owner) => !USERNAME.test(owner))) {
      throw new Error(`CODEOWNERS line ${index + 1}: owners must be unique GitHub usernames`);
    }
    rules.push({ pattern, owners, matcher: compilePattern(pattern, index + 1), line: index + 1 });
  }
  if (rules.length === 0) throw new Error('CODEOWNERS contains no supported rules');
  return rules;
}

export function effectiveOwners(rules, repositoryPath) {
  const normalized = repositoryPath.replace(/^\/+|\/+$/gu, '');
  let owners = [];
  for (const rule of rules) {
    if (rule.matcher.test(normalized)) owners = [...rule.owners];
  }
  return owners;
}

function assertUsernameGroups(catalog) {
  for (const [group, owners] of Object.entries(catalog.ownerGroups)) {
    for (const owner of owners) {
      if (!USERNAME.test(owner)) throw new Error(`ownerGroups.${group} has invalid GitHub username ${owner}`);
    }
  }
  const actual = catalog.ownerGroups['architecture-control'];
  if (!sameOwnerSet(actual, REQUIRED_ARCHITECTURE_OWNERS)) {
    throw new Error(`ownerGroups.architecture-control must be exactly ${REQUIRED_ARCHITECTURE_OWNERS.join(' ')}`);
  }
  for (const pkg of catalog.packages) {
    if (!Object.hasOwn(catalog.ownerGroups, pkg.ownerGroup)) throw new Error(`${pkg.name}: unresolved owner group ${pkg.ownerGroup}`);
  }
}

function normalizeRelative(packagePath, surfacePath) {
  const clean = surfacePath.replace(/^\.\//u, '');
  return clean === '.' || clean === '' ? packagePath : `${packagePath}/${clean}`;
}

function addPath(paths, repositoryPath, category, repoRoot, { mustExist = true } = {}) {
  const normalized = repositoryPath.replace(/^\/+|\/+$/gu, '');
  const absolute = resolve(repoRoot, ...normalized.split('/'));
  if (mustExist && !existsSync(absolute)) throw new Error(`${category} path does not exist: ${normalized}`);
  const categories = paths.get(normalized) ?? new Set();
  categories.add(category);
  paths.set(normalized, categories);
}

function hasExcludedComponent(path, root) {
  const relativePath = path === root ? '' : path.slice(root.length + 1);
  return relativePath.split('/').some((component) => EXCLUDED_DIRECTORIES.has(component));
}

function addTree(paths, repositoryPath, category, repoRoot, inventory) {
  addPath(paths, repositoryPath, category, repoRoot);
  const normalized = repositoryPath.replace(/^\/+|\/+$/gu, '');
  const absolute = resolve(repoRoot, ...normalized.split('/'));
  if (!statSync(absolute).isDirectory()) return;
  for (const directory of inventory.directories) {
    if (directory.startsWith(`${normalized}/`) && !hasExcludedComponent(directory, normalized)) {
      addPath(paths, directory, category, repoRoot);
    }
  }
  for (const file of inventory.files) {
    if (file.startsWith(`${normalized}/`) && !hasExcludedComponent(file, normalized)) {
      addPath(paths, file, category, repoRoot);
    }
  }
}

function discoverSurfaceDirectories(repoRoot, packagePath, paths, inventory) {
  for (const directory of inventory.directories) {
    if (!directory.startsWith(`${packagePath}/`) || hasExcludedComponent(directory, packagePath)) {
      continue;
    }
    const name = directory.split('/').at(-1);
    if (SURFACE_DIRECTORIES.has(name) || name.includes('conformance')) {
      addTree(paths, directory, 'discoveredFirstPartySurfaces', repoRoot, inventory);
    }
  }
}

function discoverGeneratorSources(repoRoot, pkg, paths, inventory) {
  const manifestPath = resolve(repoRoot, ...pkg.path.split('/'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  for (const command of Object.values(manifest.scripts ?? {})) {
    for (const match of command.matchAll(
      /(?:^|\s)(?:node|tsx|bun)\s+(?:(?:--?[A-Za-z0-9-]+(?:=[^\s]+)?)\s+)*([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts))(?:\s|$)/gu,
    )) {
      const candidate = normalizeRelative(pkg.path, match[1]);
      if (!candidate.split('/').some((component) => EXCLUDED_DIRECTORIES.has(component))
        && inventory.files.includes(candidate)) {
        addTree(
          paths,
          dirname(candidate).split('\\').join('/'),
          'generatorSources',
          repoRoot,
          inventory,
        );
      }
    }
  }
  for (const directory of inventory.directories) {
    if (directory.startsWith(`${pkg.path}/`)
      && directory.split('/').at(-1) === 'scripts'
      && !hasExcludedComponent(directory, pkg.path)) {
      addTree(paths, directory, 'generatorSources', repoRoot, inventory);
    }
  }
}

export function enumerateArchitectureControlPaths(repoRoot, catalog, { candidateFiles } = {}) {
  const inventory = repositoryCandidateInventory(repoRoot, { candidateFiles });
  const paths = new Map();
  for (const [path, category] of STATIC_CONTROL) addPath(paths, path, category, repoRoot);
  for (const gate of Object.values(catalog.gateDefinitions)) {
    addPath(paths, gate.path, 'requiredGates', repoRoot);
  }
  const packages = catalog.packages.map((pkg) => ({
    name: pkg.name,
    directory: pkg.path,
    catalog: pkg,
    manifest: JSON.parse(readFileSync(resolve(repoRoot, ...pkg.path.split('/'), 'package.json'), 'utf8')),
  }));
  const publicAssets = enumeratePublicSurfaceAssets({
    repoRoot,
    packages,
    candidateFiles: inventory.files,
  });
  for (const hydrated of packages) {
    const { catalog: pkg } = hydrated;
    addPath(paths, `${pkg.path}/package.json`, 'catalogManifests', repoRoot);
    for (const document of pkg.authority.documents) addPath(paths, document.path, 'authorityDocuments', repoRoot);
    if (pkg.authority.decisionRecord) addPath(paths, pkg.authority.decisionRecord.path, 'decisionRecords', repoRoot);
    addPath(paths, pkg.boundaryPolicy.path, 'boundaryPolicies', repoRoot);
    for (const gateId of pkg.requiredGateIds) addPath(paths, catalog.gateDefinitions[gateId].path, 'requiredGates', repoRoot);
    for (const [surface, values] of Object.entries(pkg.publicSurface)) {
      for (const value of values) {
        if (surface !== 'conformance') {
          addTree(
            paths,
            normalizeRelative(pkg.path, value),
            'catalogPublicSurfaces',
            repoRoot,
            inventory,
          );
          addTree(
            paths,
            normalizeRelative(pkg.path, value),
            'generatedOutputSources',
            repoRoot,
            inventory,
          );
          continue;
        }
        const assets = publicAssets.filter((asset) => (
          asset.package === pkg.name && asset.kind === 'conformance' && asset.export === value
        ));
        for (const asset of assets) {
          addPath(paths, asset.path, 'catalogPublicSurfaces', repoRoot);
          addPath(paths, asset.path, 'conformanceSources', repoRoot);
          addPath(paths, asset.path, 'generatedOutputSources', repoRoot);
        }
        for (const target of assets.flatMap(({ packedTargets }) => packedTargets)) {
          addPath(paths, normalizeRelative(pkg.path, target), 'conformancePackedTargets', repoRoot, { mustExist: false });
          addPath(paths, normalizeRelative(pkg.path, target), 'generatedOutputSources', repoRoot, { mustExist: false });
        }
      }
    }
    discoverSurfaceDirectories(repoRoot, pkg.path, paths, inventory);
    discoverGeneratorSources(repoRoot, pkg, paths, inventory);
  }
  addTree(paths, '.github/scripts', 'generatorSources', repoRoot, inventory);
  addTree(paths, '.github/workflows', 'generatorSources', repoRoot, inventory);
  return paths;
}

export function validateArchitectureControl({ repoRoot, codeownersText } = {}) {
  const root = resolve(repoRoot ?? process.cwd());
  const catalog = loadPlatformCatalog(root);
  assertUsernameGroups(catalog);
  const source = codeownersText ?? readFileSync(resolve(root, '.github/CODEOWNERS'), 'utf8');
  const rules = parseCodeowners(source);
  const paths = enumerateArchitectureControlPaths(root, catalog);
  const entries = [...paths.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([path, categories]) => {
    const owners = effectiveOwners(rules, path);
    if (!sameOwnerSet(owners, REQUIRED_ARCHITECTURE_OWNERS)) {
      throw new Error(`${path}: effective owners must be exactly ${REQUIRED_ARCHITECTURE_OWNERS.join(' ')}, found ${owners.join(' ') || '<none>'}`);
    }
    return { path, categories: [...categories].sort(), owners: REQUIRED_ARCHITECTURE_OWNERS };
  });
  const categoryNames = [...new Set(entries.flatMap((entry) => entry.categories))].sort();
  const counts = Object.fromEntries(categoryNames.map((category) => [
    category,
    entries.filter((entry) => entry.categories.includes(category)).length,
  ]));
  return {
    version: 1,
    requiredOwners: REQUIRED_ARCHITECTURE_OWNERS,
    counts,
    paths: entries,
  };
}

function parseArguments(argv) {
  const options = { repoRoot: process.cwd(), out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1];
    if (argv[index] === '--repo-root' && value) { options.repoRoot = value; index += 1; }
    else if (argv[index] === '--out' && value) { options.out = value; index += 1; }
    else throw new Error(`unknown or incomplete argument ${argv[index]}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const report = validateArchitectureControl({ repoRoot: options.repoRoot });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (options.out) {
    const outputPath = resolve(options.repoRoot, options.out);
    if (!existsSync(dirname(outputPath))) throw new Error(`output directory does not exist: ${dirname(options.out)}`);
    writeFileSync(outputPath, json, 'utf8');
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`architecture control failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
