import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { RUNTIME_DEPENDENCY_SECTIONS } from './platform-catalog.mjs';

export const NATIVE_VERTICAL_ROLE_FIXTURES = Object.freeze({
  requester: '.github/fixtures/native-vertical-roles/requester',
  operator: '.github/fixtures/native-vertical-roles/operator',
  evaluator: '.github/fixtures/native-vertical-roles/evaluator',
  consumer: '.github/fixtures/native-vertical-roles/consumer',
});

function firstPartyImports(source) {
  return [...source.matchAll(/\b(?:from|import)\s*(?:\(\s*)?(['"])(@jinn-network\/[^/'"]+)/gu)]
    .map(([, , name]) => name)
    .sort();
}

export function loadNativeVerticalRoleFixtures(repoRoot) {
  const roles = {};
  for (const [role, directory] of Object.entries(NATIVE_VERTICAL_ROLE_FIXTURES)) {
    const root = resolve(repoRoot, ...directory.split('/'));
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
    const source = readFileSync(resolve(root, 'index.mjs'), 'utf8');
    const roots = Object.keys(manifest.dependencies ?? {})
      .filter((name) => name.startsWith('@jinn-network/'))
      .sort();
    const imports = firstPartyImports(source);
    if (JSON.stringify(roots) !== JSON.stringify(imports)) {
      throw new Error(`${role} role fixture imports and manifest dependencies differ`);
    }
    roles[role] = { directory, roots, source };
  }
  return roles;
}

function runtimeDependencies(pkg) {
  return RUNTIME_DEPENDENCY_SECTIONS.flatMap((section) => (
    Object.keys(pkg.manifest[section] ?? {}).filter((name) => name.startsWith('@jinn-network/'))
  ));
}

function closeNames({ roots, byName, label }) {
  const pending = [...roots];
  const closure = new Set();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || closure.has(name)) continue;
    const pkg = byName.get(name);
    if (!pkg) throw new Error(`${label} references uncataloged runtime package ${name}`);
    closure.add(name);
    for (const dependency of runtimeDependencies(pkg)) {
      if (!byName.has(dependency)) {
        throw new Error(`${label} runtime closure contains uncataloged dependency ${dependency}`);
      }
      pending.push(dependency);
    }
  }
  return [...closure].sort();
}

export function deriveNativeVerticalRoleClosures(repoRoot, catalogPackages) {
  const byName = new Map(catalogPackages.map((pkg) => [pkg.name, pkg]));
  return Object.fromEntries(Object.entries(loadNativeVerticalRoleFixtures(repoRoot)).map(([
    role,
    fixture,
  ]) => [role, {
    ...fixture,
    closure: closeNames({ roots: fixture.roots, byName, label: `${role} role` }),
  }]));
}

export function nativeVerticalRuntimePackageNames(repoRoot, catalogPackages, promotedNames = []) {
  const roles = deriveNativeVerticalRoleClosures(repoRoot, catalogPackages);
  const byName = new Map(catalogPackages.map((pkg) => [pkg.name, pkg]));
  const promotedClosure = closeNames({ roots: promotedNames, byName, label: 'promoted package set' });
  return [...new Set([
    ...Object.values(roles).flatMap(({ closure }) => closure),
    ...promotedClosure,
  ])].sort();
}
