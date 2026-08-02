import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { normalizePackageRelativePublicPath } from './public-surface-assets.mjs';
import { repositoryCandidateFiles } from './repository-candidates.mjs';

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
const CANARY_PUBLISH_POLICIES = new Set(['canary-and-stable', 'canary-only']);
const STABLE_PUBLISH_POLICIES = new Set(['canary-and-stable']);
const AUTHORITY_STATUSES = new Set(['ratified', 'approved', 'proposed', 'draft', 'current', 'superseded']);
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
const MANIFEST_EXCLUSION_CLASSIFICATIONS = new Set([
  'vendored',
  'fixture',
  'external',
  'transitional',
]);
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

function assertExistingFile(repoRoot, relativePath, label) {
  const absolutePath = resolve(repoRoot, ...relativePath.split('/'));
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`${label} path does not exist: ${relativePath}`);
  }
}

function schemaFailure(path, message) {
  throw new Error(`schema validation failed at ${path}: ${message}`);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJsonValue(entry)).join(',')}]`;
  }
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJsonValue(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function schemaValueEquals(left, right) {
  return canonicalJsonValue(left) === canonicalJsonValue(right);
}

function schemaTypeMatches(value, type) {
  if (type === 'null') return value === null;
  if (type === 'array') return Array.isArray(value);
  if (type === 'object') return isObject(value);
  if (type === 'integer') return Number.isInteger(value);
  return typeof value === type;
}

function resolveSchemaReference(rootSchema, reference) {
  if (!reference.startsWith('#/')) throw new Error(`unsupported catalog schema reference ${reference}`);
  return reference.slice(2).split('/').reduce((value, component) => {
    const key = component.replace(/~1/gu, '/').replace(/~0/gu, '~');
    if (!isObject(value) || !(key in value)) throw new Error(`unresolved catalog schema reference ${reference}`);
    return value[key];
  }, rootSchema);
}

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$defs',
  '$id',
  '$ref',
  '$schema',
  'additionalProperties',
  'allOf',
  'const',
  'enum',
  'if',
  'items',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'oneOf',
  'pattern',
  'properties',
  'required',
  'then',
  'title',
  'type',
  'uniqueItems',
]);

function assertSupportedSchema(schema, path = 'schema') {
  if (!isObject(schema)) throw new Error(`catalog schema node at ${path} must be an object`);
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) {
      throw new Error(`unsupported catalog schema keyword ${keyword} at ${path}`);
    }
  }
  for (const mapKeyword of ['$defs', 'properties']) {
    for (const [key, childSchema] of Object.entries(schema[mapKeyword] ?? {})) {
      assertSupportedSchema(childSchema, `${path}.${mapKeyword}.${key}`);
    }
  }
  for (const keyword of ['additionalProperties', 'if', 'items', 'then']) {
    if (isObject(schema[keyword])) assertSupportedSchema(schema[keyword], `${path}.${keyword}`);
  }
  for (const arrayKeyword of ['allOf', 'oneOf']) {
    (schema[arrayKeyword] ?? []).forEach((childSchema, index) => {
      assertSupportedSchema(childSchema, `${path}.${arrayKeyword}[${index}]`);
    });
  }
}

function schemaMatches(value, schema, rootSchema, path) {
  try {
    validateSchemaValue(value, schema, rootSchema, path);
    return true;
  } catch {
    return false;
  }
}

function validateSchemaValue(value, schema, rootSchema, path) {
  if (!isObject(schema)) throw new Error(`invalid catalog schema node at ${path}`);
  if (schema.$ref) {
    validateSchemaValue(value, resolveSchemaReference(rootSchema, schema.$ref), rootSchema, path);
  }
  if ('const' in schema && !schemaValueEquals(value, schema.const)) {
    schemaFailure(path, `expected constant ${JSON.stringify(schema.const)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => schemaValueEquals(value, candidate))) {
    schemaFailure(path, `value ${JSON.stringify(value)} is not in the allowed enum`);
  }
  if (schema.type && !schemaTypeMatches(value, schema.type)) {
    schemaFailure(path, `expected ${schema.type}`);
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((candidate) => schemaMatches(value, candidate, rootSchema, path));
    if (matches.length !== 1) schemaFailure(path, `expected exactly one of ${schema.oneOf.length} schema branches`);
  }
  if (isObject(value)) {
    for (const required of schema.required ?? []) {
      if (!(required in value)) schemaFailure(path, `missing required field ${required}`);
    }
    if (Number.isInteger(schema.minProperties) && Object.keys(value).length < schema.minProperties) {
      schemaFailure(path, `expected at least ${schema.minProperties} properties`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) {
        validateSchemaValue(child, properties[key], rootSchema, `${path}.${key}`);
      } else if (schema.additionalProperties === false) {
        schemaFailure(path, `unknown field ${key}`);
      } else if (isObject(schema.additionalProperties)) {
        validateSchemaValue(child, schema.additionalProperties, rootSchema, `${path}.${key}`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      schemaFailure(path, `expected at least ${schema.minItems} items`);
    }
    if (schema.uniqueItems) {
      const serialized = value.map((entry) => canonicalJsonValue(entry));
      if (new Set(serialized).size !== serialized.length) schemaFailure(path, 'items must be unique');
    }
    if (isObject(schema.items)) {
      value.forEach((entry, index) => validateSchemaValue(entry, schema.items, rootSchema, `${path}[${index}]`));
    }
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      schemaFailure(path, `expected length at least ${schema.minLength}`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) {
      schemaFailure(path, `value does not match ${schema.pattern}`);
    }
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    schemaFailure(path, `expected value at least ${schema.minimum}`);
  }
  for (const condition of schema.allOf ?? []) {
    validateSchemaValue(value, condition, rootSchema, path);
  }
  if (schema.if && schemaMatches(value, schema.if, rootSchema, path) && schema.then) {
    validateSchemaValue(value, schema.then, rootSchema, path);
  }
}

function loadCatalogSchema(repoRoot, schemaPath) {
  const absoluteSchemaPath = resolve(repoRoot, ...schemaPath.split('/'));
  try {
    const schema = JSON.parse(readFileSync(absoluteSchemaPath, 'utf8'));
    if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
      throw new Error(`expected JSON Schema Draft 2020-12, got ${schema.$schema ?? '<missing>'}`);
    }
    assertSupportedSchema(schema);
    return schema;
  } catch (error) {
    throw new Error(`cannot read platform catalog schema ${schemaPath}: ${error?.message ?? String(error)}`);
  }
}

