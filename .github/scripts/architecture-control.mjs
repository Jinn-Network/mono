#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadPlatformCatalog } from './platform-catalog.mjs';

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
    if (!(pkg.ownerGroup in catalog.ownerGroups)) throw new Error(`${pkg.name}: unresolved owner group ${pkg.ownerGroup}`);
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

function addTree(paths, repositoryPath, category, repoRoot) {
  addPath(paths, repositoryPath, category, repoRoot);
  const normalized = repositoryPath.replace(/^\/+|\/+$/gu, '');
  const absolute = resolve(repoRoot, ...normalized.split('/'));
  if (!statSync(absolute).isDirectory()) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
    const child = `${normalized}/${entry.name}`;
    if (entry.isDirectory()) addTree(paths, child, category, repoRoot);
    else if (entry.isFile()) addPath(paths, child, category, repoRoot);
  }
}

function exportTargets(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportTargets);
  return [];
}

function sourceCandidates(target) {
  if (!target.startsWith('./dist/')) return [target];
  const stem = target.slice('./dist/'.length).replace(/\.(?:d\.ts|js)$/u, '');
  return [
    `./src/${stem}.ts`,
    `./src/${stem}.tsx`,
    `./src/${stem}/index.ts`,
    `./src/${stem}/index.tsx`,
  ];
}

export function resolveConformanceSources(repoRoot, pkg, manifest, exportKey) {
  const definition = manifest.exports?.[exportKey];
  if (definition === undefined) throw new Error(`${pkg.name}: conformance export ${exportKey} is not declared in package.json exports`);
  const packedTargets = [...new Set(exportTargets(definition))].sort();
  if (packedTargets.length === 0) throw new Error(`${pkg.name}: conformance export ${exportKey} has no packed targets`);
  const sources = [];
  for (const target of packedTargets) {
    const existing = sourceCandidates(target).find((candidate) => existsSync(resolve(
      repoRoot,
      ...normalizeRelative(pkg.path, candidate).split('/'),
    )));
    if (!existing) throw new Error(`${pkg.name}: conformance target ${target} has no first-party source`);
    sources.push(existing);
  }
  return { packedTargets, sources: [...new Set(sources)].sort() };
}

function discoverSurfaceDirectories(repoRoot, packagePath, paths) {
  const packageRoot = resolve(repoRoot, ...packagePath.split('/'));
  const visit = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const child = resolve(absolute, entry.name);
      const relativePath = relative(repoRoot, child).split('\\').join('/');
      if (SURFACE_DIRECTORIES.has(entry.name) || entry.name.includes('conformance')) {
        addTree(paths, relativePath, 'discoveredFirstPartySurfaces', repoRoot);
      }
      visit(child);
    }
  };
  visit(packageRoot);
}

function discoverGenerators(repoRoot, pkg, paths) {
  const manifestPath = resolve(repoRoot, ...pkg.path.split('/'), 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const generatedSurfaceKinds = new Set();
  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (!/(?:codegen|generate|seal)/u.test(name)) continue;
    if (/fixtures/u.test(name)) generatedSurfaceKinds.add('fixtures');
    if (/schemas/u.test(name)) generatedSurfaceKinds.add('schemas');
    if (/(?:profile|documents)/u.test(name)) generatedSurfaceKinds.add('profiles');
    if (pkg.path === 'packages/evidence/repository-oci' && name === 'generate:profile') {
      generatedSurfaceKinds.add('fixtures');
    }
    for (const match of command.matchAll(/(?:^|\s)([A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts))(?:\s|$)/gu)) {
      const candidate = normalizeRelative(pkg.path, match[1]);
      if (existsSync(resolve(repoRoot, ...candidate.split('/')))) {
        addPath(paths, candidate, 'generatorSources', repoRoot);
        if (candidate === 'client/scripts/skill-generate.ts') {
          addPath(paths, 'client/skills/jinn-operator/SKILL.md', 'generatedOutputSources', repoRoot);
        }
      }
    }
  }
  for (const surface of generatedSurfaceKinds) {
    for (const value of pkg.publicSurface[surface]) {
      addTree(paths, normalizeRelative(pkg.path, value), 'generatedOutputSources', repoRoot);
    }
  }
}

export function enumerateArchitectureControlPaths(repoRoot, catalog) {
  const paths = new Map();
  for (const [path, category] of STATIC_CONTROL) addPath(paths, path, category, repoRoot);
  for (const pkg of catalog.packages) {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, ...pkg.path.split('/'), 'package.json'), 'utf8'));
    addPath(paths, `${pkg.path}/package.json`, 'catalogManifests', repoRoot);
    for (const document of pkg.authority.documents) addPath(paths, document.path, 'authorityDocuments', repoRoot);
    if (pkg.authority.decisionRecord) addPath(paths, pkg.authority.decisionRecord.path, 'decisionRecords', repoRoot);
    addPath(paths, pkg.boundaryPolicy.path, 'boundaryPolicies', repoRoot);
    for (const gateId of pkg.requiredGateIds) addPath(paths, catalog.gateDefinitions[gateId].path, 'requiredGates', repoRoot);
    for (const [surface, values] of Object.entries(pkg.publicSurface)) {
      for (const value of values) {
        if (surface !== 'conformance') {
          addTree(paths, normalizeRelative(pkg.path, value), 'catalogPublicSurfaces', repoRoot);
          continue;
        }
        const resolved = resolveConformanceSources(repoRoot, pkg, manifest, value);
        for (const source of resolved.sources) {
          addPath(paths, normalizeRelative(pkg.path, source), 'catalogPublicSurfaces', repoRoot);
          addPath(paths, normalizeRelative(pkg.path, source), 'conformanceSources', repoRoot);
        }
        for (const target of resolved.packedTargets) {
          addPath(paths, normalizeRelative(pkg.path, target), 'conformancePackedTargets', repoRoot, { mustExist: false });
        }
      }
    }
    discoverSurfaceDirectories(repoRoot, pkg.path, paths);
    discoverGenerators(repoRoot, pkg, paths);
  }
  for (const path of readdirSync(resolve(repoRoot, '.github/scripts'))) {
    if (!/^(?:build-|fixture-manifest|jinn-plugin-split|platform-verification-receipt|stack-publish-manifest|stack-trusted-publishers).*\.mjs$/u.test(path)) continue;
    addPath(paths, `.github/scripts/${path}`, 'generatorSources', repoRoot);
  }
  addPath(paths, '.github/workflows/jinn-plugin-split.yml', 'generatorSources', repoRoot);
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
