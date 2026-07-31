import { createRequire } from 'node:module';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

export const root = resolve(import.meta.dirname, '../..');
export const pluginRoot = join(root, 'plugin');
export const runtimeRoot = join(pluginRoot, 'runtime');

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/u;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/u;

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

/**
 * Resolve the pinned TypeScript package from plugin/runtime after `yarn install`.
 * Fails loud when the compiler is missing so guards never fall back to regex scans.
 */
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

function listSourceFiles(directory) {
  if (!existsSync(directory)) return [];
  if (lstatSync(directory).isFile()) {
    return isSourceFile(directory) ? [directory] : [];
  }
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules') return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listSourceFiles(path) : isSourceFile(entry.name) ? [path] : [];
  });
}

/**
 * One recursive, deterministic package discovery under plugin/.
 * Excludes node_modules. Returns sorted metadata used by all three guards.
 */
export function discoverPluginPackages() {
  const packages = [];

  function walk(directory, packagePath = '') {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const child = join(directory, entry.name);
      const childPath = packagePath ? `${packagePath}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) continue;
      const manifestPath = join(child, 'package.json');
      if (existsSync(manifestPath)) {
        const manifest = readJson(manifestPath);
        const srcDir = join(child, 'src');
        const sourceFiles = listSourceFiles(srcDir);
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
        });
        continue;
      }
      walk(child, childPath);
    }
  }

  walk(pluginRoot);
  packages.sort((left, right) => left.directory.localeCompare(right.directory));
  return packages;
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

export function exactVersionViolations(manifest, approvedMap, section) {
  return Object.entries(manifest[section] ?? {}).flatMap(([name, version]) => {
    const approved = approvedMap[name];
    if (approved === undefined) return [];
    if (typeof version !== 'string' || version.trim() === '') {
      return [`${section}:${name}=<malformed>`];
    }
    if (/^[~^><= ]/.test(version) || version.includes('||') || version.includes(' - ')) {
      return [`${section}:${name}=${version}`];
    }
    return version !== approved ? [`${section}:${name}=${version}`] : [];
  }).sort();
}

export function undeclaredInstallTimeDependencies(manifest, permittedPackages) {
  return INSTALL_TIME_SECTIONS.flatMap((section) =>
    Object.keys(manifest[section] ?? {})
      .filter((dependency) => !permittedPackages.includes(dependency))
      .map((dependency) => `${section}:${dependency}`),
  ).sort();
}

export function unconsumedApprovedEntries(manifest, approvedMap, section) {
  return Object.keys(approvedMap)
    .filter((name) => !(name in (manifest[section] ?? {})))
    .map((name) => `${section}:${name}`);
}
