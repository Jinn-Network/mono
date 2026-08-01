import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const PLATFORM_CATALOG_PATH = 'architecture/platform-packages.v1.json';
export const PLATFORM_CATALOG_SCHEMA_PATH = 'architecture/platform-packages.schema.json';
export const RUNTIME_DEPENDENCY_SECTIONS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
];

const TIERS = [1, 2, 3, 4, null];
const CLASSIFICATIONS = new Set([
  'platform',
  'platform-support',
  'product',
  'product-support',
  'legacy',
  'transitional',
  'repository-tooling',
]);
const STABILITIES = new Set([
  'stable-semantics',
  'candidate',
  'experimental',
  'deprecated',
  'transitional',
]);
const PUBLISH_POLICIES = new Set([
  'canary-and-stable',
  'canary-only',
  'disabled',
  'independent',
  'private',
  'never',
]);
const AUTHORITY_STATUSES = new Set(['ratified', 'approved', 'draft', 'current']);
const FORBIDDEN_CATALOG_PACKAGE_FIELDS = [
  'version',
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'files',
  'exports',
  'private',
  'publishConfig',
];
const REQUIRED_PACKAGE_FIELDS = [
  'name',
  'path',
  'domain',
  'role',
  'tier',
  'classification',
  'stability',
  'authority',
  'releaseGroup',
  'publishPolicy',
  'ownerGroup',
  'requiredGateIds',
  'boundaryPolicy',
  'publicSurface',
  'supersedes',
  'replacedBy',
];
const PUBLIC_SURFACE_FIELDS = ['schemas', 'profiles', 'fixtures', 'conformance'];
const INITIAL_EXPERIMENTAL_PACKAGES = [
  '@jinn-network/record-discovery-facts-environments',
  '@jinn-network/environment-record',
  '@jinn-network/environment-verification',
  '@jinn-network/task-admission',
  '@jinn-network/task-curation',
  '@jinn-network/task-derivation',
  '@jinn-network/task-posting',
];
const INITIAL_ADJACENT_PATHS = [
  'apps/broadcast-bot',
  'client',
  'client/src/dashboard/spa',
  'plugin/runtime',
];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value, label) {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireStringArray(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim() === '')) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  if (nonEmpty && value.length === 0) throw new Error(`${label} must not be empty`);
  return value;
}

function toPosix(value) {
  return value.split(sep).join('/');
}

function requireRepoRelativePath(value, label) {
  requireString(value, label);
  if (value.startsWith('/') || value.split('/').includes('..')) {
    throw new Error(`${label} must be repository-relative`);
  }
  return value;
}

function assertExistingPath(repoRoot, relativePath, label) {
  if (!existsSync(resolve(repoRoot, ...relativePath.split('/')))) {
    throw new Error(`${label} path does not exist: ${relativePath}`);
  }
}

function discoverRecursiveManifests(absoluteRoot, relativeRoot, excluded, found) {
  for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || excluded.has(entry.name)) continue;
    const childAbsolute = join(absoluteRoot, entry.name);
    const childRelative = relativeRoot ? `${relativeRoot}/${entry.name}` : entry.name;
    const manifest = join(childAbsolute, 'package.json');
    if (existsSync(manifest) && statSync(manifest).isFile()) {
      found.set(toPosix(childRelative), manifest);
    }
    discoverRecursiveManifests(childAbsolute, childRelative, excluded, found);
  }
}

function discoverScopedManifests(catalog, repoRoot) {
  const found = new Map();
  for (const [index, root] of catalog.manifestRoots.entries()) {
    requireObject(root, `manifestRoots[${index}]`);
    const relativeRoot = requireRepoRelativePath(root.path, `manifestRoots[${index}].path`);
    const absoluteRoot = resolve(repoRoot, ...relativeRoot.split('/'));
    if (!existsSync(absoluteRoot) || !statSync(absoluteRoot).isDirectory()) {
      throw new Error(`manifest root does not exist: ${relativeRoot}`);
    }
    if (root.mode === 'package') {
      const manifest = join(absoluteRoot, 'package.json');
      if (!existsSync(manifest) || !statSync(manifest).isFile()) {
        throw new Error(`manifest root ${relativeRoot} does not contain package.json`);
      }
      found.set(relativeRoot, manifest);
      continue;
    }
    if (root.mode !== 'recursive') {
      throw new Error(`manifestRoots[${index}].mode must be recursive or package`);
    }
    const excluded = new Set(root.excludedDirectories ?? []);
    requireStringArray([...excluded], `manifestRoots[${index}].excludedDirectories`);
    const rootManifest = join(absoluteRoot, 'package.json');
    if (existsSync(rootManifest) && statSync(rootManifest).isFile()) found.set(relativeRoot, rootManifest);
    discoverRecursiveManifests(absoluteRoot, relativeRoot, excluded, found);
  }
  return found;
}

