import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const pluginRoot = join(root, 'plugin');
export const runtimeRoot = join(pluginRoot, 'runtime');

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;
const BUILD_ARTIFACTS = new Set(['node_modules', 'dist', 'coverage', '.git']);

/** Exact install-time external dependency versions approved for C3 runtime. */
export const APPROVED_RUNTIME_DEPENDENCIES = Object.freeze({
  '@jinn-network/evidence-catalog-sqlite': '0.1.0',
  '@jinn-network/evidence-discovery': '0.1.0',
  '@jinn-network/evidence-local-runtime': '0.1.0',
  '@jinn-network/evidence-protocol': '0.1.0',
  '@jinn-network/evidence-repository': '0.1.0',
  '@jinn-network/evidence-retrieval': '0.1.0',
  '@jinn-network/evidence-trajectory': '0.1.0',
  '@jinn-network/execution-recorder': '0.1.0',
  '@jinn-network/record-discovery-client': '0.1.0',
  '@jinn-network/record-discovery-protocol': '0.1.0',
  '@jinn-network/trust-core': '0.1.0',
  'better-sqlite3': '13.0.1',
  zod: '4.4.3',
});

/** Exact devDependency versions the guards version-control for plugin/runtime. */
export const APPROVED_RUNTIME_DEV_DEPENDENCIES = Object.freeze({
  '@types/better-sqlite3': '7.6.11',
  '@types/node': '22.20.1',
  typescript: '5.9.3',
  vitest: '4.1.10',
});

/** Exact resolutions the guards version-control for plugin/runtime. */
export const APPROVED_RUNTIME_RESOLUTIONS = Object.freeze({
  '@jinn-network/evidence-catalog-sqlite': 'portal:../../packages/evidence/catalog-sqlite',
  '@jinn-network/evidence-discovery': 'portal:../../packages/evidence/discovery',
  '@jinn-network/evidence-local-runtime': 'portal:../../packages/evidence/local-runtime',
  '@jinn-network/evidence-protocol': 'portal:../../packages/evidence/protocol',
  '@jinn-network/evidence-repository': 'portal:../../packages/evidence/repository',
  '@jinn-network/evidence-retrieval': 'portal:../../packages/evidence/retrieval',
  '@jinn-network/evidence-trajectory': 'portal:../../packages/evidence/trajectory',
  '@jinn-network/execution-recorder': 'portal:../../packages/evidence/execution-recorder',
  '@jinn-network/record-discovery-client': 'portal:../../packages/discovery/client',
  '@jinn-network/record-discovery-protocol': 'portal:../../packages/discovery/protocol',
  '@jinn-network/trust-core': 'portal:../../packages/trust/core',
  vite: '6.4.3',
});

/** Exact optionalDependency versions approved for C3 runtime (empty closed map). */
export const APPROVED_RUNTIME_OPTIONAL_DEPENDENCIES = Object.freeze({});

/** Exact peerDependency versions approved for C3 runtime (empty closed map). */
export const APPROVED_RUNTIME_PEER_DEPENDENCIES = Object.freeze({});

export const DEPENDENCY_SECTIONS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
]);

export const INSTALL_TIME_SECTIONS = Object.freeze([
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
]);

export const NON_NPM_DIRECTORIES = Object.freeze(['frozen', 'adapter-hermes']);

/** Ephemeral guard self-test dir prefix — must never exist under live plugin/ during discovery. */
export const GUARD_FIXTURE_DIR_PREFIX = '.plugin-tree-';

/** Deterministic code-unit string compare — never localeCompare/Intl. */
export function compareCodeUnit(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function loadRuntimeTypeScript() {
  const require = createRequire(join(runtimeRoot, 'package.json'));
  const typescriptPath = require.resolve('typescript');
  return require(typescriptPath);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function isSourceFile(path) {
  return SOURCE_FILE.test(path);
}

function isTestFile(path) {
  return TEST_FILE.test(path);
}

function listSourceFiles(directory, topologyErrors, relativeDir, underSrc = false) {
  if (!existsSync(directory)) return [];
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) {
    topologyErrors.push(`symlink in source tree: ${relativeDir}`);
    return [];
  }
  if (stat.isFile()) {
    return isSourceFile(directory) ? [directory] : [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (underSrc) {
      if (entry.name === 'node_modules') return [];
    } else if (BUILD_ARTIFACTS.has(entry.name)) {
      return [];
    }
    const path = join(directory, entry.name);
    const childRel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      topologyErrors.push(`symlink in source tree: ${childRel}`);
      return [];
    }
    return entry.isDirectory()
      ? listSourceFiles(path, topologyErrors, childRel, underSrc || entry.name === 'src')
      : isSourceFile(entry.name) ? [path] : [];
  });
}