function validateCatalogSchema(catalog, repoRoot, schemaPath) {
  const schema = loadCatalogSchema(repoRoot, schemaPath);
  validateSchemaValue(catalog, schema, schema, 'catalog');
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

function discoverRepositoryManifests(repoRoot) {
  const manifests = new Map();
  for (const candidate of repositoryCandidateFiles(repoRoot)) {
    if (candidate !== 'package.json' && !candidate.endsWith('/package.json')) continue;
    const directory = candidate === 'package.json'
      ? '.'
      : candidate.slice(0, -'/package.json'.length);
    const manifestPath = resolve(repoRoot, ...candidate.split('/'));
    const manifest = readManifest(manifestPath, directory);
    manifests.set(directory, { manifest, manifestPath, directory });
  }
  return manifests;
}

function validateTopLevel(catalog) {
  requireObject(catalog, 'catalog');
  if (catalog.catalogVersion !== 1) throw new Error(`catalogVersion must be 1, got ${catalog.catalogVersion ?? '<missing>'}`);
  if (!Array.isArray(catalog.manifestRoots) || catalog.manifestRoots.length === 0) {
    throw new Error('manifestRoots must be a non-empty array');
  }
  if (!Array.isArray(catalog.manifestExclusions)) {
    throw new Error('manifestExclusions must be an array');
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
  const exclusionPaths = new Set();
  for (const [index, exclusion] of catalog.manifestExclusions.entries()) {
    requireObject(exclusion, `manifestExclusions[${index}]`);
    const path = requireRepoRelativePath(exclusion.path, `manifestExclusions[${index}].path`);
    if (exclusionPaths.has(path)) throw new Error(`duplicate manifest exclusion path ${path}`);
    exclusionPaths.add(path);
    requireString(exclusion.reason, `manifestExclusions[${index}].reason`);
    requireString(exclusion.ownerGroup, `manifestExclusions[${index}].ownerGroup`);
    if (!Object.hasOwn(catalog.ownerGroups, exclusion.ownerGroup)) {
      throw new Error(`manifestExclusions[${index}]: unknown owner group ${exclusion.ownerGroup}`);
    }
    if (!MANIFEST_EXCLUSION_CLASSIFICATIONS.has(exclusion.classification)) {
      throw new Error(`manifestExclusions[${index}]: unknown classification ${exclusion.classification}`);
    }
    requireString(exclusion.reviewCondition, `manifestExclusions[${index}].reviewCondition`);
  }
  for (const [gateId, gate] of Object.entries(catalog.gateDefinitions)) {
    requireObject(gate, `gateDefinitions.${gateId}`);
    requireString(gate.kind, `gateDefinitions.${gateId}.kind`);
    requireRepoRelativePath(gate.path, `gateDefinitions.${gateId}.path`);
    assertExistingFile(repoRoot, gate.path, `gate ${gateId}`);
  }
  for (const [groupId, group] of Object.entries(catalog.releaseGroups)) {
    requireObject(group, `releaseGroups.${groupId}`);
    if (!Number.isInteger(group.expectedPackageCount) || group.expectedPackageCount < 0) {
      throw new Error(`releaseGroups.${groupId}.expectedPackageCount must be a non-negative integer`);
    }
    requireStringArray(group.publishPolicies, `releaseGroups.${groupId}.publishPolicies`, { nonEmpty: true });
    requireStringArray(group.requiredGateIds, `releaseGroups.${groupId}.requiredGateIds`, { nonEmpty: true });
    requireStringArray(group.allowedClassifications, `releaseGroups.${groupId}.allowedClassifications`, { nonEmpty: true });
    requireStringArray(
      group.allowedDependencyReleaseGroups,
      `releaseGroups.${groupId}.allowedDependencyReleaseGroups`,
      { nonEmpty: true },
    );
    for (const gateId of group.requiredGateIds) {
      if (!Object.hasOwn(catalog.gateDefinitions, gateId)) {
        throw new Error(`releaseGroups.${groupId}: unknown gate ${gateId}`);
      }
    }
    for (const policy of group.publishPolicies) {
      if (!PUBLISH_POLICIES.has(policy)) throw new Error(`releaseGroups.${groupId} has unknown publish policy ${policy}`);
    }
    for (const classification of group.allowedClassifications) {
      if (!CLASSIFICATIONS.has(classification)) {
        throw new Error(`releaseGroups.${groupId} has unknown classification ${classification}`);
      }
    }
    for (const dependencyGroup of group.allowedDependencyReleaseGroups) {
      if (!Object.hasOwn(catalog.releaseGroups, dependencyGroup)) {
        throw new Error(`releaseGroups.${groupId} allows unknown dependency release group ${dependencyGroup}`);
      }
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
  if (!Array.isArray(pkg.authority.documents) || pkg.authority.documents.length === 0) {
    throw new Error(`${pkg.name}.authority.documents must be a non-empty array`);
  }
  for (const [documentIndex, document] of pkg.authority.documents.entries()) {
    requireObject(document, `${pkg.name}.authority.documents[${documentIndex}]`);
    requireRepoRelativePath(document.path, `${pkg.name}.authority.documents[${documentIndex}].path`);
    if (!AUTHORITY_STATUSES.has(document.status)) {
      throw new Error(`${pkg.name}: unknown authority status ${document.status}`);
    }
    assertExistingFile(repoRoot, document.path, `${pkg.name}: authority`);
  }
  if (pkg.authority.decisionRecord !== null) {
    requireObject(pkg.authority.decisionRecord, `${pkg.name}.authority.decisionRecord`);
    requireRepoRelativePath(pkg.authority.decisionRecord.path, `${pkg.name}.authority.decisionRecord.path`);
    if (!AUTHORITY_STATUSES.has(pkg.authority.decisionRecord.status)) {
      throw new Error(`${pkg.name}: unknown authority status ${pkg.authority.decisionRecord.status}`);
    }
    assertExistingFile(repoRoot, pkg.authority.decisionRecord.path, `${pkg.name}: decision record`);
  }
  if (!Object.hasOwn(catalog.ownerGroups, pkg.ownerGroup)) throw new Error(`${pkg.name}: unknown owner group ${pkg.ownerGroup}`);
  requireStringArray(pkg.requiredGateIds, `${pkg.name}.requiredGateIds`, { nonEmpty: true });
  for (const gateId of pkg.requiredGateIds) {
    if (!Object.hasOwn(catalog.gateDefinitions, gateId)) throw new Error(`${pkg.name}: unknown gate ${gateId}`);
  }
  requireObject(pkg.boundaryPolicy, `${pkg.name}.boundaryPolicy`);
  requireString(pkg.boundaryPolicy.kind, `${pkg.name}.boundaryPolicy.kind`);
  requireRepoRelativePath(pkg.boundaryPolicy.path, `${pkg.name}.boundaryPolicy.path`);
  assertExistingFile(repoRoot, pkg.boundaryPolicy.path, `${pkg.name}: boundary policy`);
  requireObject(pkg.publicSurface, `${pkg.name}.publicSurface`);
  for (const field of PUBLIC_SURFACE_FIELDS) {
    requireStringArray(pkg.publicSurface[field], `${pkg.name}.publicSurface.${field}`);
    if (field !== 'conformance') {
      for (const [surfaceIndex, value] of pkg.publicSurface[field].entries()) {
        normalizePackageRelativePublicPath(
          value,
          `${pkg.name}.publicSurface.${field}[${surfaceIndex}]`,
        );
      }
    }
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
    const definition = catalog.releaseGroups[pkg.releaseGroup];
    if (!definition.allowedClassifications.includes(pkg.classification)) {
      throw new Error(
        `${pkg.releaseGroup} package ${pkg.name} cannot have classification ${pkg.classification}`,
      );
    }
    const entries = grouped.get(pkg.releaseGroup) ?? [];
    entries.push(pkg);
    grouped.set(pkg.releaseGroup, entries);
  }
  for (const [groupId, definition] of Object.entries(catalog.releaseGroups)) {
    const members = grouped.get(groupId) ?? [];
    if (members.length !== definition.expectedPackageCount) {
      throw new Error(`release group ${groupId} expects ${definition.expectedPackageCount} packages, found ${members.length}`);
    }
    const memberGateUnion = [...new Set(members.flatMap(({ requiredGateIds }) => requiredGateIds))].sort();
    const groupGates = [...definition.requiredGateIds].sort();
    if (!schemaValueEquals(groupGates, memberGateUnion)) {
      throw new Error(
        `releaseGroups.${groupId}.requiredGateIds must exactly equal member package gate union; `
        + `declared ${groupGates.join(', ') || '<none>'}, members require ${memberGateUnion.join(', ') || '<none>'}`,
      );
    }
    const memberPolicies = [...new Set(members.map(({ publishPolicy }) => publishPolicy))].sort();
    const declaredPolicies = [...definition.publishPolicies].sort();
    if (!schemaValueEquals(declaredPolicies, memberPolicies)) {
      throw new Error(
        `releaseGroups.${groupId}.publishPolicies must exactly equal member package policy union; `
        + `declared ${declaredPolicies.join(', ') || '<none>'}, members use ${memberPolicies.join(', ') || '<none>'}`,
      );
    }
    const canaryEligible = members.length > 0
      && members.every(({ publishPolicy }) => CANARY_PUBLISH_POLICIES.has(publishPolicy));
    const stableEligible = members.length > 0
      && members.every(({ publishPolicy }) => STABLE_PUBLISH_POLICIES.has(publishPolicy));
    if (definition.stackPublished !== canaryEligible
      || definition.canary !== canaryEligible
      || definition.stable !== stableEligible) {
      throw new Error(
        `releaseGroups.${groupId} publication flags must agree with every member publish policy`,
      );
    }
  }
}

function validateManifestAgreement(catalog, repoRoot) {
  const scoped = discoverScopedManifests(catalog, repoRoot);
  const repositoryManifests = discoverRepositoryManifests(repoRoot);
  const catalogByPath = new Map();
  const catalogByName = new Map();
  for (const pkg of catalog.packages) {
    if (catalogByPath.has(pkg.path)) throw new Error(`duplicate catalog package path ${pkg.path}`);
    if (catalogByName.has(pkg.name)) throw new Error(`duplicate catalog package name ${pkg.name}`);
    catalogByPath.set(pkg.path, pkg);
    catalogByName.set(pkg.name, pkg);
  }
  const exclusionByPath = new Map(catalog.manifestExclusions.map((exclusion) => [
    exclusion.path,
    exclusion,
  ]));
  for (const path of exclusionByPath.keys()) {
    if (catalogByPath.has(path)) {
      throw new Error(`${path}: first-party manifest cannot be both cataloged and excluded`);
    }
  }

  const firstPartyByName = new Map();
  for (const entry of repositoryManifests.values()) {
    if (typeof entry.manifest.name !== 'string'
      || !entry.manifest.name.startsWith('@jinn-network/')) continue;
    const entries = firstPartyByName.get(entry.manifest.name) ?? [];
    entries.push(entry);
    firstPartyByName.set(entry.manifest.name, entries);
  }
  for (const [name, entries] of firstPartyByName) {
    if (entries.length > 1) {
      throw new Error(
        `duplicate first-party package name ${name}: ${entries.map(({ directory }) => directory).sort().join(', ')}`,
      );
    }
  }

  for (const path of exclusionByPath.keys()) {
    const entry = repositoryManifests.get(path);
    if (!entry || typeof entry.manifest.name !== 'string'
      || !entry.manifest.name.startsWith('@jinn-network/')) {
      throw new Error(`manifest exclusion ${path} does not name a repository-wide first-party manifest`);
    }
  }

  const repositoryFirstParty = [...firstPartyByName.values()].flat();
  const uncatalogedFirstParty = repositoryFirstParty
    .filter(({ directory }) => !catalogByPath.has(directory) && !exclusionByPath.has(directory))
    .map(({ directory }) => directory)
    .sort();
  const missingRepositoryManifest = [...catalogByPath.keys()]
    .filter((path) => !repositoryManifests.has(path))
    .sort();
  if (uncatalogedFirstParty.length > 0 || missingRepositoryManifest.length > 0) {
    throw new Error(
      `catalog completeness mismatch; uncataloged first-party manifests: ${uncatalogedFirstParty.join(', ') || '<none>'}; `
      + `catalog paths without repository manifests: ${missingRepositoryManifest.join(', ') || '<none>'}`,
    );
  }

  const missingFromCatalog = [...scoped.keys()]
    .filter((path) => !catalogByPath.has(path) && !exclusionByPath.has(path))
    .sort();
  const missingFromScope = [...catalogByPath.keys()].filter((path) => !scoped.has(path)).sort();
  if (missingFromCatalog.length > 0 || missingFromScope.length > 0) {
    throw new Error(
      `catalog completeness mismatch; uncataloged manifests: ${missingFromCatalog.join(', ') || '<none>'}; `
      + `catalog paths without scoped manifests: ${missingFromScope.join(', ') || '<none>'}`,
    );
  }
  const manifests = new Map();
  for (const [directory, pkg] of catalogByPath) {
    const { manifest, manifestPath } = repositoryManifests.get(directory);
    if (manifest.name !== pkg.name) {
      throw new Error(`${directory}: catalog names ${pkg.name}, manifest names ${manifest.name ?? '<missing>'}`);
    }
    manifests.set(pkg.name, { manifest, manifestPath, directory, catalog: pkg });
  }
  return manifests;
}

function isCompatibleInternalSpecifier(specifier, source, target, repoRoot) {
  if (specifier === target.manifest.version) return true;
  if (typeof specifier !== 'string' || !specifier.startsWith('portal:')) return false;
  const portalPath = specifier.slice('portal:'.length);
  if (portalPath === '' || portalPath.startsWith('/') || portalPath.includes('::')) return false;
  const resolvedPortalPath = resolve(repoRoot, ...source.directory.split('/'), portalPath);
  const resolvedTargetPath = resolve(repoRoot, ...target.directory.split('/'));
  return resolvedPortalPath === resolvedTargetPath;
}

function validateDependencies(catalog, manifests, repoRoot) {
  const allowedDependencies = catalog.tierRules.allowedDependencies;
  for (const source of manifests.values()) {
    const sourceGroupId = source.catalog.releaseGroup;
    const allowedReleaseGroups = new Set(
      catalog.releaseGroups[sourceGroupId].allowedDependencyReleaseGroups,
    );
    for (const section of RUNTIME_DEPENDENCY_SECTIONS) {
      for (const [dependency, specifier] of Object.entries(source.manifest[section] ?? {})) {
        if (!dependency.startsWith('@jinn-network/') || dependency === source.catalog.name) continue;
        const target = manifests.get(dependency);
        if (!target) {
          throw new Error(`${sourceGroupId} package ${source.catalog.name} depends on missing catalog package ${dependency}`);
        }
        const targetGroupId = target.catalog.releaseGroup;
        if (!allowedReleaseGroups.has(targetGroupId)) {
          throw new Error(
            `${sourceGroupId} package ${source.catalog.name} cannot depend on ${dependency} in ${targetGroupId}`,
          );
        }
        const permittedTiers = allowedDependencies[String(source.catalog.tier)];
        if (!permittedTiers.includes(target.catalog.tier)) {
          throw new Error(
            `tier ${source.catalog.tier} package ${source.catalog.name} cannot depend on tier ${target.catalog.tier} package ${target.catalog.name}`,
          );
        }
        if (!isCompatibleInternalSpecifier(specifier, source, target, repoRoot)) {
          throw new Error(
            `${source.catalog.name} depends on incompatible ${dependency} specifier ${specifier}; expected ${target.manifest.version}`,
          );
        }
      }
    }
  }
}

export function validatePlatformCatalog(catalog, { repoRoot, schemaPath = PLATFORM_CATALOG_SCHEMA_PATH }) {
  const root = resolve(repoRoot);
  validateCatalogSchema(catalog, root, schemaPath);
  validateTopLevel(catalog);
  validateDefinitions(catalog, root);
  catalog.packages.forEach((pkg, index) => validatePackageShape(pkg, index, catalog, root));
  validateReleaseGroups(catalog);
  const manifests = validateManifestAgreement(catalog, root);
  validateDependencies(catalog, manifests, root);
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

export function loadPublishableCatalogPackages(repoRoot, {
  releaseGroup,
  lane = 'canary',
} = {}) {
  if (typeof releaseGroup !== 'string' || releaseGroup === '') {
    throw new Error('a release group is required for publication eligibility');
  }
  const catalog = loadPlatformCatalog(repoRoot);
  const definition = catalog.releaseGroups[releaseGroup];
  const allowedPolicies = lane === 'canary'
    ? CANARY_PUBLISH_POLICIES
    : lane === 'stable'
      ? STABLE_PUBLISH_POLICIES
      : null;
  if (!allowedPolicies) throw new Error(`publication lane must be canary or stable, got ${lane}`);
  const enabled = definition?.stackPublished === true && definition?.[lane] === true;
  const members = catalog.packages.filter((pkg) => pkg.releaseGroup === releaseGroup);
  if (!enabled || members.length === 0
    || members.some(({ publishPolicy }) => !allowedPolicies.has(publishPolicy))) {
    throw new Error(`release group ${releaseGroup} is not eligible for ${lane} publication`);
  }
  return loadCatalogPackages(repoRoot, { releaseGroup });
}