function readManifest(path, directory) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${directory}: cannot read package.json: ${error?.message ?? String(error)}`);
  }
}

function validateTopLevel(catalog) {
  requireObject(catalog, 'catalog');
  if (catalog.catalogVersion !== 1) throw new Error(`catalogVersion must be 1, got ${catalog.catalogVersion ?? '<missing>'}`);
  if (!Array.isArray(catalog.manifestRoots) || catalog.manifestRoots.length === 0) {
    throw new Error('manifestRoots must be a non-empty array');
  }
  requireObject(catalog.ownerGroups, 'ownerGroups');
  requireObject(catalog.gateDefinitions, 'gateDefinitions');
  requireObject(catalog.releaseGroups, 'releaseGroups');
  requireObject(catalog.tierRules, 'tierRules');
  requireObject(catalog.tierRules.allowedDependencies, 'tierRules.allowedDependencies');
  if (!Array.isArray(catalog.packages)) throw new Error('packages must be an array');
}

function validateDefinitions(catalog, repoRoot) {
  for (const [ownerGroup, owners] of Object.entries(catalog.ownerGroups)) {
    requireString(ownerGroup, 'owner group id');
    requireStringArray(owners, `ownerGroups.${ownerGroup}`, { nonEmpty: true });
  }
  for (const [gateId, gate] of Object.entries(catalog.gateDefinitions)) {
    requireObject(gate, `gateDefinitions.${gateId}`);
    requireString(gate.kind, `gateDefinitions.${gateId}.kind`);
    requireRepoRelativePath(gate.path, `gateDefinitions.${gateId}.path`);
    assertExistingPath(repoRoot, gate.path, `gate ${gateId}`);
  }
  for (const [groupId, group] of Object.entries(catalog.releaseGroups)) {
    requireObject(group, `releaseGroups.${groupId}`);
    if (!Number.isInteger(group.expectedPackageCount) || group.expectedPackageCount < 0) {
      throw new Error(`releaseGroups.${groupId}.expectedPackageCount must be a non-negative integer`);
    }
    requireStringArray(group.publishPolicies, `releaseGroups.${groupId}.publishPolicies`, { nonEmpty: true });
    for (const policy of group.publishPolicies) {
      if (!PUBLISH_POLICIES.has(policy)) throw new Error(`releaseGroups.${groupId} has unknown publish policy ${policy}`);
    }
    for (const flag of ['stackPublished', 'canary', 'stable']) {
      if (typeof group[flag] !== 'boolean') throw new Error(`releaseGroups.${groupId}.${flag} must be boolean`);
    }
  }
  for (const tier of TIERS) {
    const key = String(tier);
    const allowed = catalog.tierRules.allowedDependencies[key];
    if (!Array.isArray(allowed) || allowed.some((entry) => !TIERS.includes(entry))) {
      throw new Error(`tierRules.allowedDependencies.${key} must contain only tiers 1, 2, 3, 4, or null`);
    }
  }
}

function validatePackageShape(pkg, index, catalog, repoRoot) {
  requireObject(pkg, `packages[${index}]`);
  for (const field of REQUIRED_PACKAGE_FIELDS) {
    if (!(field in pkg)) throw new Error(`packages[${index}] is missing required field ${field}`);
  }
  for (const field of FORBIDDEN_CATALOG_PACKAGE_FIELDS) {
    if (field in pkg) throw new Error(`${pkg.name ?? `packages[${index}]`}: npm metadata ${field} belongs in package.json, not the catalog`);
  }
  requireString(pkg.name, `packages[${index}].name`);
  requireRepoRelativePath(pkg.path, `${pkg.name}.path`);
  requireString(pkg.domain, `${pkg.name}.domain`);
  requireString(pkg.role, `${pkg.name}.role`);
  if (!TIERS.includes(pkg.tier)) throw new Error(`${pkg.name}: tier must be 1, 2, 3, 4, or null`);
  if (pkg.tier === null) requireString(pkg.tierReason, `${pkg.name}.tierReason`);
  if (!CLASSIFICATIONS.has(pkg.classification)) throw new Error(`${pkg.name}: unknown classification ${pkg.classification}`);
  if (!STABILITIES.has(pkg.stability)) throw new Error(`${pkg.name}: unknown stability ${pkg.stability}`);
  if (!PUBLISH_POLICIES.has(pkg.publishPolicy)) throw new Error(`${pkg.name}: unknown publish policy ${pkg.publishPolicy}`);
  if (pkg.classification === 'platform' && ![1, 2, 3].includes(pkg.tier)) {
    throw new Error(`${pkg.name}: platform packages must be tier 1, 2, or 3`);
  }
  if (pkg.classification === 'platform-support' && pkg.tier !== null) {
    throw new Error(`${pkg.name}: platform-support packages must use tier null`);
  }
  if (pkg.classification === 'product' && pkg.tier !== 4) {
    throw new Error(`${pkg.name}: product packages must be tier 4`);
  }
  if (pkg.classification === 'repository-tooling' && pkg.tier !== null) {
    throw new Error(`${pkg.name}: repository-tooling packages must use tier null`);
  }
  requireObject(pkg.authority, `${pkg.name}.authority`);
  requireStringArray(pkg.authority.documents, `${pkg.name}.authority.documents`, { nonEmpty: true });
  if (!AUTHORITY_STATUSES.has(pkg.authority.status)) throw new Error(`${pkg.name}: unknown authority status ${pkg.authority.status}`);
  for (const document of pkg.authority.documents) {
    requireRepoRelativePath(document, `${pkg.name}.authority.documents`);
    assertExistingPath(repoRoot, document, `${pkg.name}: authority`);
  }
  if (pkg.authority.decisionRecord !== null) {
    requireRepoRelativePath(pkg.authority.decisionRecord, `${pkg.name}.authority.decisionRecord`);
    assertExistingPath(repoRoot, pkg.authority.decisionRecord, `${pkg.name}: decision record`);
  }
  if (!(pkg.ownerGroup in catalog.ownerGroups)) throw new Error(`${pkg.name}: unknown owner group ${pkg.ownerGroup}`);
  requireStringArray(pkg.requiredGateIds, `${pkg.name}.requiredGateIds`, { nonEmpty: true });
  for (const gateId of pkg.requiredGateIds) {
    if (!(gateId in catalog.gateDefinitions)) throw new Error(`${pkg.name}: unknown gate ${gateId}`);
  }
  requireObject(pkg.boundaryPolicy, `${pkg.name}.boundaryPolicy`);
  requireString(pkg.boundaryPolicy.kind, `${pkg.name}.boundaryPolicy.kind`);
  requireRepoRelativePath(pkg.boundaryPolicy.path, `${pkg.name}.boundaryPolicy.path`);
  assertExistingPath(repoRoot, pkg.boundaryPolicy.path, `${pkg.name}: boundary policy`);
  requireObject(pkg.publicSurface, `${pkg.name}.publicSurface`);
  for (const field of PUBLIC_SURFACE_FIELDS) {
    requireStringArray(pkg.publicSurface[field], `${pkg.name}.publicSurface.${field}`);
  }
  requireStringArray(pkg.supersedes, `${pkg.name}.supersedes`);
  requireStringArray(pkg.replacedBy, `${pkg.name}.replacedBy`);
  if (['deprecated', 'transitional'].includes(pkg.stability)) {
    if (!isObject(pkg.transition)) throw new Error(`${pkg.name}: ${pkg.stability} packages require transition metadata`);
    requireString(pkg.transition.reason, `${pkg.name}.transition.reason`);
    requireString(pkg.transition.status, `${pkg.name}.transition.status`);
    requireString(pkg.transition.sunsetCondition, `${pkg.name}.transition.sunsetCondition`);
  }
  const group = catalog.releaseGroups[pkg.releaseGroup];
  if (!group) throw new Error(`${pkg.name}: unknown release group ${pkg.releaseGroup}`);
  if (!group.publishPolicies.includes(pkg.publishPolicy)) {
    throw new Error(`${pkg.name}: publish policy ${pkg.publishPolicy} is not permitted by ${pkg.releaseGroup}`);
  }
}

function validateReleaseGroups(catalog) {
  const grouped = new Map();
  for (const pkg of catalog.packages) {
    const entries = grouped.get(pkg.releaseGroup) ?? [];
    entries.push(pkg);
    grouped.set(pkg.releaseGroup, entries);
  }
  for (const [groupId, definition] of Object.entries(catalog.releaseGroups)) {
    const actual = grouped.get(groupId)?.length ?? 0;
    if (actual !== definition.expectedPackageCount) {
      throw new Error(`release group ${groupId} expects ${definition.expectedPackageCount} packages, found ${actual}`);
    }
  }
  if (!catalog.releaseGroups['platform-v1']) return;
  const core = grouped.get('platform-v1') ?? [];
  if (core.length !== 50) throw new Error(`platform-v1 must contain exactly 50 packages, found ${core.length}`);
  if (catalog.releaseGroups['platform-v1'].stable !== false) throw new Error('platform-v1 stable publication must be false');
  if (core.some((pkg) => pkg.publishPolicy !== 'canary-only')) throw new Error('every platform-v1 package must be canary-only');
  const experiments = (grouped.get('experimental-environment-supply') ?? []).map((pkg) => pkg.name).sort();
  if (JSON.stringify(experiments) !== JSON.stringify([...INITIAL_EXPERIMENTAL_PACKAGES].sort())) {
    throw new Error(`experimental-environment-supply must contain exactly: ${INITIAL_EXPERIMENTAL_PACKAGES.join(', ')}`);
  }
  if (experiments.some((name) => catalog.packages.find((pkg) => pkg.name === name).publishPolicy !== 'disabled')) {
    throw new Error('every experimental-environment-supply package must be disabled');
  }
  if (catalog.packages.length !== 69) throw new Error(`initial platform catalog must contain 69 packages, found ${catalog.packages.length}`);
  const belowPackages = catalog.packages.filter((pkg) => pkg.path.startsWith('packages/'));
  const otherBelowPackages = belowPackages.filter((pkg) => !['platform-v1', 'experimental-environment-supply'].includes(pkg.releaseGroup));
  if (belowPackages.length !== 65 || otherBelowPackages.length !== 8) {
    throw new Error(`initial platform catalog must contain 65 packages-root entries (50 core, 7 experimental, 8 other)`);
  }
  const adjacent = catalog.packages.filter((pkg) => !pkg.path.startsWith('packages/')).map((pkg) => pkg.path).sort();
  if (JSON.stringify(adjacent) !== JSON.stringify([...INITIAL_ADJACENT_PATHS].sort())) {
    throw new Error(`initial adjacent package paths must be exactly: ${INITIAL_ADJACENT_PATHS.join(', ')}`);
  }
}

function validateManifestAgreement(catalog, repoRoot) {
  const scoped = discoverScopedManifests(catalog, repoRoot);
  const catalogByPath = new Map();
  const catalogByName = new Map();
  for (const pkg of catalog.packages) {
    if (catalogByPath.has(pkg.path)) throw new Error(`duplicate catalog package path ${pkg.path}`);
    if (catalogByName.has(pkg.name)) throw new Error(`duplicate catalog package name ${pkg.name}`);
    catalogByPath.set(pkg.path, pkg);
    catalogByName.set(pkg.name, pkg);
  }
  const missingFromCatalog = [...scoped.keys()].filter((path) => !catalogByPath.has(path)).sort();
  const missingFromScope = [...catalogByPath.keys()].filter((path) => !scoped.has(path)).sort();
  if (missingFromCatalog.length > 0 || missingFromScope.length > 0) {
    throw new Error(
      `catalog completeness mismatch; uncataloged manifests: ${missingFromCatalog.join(', ') || '<none>'}; `
      + `catalog paths without scoped manifests: ${missingFromScope.join(', ') || '<none>'}`,
    );
  }
  const manifests = new Map();
  for (const [directory, manifestPath] of scoped) {
    const manifest = readManifest(manifestPath, directory);
    const pkg = catalogByPath.get(directory);
    if (manifest.name !== pkg.name) {
      throw new Error(`${directory}: catalog names ${pkg.name}, manifest names ${manifest.name ?? '<missing>'}`);
    }
    manifests.set(pkg.name, { manifest, manifestPath, directory, catalog: pkg });
  }
  return manifests;
}

function validateDependencies(catalog, manifests) {
  const allowedDependencies = catalog.tierRules.allowedDependencies;
  for (const source of manifests.values()) {
    const sourceGroup = catalog.releaseGroups[source.catalog.releaseGroup];
    for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
      for (const [dependency, specifier] of Object.entries(source.manifest[section] ?? {})) {
        if (!dependency.startsWith('@jinn-network/') || dependency === source.catalog.name) continue;
        const target = manifests.get(dependency);
        if (!target) {
          if (sourceGroup.stackPublished) {
            throw new Error(`${source.catalog.releaseGroup} package ${source.catalog.name} depends on missing catalog package ${dependency}`);
          }
          continue;
        }
        const permittedTiers = allowedDependencies[String(source.catalog.tier)];
        if (!permittedTiers.includes(target.catalog.tier)) {
          throw new Error(
            `tier ${source.catalog.tier} package ${source.catalog.name} cannot depend on tier ${target.catalog.tier} package ${target.catalog.name}`,
          );
        }
        if (sourceGroup.stackPublished && target.catalog.releaseGroup !== source.catalog.releaseGroup) {
          throw new Error(
            `${source.catalog.releaseGroup} package ${source.catalog.name} depends on ${dependency} in ${target.catalog.releaseGroup}`,
          );
        }
        if (sourceGroup.stackPublished && target.catalog.releaseGroup === source.catalog.releaseGroup) {
          const isLocal = typeof specifier === 'string' && /^(portal|link|file|workspace):/u.test(specifier);
          if (!isLocal && specifier !== target.manifest.version) {
            throw new Error(
              `${source.catalog.name} depends on incompatible ${dependency} specifier ${specifier}; expected ${target.manifest.version}`,
            );
          }
        }
      }
    }
  }
}

export function validatePlatformCatalog(catalog, { repoRoot }) {
  const root = resolve(repoRoot);
  validateTopLevel(catalog);
  validateDefinitions(catalog, root);
  catalog.packages.forEach((pkg, index) => validatePackageShape(pkg, index, catalog, root));
  validateReleaseGroups(catalog);
  const manifests = validateManifestAgreement(catalog, root);
  validateDependencies(catalog, manifests);
  return catalog;
}

export function loadPlatformCatalog(repoRoot, { catalogPath = PLATFORM_CATALOG_PATH } = {}) {
  const root = resolve(repoRoot);
  const absoluteCatalogPath = resolve(root, ...catalogPath.split('/'));
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(absoluteCatalogPath, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read platform catalog ${catalogPath}: ${error?.message ?? String(error)}`);
  }
  return validatePlatformCatalog(catalog, { repoRoot: root });
}

export function loadCatalogPackages(repoRoot, { releaseGroup } = {}) {
  const root = resolve(repoRoot);
  const catalog = loadPlatformCatalog(root);
  return catalog.packages
    .filter((pkg) => releaseGroup === undefined || pkg.releaseGroup === releaseGroup)
    .map((pkg) => {
      const manifestPath = resolve(root, ...pkg.path.split('/'), 'package.json');
      return {
        directory: pkg.path,
        name: pkg.name,
        manifest: readManifest(manifestPath, pkg.path),
        manifestPath,
        catalog: pkg,
      };
    })
    .sort((left, right) => (left.directory < right.directory ? -1 : left.directory > right.directory ? 1 : 0));
}