function validatePackageTopology(packages) {
  const errors = [];
  const names = new Map();
  const directories = new Map();
  for (const pkg of packages) {
    if (typeof pkg.name !== 'string' || pkg.name.trim() === '') {
      errors.push(`malformed package name at ${pkg.directory}`);
    }
    if (names.has(pkg.name)) {
      errors.push(`duplicate package name ${pkg.name}: ${names.get(pkg.name)} and ${pkg.directory}`);
    } else {
      names.set(pkg.name, pkg.directory);
    }
    const dirKey = pkg.directory.toLowerCase();
    if (directories.has(dirKey) && directories.get(dirKey) !== pkg.directory) {
      errors.push(`case-colliding directories: ${directories.get(dirKey)} and ${pkg.directory}`);
    } else {
      directories.set(dirKey, pkg.directory);
    }
    if (!existsSync(pkg.srcDir)) {
      errors.push(`missing production src directory: ${pkg.directory}`);
    } else if (pkg.productionSourceFiles.length === 0) {
      errors.push(`zero production source files: ${pkg.directory}`);
    }
    errors.push(...pkg.topologyErrors);
  }
  return errors.sort(compareCodeUnit);
}

function assertLiveTreeHasNoGuardFixtureDirs(discoveryRoot) {
  if (discoveryRoot !== pluginRoot || !existsSync(pluginRoot)) return;
  for (const entry of readdirSync(pluginRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(GUARD_FIXTURE_DIR_PREFIX)) {
      throw new Error(
        `ephemeral guard fixture directory must not exist under live plugin tree: ${entry.name}`,
      );
    }
  }
}

/**
 * Recurse every directory under a plugin tree root, continue below discovered packages,
 * fail on symlinks and ambiguous topology.
 *
 * @param {{ root?: string }} [options]
 */
