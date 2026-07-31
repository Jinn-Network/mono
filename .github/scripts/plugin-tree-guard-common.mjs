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
  zod: '4.4.3',
});

/** Exact devDependency versions the guards version-control for plugin/runtime. */
export const APPROVED_RUNTIME_DEV_DEPENDENCIES = Object.freeze({
  '@types/node': '22.20.1',
  typescript: '5.9.3',
  vitest: '4.1.10',
});

/** Exact resolutions the guards version-control for plugin/runtime. */
export const APPROVED_RUNTIME_RESOLUTIONS = Object.freeze({
  vite: '6.4.3',
});

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

function listSourceFiles(directory, topologyErrors, relativeDir) {
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
    if (BUILD_ARTIFACTS.has(entry.name)) return [];
    const path = join(directory, entry.name);
    const childRel = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      topologyErrors.push(`symlink in source tree: ${childRel}`);
      return [];
    }
    return entry.isDirectory()
      ? listSourceFiles(path, topologyErrors, childRel)
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

/**
 * Recurse every directory under plugin/, continue below discovered packages,
 * fail on symlinks and ambiguous topology.
 */
export function discoverPluginPackages() {
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
        const sourceFiles = listSourceFiles(srcDir, pkgTopologyErrors, `${childPath}/src`);
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

  walk(pluginRoot);
  packages.sort((left, right) => compareCodeUnit(left.directory, right.directory));
  const globalErrors = validatePackageTopology(packages);
  if (globalErrors.length > 0) {
    throw new Error(`plugin tree topology invalid:\n${globalErrors.join('\n')}`);
  }
  return packages;
}

/** Derive explicit public code entrypoints from package exports. Wildcards fail-closed. */
export function derivePublicCodeEntrypoints(manifest) {
  const name = manifest.name;
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('manifest missing package name for export enumeration');
  }
  const exportsField = manifest.exports;
  if (exportsField === undefined) {
    return [{ subpath: '.', specifier: name, conditions: manifest }];
  }
  if (typeof exportsField === 'string') {
    return [{ subpath: '.', specifier: name, conditions: { import: exportsField, types: exportsField } }];
  }
  if (typeof exportsField !== 'object' || exportsField === null) {
    throw new Error(`${name} has malformed exports field`);
  }
  const entrypoints = [];
  for (const [subpath, target] of Object.entries(exportsField)) {
    if (subpath.includes('*') || subpath.includes('?')) {
      throw new Error(`${name} exports wildcard/conditional pattern not supported: ${subpath}`);
    }
    if (typeof target === 'string') {
      entrypoints.push({ subpath, specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`, conditions: { import: target, types: target } });
      continue;
    }
    if (typeof target !== 'object' || target === null) {
      throw new Error(`${name} exports entry ${subpath} is malformed`);
    }
    const importTarget = target.import ?? target.default;
    const typesTarget = target.types;
    if (importTarget === undefined && typesTarget === undefined) {
      throw new Error(`${name} exports entry ${subpath} has no import/types code surface`);
    }
    entrypoints.push({
      subpath,
      specifier: subpath === '.' ? name : `${name}${subpath.slice(1)}`,
      conditions: target,
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

export function undeclaredInstallTimeDependencies(manifest, permittedPackages) {
  return INSTALL_TIME_SECTIONS.flatMap((section) =>
    Object.keys(manifest[section] ?? {})
      .filter((dependency) => !permittedPackages.includes(dependency))
      .map((dependency) => `${section}:${dependency}`),
  ).sort(compareCodeUnit);
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
    optionalDependencies: {},
    peerDependencies: {},
    resolutions: APPROVED_RUNTIME_RESOLUTIONS,
  };
}