export function discoverPluginPackages({ root: discoveryRoot = pluginRoot } = {}) {
  assertLiveTreeHasNoGuardFixtureDirs(discoveryRoot);
  const packages = [];
  const topologyErrors = [];

  function walk(directory, packagePath = '') {
    if (!existsSync(directory)) return;
    const dirStat = lstatSync(directory);
    if (dirStat.isSymbolicLink()) {
      topologyErrors.push(`symlink in plugin tree: ${packagePath || '.'}`);
      return;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (BUILD_ARTIFACTS.has(entry.name)) continue;
      const child = join(directory, entry.name);
      const childPath = packagePath ? `${packagePath}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        topologyErrors.push(`symlink in plugin tree: ${childPath}`);
        continue;
      }
      if (!entry.isDirectory()) continue;
      const manifestPath = join(child, 'package.json');
      if (existsSync(manifestPath)) {
        const manifestStat = lstatSync(manifestPath);
        if (manifestStat.isSymbolicLink()) {
          topologyErrors.push(`symlink manifest: ${childPath}/package.json`);
          continue;
        }
        const manifest = readJson(manifestPath);
        const srcDir = join(child, 'src');
        const pkgTopologyErrors = [];
        const sourceFiles = listSourceFiles(srcDir, pkgTopologyErrors, `${childPath}/src`, true);
        const productionSourceFiles = sourceFiles.filter((file) => !isTestFile(file));
        packages.push({
          directory: childPath,
          absoluteDirectory: child,
          name: manifest.name,
          manifest,
          manifestPath,
          srcDir,
          sourceFiles,
          productionSourceFiles,
          topologyErrors: pkgTopologyErrors,
          codeEntrypoints: derivePublicCodeEntrypoints(manifest),
        });
        walk(child, childPath);
        continue;
      }
      walk(child, childPath);
    }
  }

  walk(discoveryRoot);
  packages.sort((left, right) => compareCodeUnit(left.directory, right.directory));
  const globalErrors = validatePackageTopology(packages);
  if (globalErrors.length > 0) {
    throw new Error(`plugin tree topology invalid:\n${globalErrors.join('\n')}`);
  }
  return packages;
}

/** Validate one exports subpath key. */
export function validateExportSubpath(subpath, packageName) {
  if (subpath !== '.' && !subpath.startsWith('./')) {
    throw new Error(`${packageName} exports subpath must be "." or "./…": ${subpath}`);
  }
  if (subpath.includes('..') || subpath.includes('\\') || subpath.includes('%')) {
    throw new Error(`${packageName} exports subpath escapes package root: ${subpath}`);
  }
  if (subpath.includes('*') || subpath.includes('?') || subpath.includes('#') || subpath.includes(':')) {
    throw new Error(`${packageName} exports wildcard/conditional pattern not supported: ${subpath}`);
  }
  if (/[\0-\x1f\x7f]/.test(subpath)) {
    throw new Error(`${packageName} exports subpath contains control characters: ${subpath}`);
  }
  if (subpath.startsWith('./')) {
    for (const segment of subpath.slice(2).split('/')) {
      if (segment === '' || segment === '.') {
        throw new Error(`${packageName} exports subpath contains malformed path segments: ${subpath}`);
      }
      if (segment === '..') {
        throw new Error(`${packageName} exports subpath escapes package root: ${subpath}`);
      }
    }
  }
}

export function undeclaredInstallTimeDependencies(manifest, permittedPackages) {
  return INSTALL_TIME_SECTIONS.flatMap((section) =>
    Object.keys(manifest[section] ?? {})
      .filter((dependency) => !permittedPackages.includes(dependency))
      .map((dependency) => `${section}:${dependency}`),
  ).sort(compareCodeUnit);
}

/** Production install-time dependencies must match the exact approved runtime map only. */
export function undeclaredProductionDependencies(manifest) {
  return ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap((section) =>
    Object.keys(manifest[section] ?? {})
      .filter((dependency) => !(dependency in APPROVED_RUNTIME_DEPENDENCIES))
      .map((dependency) => `${section}:${dependency}`),
  ).sort(compareCodeUnit);
}

function validateDistExportPath(relativePath, packageName, subpath, kind) {
  if (typeof relativePath !== 'string' || !relativePath.startsWith('./')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must be relative: ${relativePath}`);
  }
  if (relativePath.includes('\\')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must not contain backslashes`);
  }
  if (relativePath.includes('%')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must not contain percent encoding`);
  }
  if (relativePath.includes('?') || relativePath.includes('#')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must not contain query or fragment`);
  }
  if (/[\0-\x1f\x7f]/.test(relativePath)) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} contains control characters`);
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(relativePath) || relativePath.includes('://')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must not use a URL`);
  }
  if (!relativePath.startsWith('./dist/')) {
    throw new Error(`${packageName} exports ${kind} for ${subpath} must start with ./dist/`);
  }
  if (kind === 'types' && !relativePath.endsWith('.d.ts')) {
    throw new Error(`${packageName} exports types for ${subpath} must end with .d.ts`);
  }
  if (kind === 'import' && !relativePath.endsWith('.js')) {
    throw new Error(`${packageName} exports import for ${subpath} must end with .js`);
  }
  if (kind === 'types' && relativePath.endsWith('.d.ts.js')) {
    throw new Error(`${packageName} exports types for ${subpath} has a misleading extension`);
  }
  if (kind === 'import' && relativePath.endsWith('.js.d.ts')) {
    throw new Error(`${packageName} exports import for ${subpath} has a misleading extension`);
  }
  for (const segment of relativePath.slice(2).split('/')) {
    if (segment === '..') {
      throw new Error(`${packageName} exports ${kind} for ${subpath} escapes dist/`);
    }
    if (segment === '' || segment === '.') {
      throw new Error(`${packageName} exports ${kind} for ${subpath} contains malformed path segments`);
    }
  }
}

/** Validate one export target object — exact reviewed `types` then `import` shape only. */
export function validateExportTarget(target, packageName, subpath) {
  if (typeof target === 'string') {
    throw new Error(`${packageName} exports entry ${subpath} must be an object with types and import`);
  }
  if (typeof target !== 'object' || target === null || Array.isArray(target)) {
    throw new Error(`${packageName} exports entry ${subpath} is malformed`);
  }
  const keys = Object.keys(target);
  if (keys.length !== 2 || keys[0] !== 'types' || keys[1] !== 'import') {
    throw new Error(`${packageName} exports entry ${subpath} must list types before import`);
  }
  const allowed = ['import', 'types'];
  for (const key of keys) {
    if (!allowed.includes(key)) {
      throw new Error(`${packageName} exports entry ${subpath} has unsupported condition: ${key}`);
    }
  }
  if (typeof target.types !== 'string' || typeof target.import !== 'string') {
    throw new Error(`${packageName} exports entry ${subpath} requires string types and import`);
  }
  validateDistExportPath(target.import, packageName, subpath, 'import');
  validateDistExportPath(target.types, packageName, subpath, 'types');
  return { import: target.import, types: target.types };
}

/** Derive explicit public code entrypoints from package exports. Wildcards fail-closed. */
export function derivePublicCodeEntrypoints(manifest) {
  const name = manifest.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('manifest missing package name for export enumeration');
  }
  const exportsField = manifest.exports;
  if (exportsField === undefined) {
    const importTarget = manifest.main ?? './dist/index.js';
    const typesTarget = manifest.types ?? './dist/index.d.ts';
    validateDistExportPath(importTarget, name, '.', 'import');
    validateDistExportPath(typesTarget, name, '.', 'types');
    return [{ subpath: '.', specifier: name, conditions: { import: importTarget, types: typesTarget } }];
  }
  if (typeof exportsField === 'string') {
    throw new Error(`${name} exports entry . must be an object with types and import`);
  }
  if (typeof exportsField !== 'object' || exportsField === null || Array.isArray(exportsField)) {
    throw new Error(`${name} has malformed exports field`);
  }
  const entrypoints = [];
  for (const [subpath, target] of Object.entries(exportsField)) {
    validateExportSubpath(subpath, name);
    const conditions = validateExportTarget(target, name, subpath);
    entrypoints.push({
      subpath,
      specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`,
      conditions,
    });
  }
  if (entrypoints.length === 0) {
    throw new Error(`${name} exports no public code entrypoints`);
  }
  entrypoints.sort((left, right) => compareCodeUnit(left.subpath, right.subpath));
  return entrypoints;
}

export function readPackageManifest(directory) {
  const manifestPath = join(pluginRoot, directory, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`missing package manifest: ${manifestPath}`);
  }
  return readJson(manifestPath);
}

export function relativeFromRoot(absolutePath) {
  return relative(root, absolutePath);
}

function isExactVersion(version) {
  return typeof version === 'string'
    && version.trim() !== ''
    && !/^[~^><= ]/.test(version)
    && !version.includes('||')
    && !version.includes(' - ');
}

export function exactVersionViolations(manifest, approvedMap, section) {
  return Object.entries(manifest[section] ?? {}).flatMap(([name, version]) => {
    const approved = approvedMap[name];
    if (approved === undefined) return [];
    if (!isExactVersion(version)) {
      return [`${section}:${name}=${version}`];
    }
    return version !== approved ? [`${section}:${name}=${version}`] : [];
  }).sort(compareCodeUnit);
}

export function undeclaredDependencies(manifest, approvedMap, section) {
  return Object.keys(manifest[section] ?? {})
    .filter((name) => !(name in approvedMap))
    .map((name) => `${section}:${name}`)
    .sort(compareCodeUnit);
}

export function unconsumedApprovedEntries(manifest, approvedMap, section) {
  return Object.keys(approvedMap)
    .filter((name) => !(name in (manifest[section] ?? {})))
    .map((name) => `${section}:${name}`)
    .sort(compareCodeUnit);
}

export function resolutionViolations(manifest, approvedMap) {
  const resolutions = manifest.resolutions ?? {};
  const violations = [];
  for (const [name, version] of Object.entries(resolutions)) {
    const approved = approvedMap[name];
    if (approved === undefined) {
      violations.push(`resolutions:${name}=<undeclared>`);
      continue;
    }
    if (!isExactVersion(version)) {
      violations.push(`resolutions:${name}=${version}`);
      continue;
    }
    if (version !== approved) {
      violations.push(`resolutions:${name}=${version}`);
    }
  }
  return violations.concat(
    Object.keys(approvedMap)
      .filter((name) => !(name in resolutions))
      .map((name) => `resolutions:${name}=<missing>`),
  ).sort(compareCodeUnit);
}

export function allApprovedMapsForRuntime() {
  return {
    dependencies: APPROVED_RUNTIME_DEPENDENCIES,
    devDependencies: APPROVED_RUNTIME_DEV_DEPENDENCIES,
    optionalDependencies: APPROVED_RUNTIME_OPTIONAL_DEPENDENCIES,
    peerDependencies: APPROVED_RUNTIME_PEER_DEPENDENCIES,
    resolutions: APPROVED_RUNTIME_RESOLUTIONS,
  };
}

/** Bidirectional exact-version validation for every dependency section. */
export function validateExactDependencySections(manifest) {
  const maps = allApprovedMapsForRuntime();
  return DEPENDENCY_SECTIONS.flatMap((section) => [
    ...undeclaredDependencies(manifest, maps[section], section),
    ...unconsumedApprovedEntries(manifest, maps[section], section),
    ...exactVersionViolations(manifest, maps[section], section),
  ]).sort(compareCodeUnit);
}
