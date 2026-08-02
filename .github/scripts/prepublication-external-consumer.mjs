#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { canonicalJsonBytes, catalogSha256 } from './build-prepublication-bundle.mjs';
import { loadCatalogPackages } from './platform-catalog.mjs';

const COMMIT_SHA = /^[0-9a-f]{40}$/u;
const SRI_SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const UNREACHABLE_SCOPED_REGISTRY = 'http://127.0.0.1:9/';

function defaultExec(command, args, cwd, options = {}) {
  const env = { ...process.env, ...(options.env ?? {}) };
  delete env.NODE_AUTH_TOKEN;
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env });
  return {
    status: result.error ? 1 : result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? result.error?.message ?? '',
  };
}

function requireSuccess(result, label) {
  if (result.status !== 0) {
    throw new Error(`${label} failed: ${(result.stderr || result.stdout || `status ${result.status}`).trim()}`);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${label} ${path}: ${error?.message ?? String(error)}`);
  }
}

function sameNames(left, right) {
  return left.length === right.length
    && JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function inside(child, parent) {
  const path = relative(parent, child);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`));
}

function walkSourceFiles(directory, prefix, found) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const absolute = join(directory, entry.name);
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walkSourceFiles(absolute, path, found);
    else if (entry.isFile()) found.add(path);
  }
}

function flattenedExportTargets(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(flattenedExportTargets);
}

export function sourceWildcardExportViolations(repoRoot) {
  const violations = [];
  for (const pkg of loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' })) {
    const files = new Set();
    walkSourceFiles(join(repoRoot, pkg.directory), '', files);
    for (const [key, value] of Object.entries(pkg.manifest.exports ?? {})) {
      if (!key.includes('*')) continue;
      const targets = flattenedExportTargets(value).map((target) => target.replace(/^\.\//u, ''));
      const matched = targets.some((target) => {
        const star = target.indexOf('*');
        if (star === -1) return false;
        const prefix = target.slice(0, star);
        const suffix = target.slice(star + 1);
        return [...files].some((file) => file.startsWith(prefix) && file.endsWith(suffix));
      });
      if (!matched) violations.push(`${pkg.name}: export ${key} has no source targets to pack`);
    }
  }
  return violations.sort();
}

function publicFileInventory(repoRoot, pkg) {
  const found = new Set();
  for (const kind of ['schemas', 'profiles', 'fixtures']) {
    for (const directory of pkg.catalog.publicSurface[kind]) {
      walkSourceFiles(join(repoRoot, pkg.directory, directory), directory, found);
    }
  }
  return [...found].sort();
}

function validateBundle(repoRoot, manifestPath) {
  const manifest = readJson(manifestPath, 'prepublication manifest');
  if (manifest.schemaVersion !== 1) throw new Error('prepublication manifest schemaVersion must be 1');
  if (!COMMIT_SHA.test(String(manifest.sourceSha))) {
    throw new Error('prepublication manifest sourceSha must be a 40-character lowercase commit SHA');
  }
  if (manifest.releaseGroup !== 'platform-v1') {
    throw new Error(`prepublication manifest releaseGroup must be platform-v1, got ${manifest.releaseGroup}`);
  }
  const actualCatalogDigest = catalogSha256(repoRoot);
  if (manifest.catalog?.sha256 !== actualCatalogDigest) {
    throw new Error(
      `prepublication catalog digest mismatch: manifest ${manifest.catalog?.sha256 ?? '<missing>'}, checked out ${actualCatalogDigest}`,
    );
  }

  const catalogPackages = loadCatalogPackages(repoRoot, { releaseGroup: 'platform-v1' });
  const catalogNames = catalogPackages.map(({ name }) => name);
  const order = manifest.packageOrder;
  const waveOrder = Array.isArray(manifest.waves) ? manifest.waves.flat() : [];
  const tarballNames = Array.isArray(manifest.tarballs)
    ? manifest.tarballs.map(({ name }) => name)
    : [];
  if (!Array.isArray(order)
    || new Set(order).size !== order.length
    || !sameNames(order, catalogNames)
    || JSON.stringify(order) !== JSON.stringify(waveOrder)
    || JSON.stringify(order) !== JSON.stringify(tarballNames)) {
    throw new Error('bundle package set does not match the platform-v1 catalog release group');
  }

  const bundleRoot = dirname(resolve(manifestPath));
  const tarballs = manifest.tarballs.map((tarball) => {
    if (typeof tarball.filename !== 'string' || !SRI_SHA512.test(String(tarball.integrity))) {
      throw new Error(`invalid tarball record for ${tarball.name ?? '<missing>'}`);
    }
    const path = resolve(bundleRoot, ...tarball.filename.split('/'));
    if (!inside(path, bundleRoot)) throw new Error(`tarball path escapes the bundle: ${tarball.filename}`);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`missing tarball for ${tarball.name}: ${tarball.filename}`);
    }
    const actual = `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`;
    if (actual !== tarball.integrity) {
      throw new Error(`tarball integrity mismatch for ${tarball.name}: manifest ${tarball.integrity}, actual ${actual}`);
    }
    return { ...tarball, path };
  });

  return { manifest, catalogPackages, tarballs };
}

async function consumerProbeMain() {
  const {
    existsSync: fileExists,
    readFileSync: readFile,
    readdirSync: readDirectory,
    statSync: fileStat,
  } = await import('node:fs');
  const { join: joinPath, relative: relativePath, resolve: resolvePath, sep: pathSeparator } = await import('node:path');
  const { fileURLToPath: urlToPath } = await import('node:url');

  const consumerRoot = process.cwd();
  const expectations = JSON.parse(readFile(joinPath(consumerRoot, 'consumer-expectations.json'), 'utf8'));

  function walk(directory, prefix = '') {
    const files = [];
    for (const entry of readDirectory(directory, { withFileTypes: true })) {
      const absolute = joinPath(directory, entry.name);
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) files.push(...walk(absolute, path));
      else if (entry.isFile()) files.push(path);
    }
    return files.sort();
  }

  function exportTargets(value) {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    return Object.values(value).flatMap(exportTargets);
  }

  function specifierForFile(name, exportsMap, file) {
    for (const [key, value] of Object.entries(exportsMap ?? {})) {
      for (const rawTarget of exportTargets(value)) {
        const target = rawTarget.replace(/^\.\//u, '');
        const star = target.indexOf('*');
        if (star === -1) {
          if (target === file && !key.includes('*')) return `${name}${key === '.' ? '' : key.slice(1)}`;
          continue;
        }
        if (!key.includes('*')) continue;
        const prefix = target.slice(0, star);
        const suffix = target.slice(star + 1);
        if (!file.startsWith(prefix) || !file.endsWith(suffix)) continue;
        const replacement = file.slice(prefix.length, file.length - suffix.length || undefined);
        return `${name}${key.slice(1).replace('*', replacement)}`;
      }
    }
    throw new Error(`${name}: installed public file ${file} is not reachable through package exports`);
  }

  function wildcardReplacement(target, file) {
    const star = target.indexOf('*');
    if (star === -1) return null;
    const prefix = target.slice(0, star);
    const suffix = target.slice(star + 1);
    if (!file.startsWith(prefix) || !file.endsWith(suffix)) return null;
    return file.slice(prefix.length, file.length - suffix.length || undefined);
  }

  function assertResolvedFile(specifier, expectedRoot, expectedRelative) {
    const resolvedUrl = import.meta.resolve(specifier);
    if (!resolvedUrl.startsWith('file:')) throw new Error(`${specifier} resolved outside the installed filesystem`);
    const resolved = urlToPath(resolvedUrl);
    if (!fileExists(resolved) || !fileStat(resolved).isFile()) {
      throw new Error(`${specifier} resolved to missing installed target ${resolved}`);
    }
    const within = relativePath(expectedRoot, resolved);
    if (within === '..' || within.startsWith(`..${pathSeparator}`)) {
      throw new Error(`${specifier} escaped installed package ${expectedRoot}`);
    }
    if (expectedRelative && resolvePath(expectedRoot, ...expectedRelative.split('/')) !== resolved) {
      throw new Error(`${specifier} resolved to ${within}, expected ${expectedRelative}`);
    }
  }

  const resolvedSpecifiers = new Set();
  for (const expected of expectations.packages) {
    const packageRoot = joinPath(consumerRoot, 'node_modules', ...expected.name.split('/'));
    const manifestPath = joinPath(packageRoot, 'package.json');
    if (!fileExists(manifestPath)) throw new Error(`${expected.name}: installed package is missing`);
    const manifest = JSON.parse(readFile(manifestPath, 'utf8'));
    if (manifest.name !== expected.name
      || manifest.version !== expectations.packageVersion
      || manifest.gitHead !== expectations.sourceSha) {
      throw new Error(`${expected.name}: installed identity/version/gitHead does not match the bundle`);
    }
    if (JSON.stringify(manifest.exports ?? {}) !== JSON.stringify(expected.exports ?? {})) {
      throw new Error(`${expected.name}: installed export map does not match the source manifest`);
    }

    const installedFiles = walk(packageRoot);
    for (const [key, value] of Object.entries(manifest.exports ?? {})) {
      const targets = exportTargets(value).map((target) => target.replace(/^\.\//u, ''));
      if (key.includes('*')) {
        const captures = new Set();
        for (const target of targets) {
          for (const file of installedFiles) {
            const replacement = wildcardReplacement(target, file);
            if (replacement !== null) captures.add(replacement);
          }
        }
        if (captures.size === 0) {
          throw new Error(`${expected.name}: export ${key} has no installed tarball targets`);
        }
        for (const capture of captures) {
          for (const target of targets) {
            const concreteTarget = target.split('*').join(capture);
            const targetPath = joinPath(packageRoot, ...concreteTarget.split('/'));
            if (!fileExists(targetPath) || !fileStat(targetPath).isFile()) {
              throw new Error(
                `${expected.name}: export ${key} capture ${capture} is missing target ${concreteTarget}`,
              );
            }
          }
          const specifier = `${expected.name}${key.slice(1).split('*').join(capture)}`;
          assertResolvedFile(specifier, packageRoot);
          resolvedSpecifiers.add(specifier);
        }
      } else {
        for (const target of targets) {
          if (target.includes('*')) continue;
          const targetPath = joinPath(packageRoot, ...target.split('/'));
          if (!fileExists(targetPath) || !fileStat(targetPath).isFile()) {
            throw new Error(`${expected.name}: export ${key} points at missing installed target ${target}`);
          }
        }
        const specifier = key === '.' ? expected.name : `${expected.name}${key.slice(1)}`;
        assertResolvedFile(specifier, packageRoot);
        resolvedSpecifiers.add(specifier);
      }
    }

    assertResolvedFile(expected.name, packageRoot);
    resolvedSpecifiers.add(expected.name);

    for (const subpath of expected.publicSurface.conformance) {
      const specifier = subpath === '.' ? expected.name : `${expected.name}${subpath.slice(1)}`;
      assertResolvedFile(specifier, packageRoot);
      resolvedSpecifiers.add(specifier);
    }

    const visited = new Set();
    for (const file of expected.publicFiles) {
      const absolute = joinPath(packageRoot, ...file.split('/'));
      if (!fileExists(absolute) || !fileStat(absolute).isFile()) {
        throw new Error(`${expected.name}: missing expected public file ${file}`);
      }
      const specifier = specifierForFile(expected.name, manifest.exports, file);
      assertResolvedFile(specifier, packageRoot, file);
      resolvedSpecifiers.add(specifier);
      visited.add(file);
    }
    for (const kind of ['schemas', 'profiles', 'fixtures']) {
      for (const directory of expected.publicSurface[kind]) {
        const absolute = joinPath(packageRoot, ...directory.split('/'));
        if (!fileExists(absolute) || !fileStat(absolute).isDirectory()) {
          throw new Error(`${expected.name}: missing installed publicSurface.${kind} directory ${directory}`);
        }
        const files = walk(absolute).map((file) => `${directory}/${file}`);
        if (files.length === 0) {
          throw new Error(`${expected.name}: publicSurface.${kind} directory ${directory} contains no files`);
        }
        for (const file of files) {
          if (visited.has(file)) continue;
          visited.add(file);
          const specifier = specifierForFile(expected.name, manifest.exports, file);
          assertResolvedFile(specifier, packageRoot, file);
          resolvedSpecifiers.add(specifier);
        }
      }
    }
  }
  console.log(`resolved ${resolvedSpecifiers.size} installed targets across ${expectations.packages.length} packages`);
}

function probeSource() {
  return `(${consumerProbeMain.toString()})().catch((error) => {\n  console.error(error?.message ?? String(error));\n  process.exitCode = 1;\n});\n`;
}

export function writeConsumerProbe({ consumerRoot, expectations }) {
  writeFileSync(
    join(consumerRoot, 'consumer-expectations.json'),
    `${JSON.stringify(expectations)}\n`,
    'utf8',
  );
  writeFileSync(join(consumerRoot, 'consumer-probe.mjs'), probeSource(), 'utf8');
}

export function runConsumerProbe({ consumerRoot, exec = defaultExec }) {
  return exec(process.execPath, ['consumer-probe.mjs'], consumerRoot);
}

export async function runTarballConsumer({
  repoRoot,
  manifestPath,
  keep = false,
  exec = defaultExec,
}) {
  const root = resolve(repoRoot);
  const validated = validateBundle(root, resolve(manifestPath));
  const consumerRoot = mkdtempSync(join(tmpdir(), 'jinn-platform-prepublication-consumer-'));
  try {
    const dependencies = Object.fromEntries(validated.tarballs.map(({ name, path }) => [name, `file:${path}`]));
    writeFileSync(join(consumerRoot, 'package.json'), canonicalJsonBytes({
      name: 'jinn-platform-prepublication-consumer',
      version: '0.0.0',
      private: true,
      type: 'module',
      dependencies,
    }), 'utf8');
    writeFileSync(join(consumerRoot, '.npmrc'), [
      `@jinn-network:registry=${UNREACHABLE_SCOPED_REGISTRY}`,
      'fetch-retries=0',
      'audit=false',
      'fund=false',
      '',
    ].join('\n'), 'utf8');
    writeConsumerProbe({
      consumerRoot,
      expectations: {
        sourceSha: validated.manifest.sourceSha,
        packageVersion: validated.manifest.packageVersion,
        packages: validated.catalogPackages.map((pkg) => ({
          name: pkg.name,
          exports: pkg.manifest.exports ?? {},
          publicFiles: publicFileInventory(root, pkg),
          publicSurface: pkg.catalog.publicSurface,
        })),
      },
    });

    const isolatedHome = join(consumerRoot, '.home');
    const isolatedCache = join(consumerRoot, '.npm-cache');
    mkdirSync(isolatedHome);
    mkdirSync(isolatedCache);

    requireSuccess(exec('npm', [
      'install',
      '--no-package-lock',
      '--registry',
      'https://registry.npmjs.org',
    ], consumerRoot, {
      env: {
        HOME: isolatedHome,
        npm_config_cache: isolatedCache,
      },
    }), 'clean tarball consumer install');
    requireSuccess(runConsumerProbe({ consumerRoot, exec }), 'installed public-target probe');
    return { packageCount: validated.catalogPackages.length };
  } finally {
    if (!keep) rmSync(consumerRoot, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const parsed = { repoRoot: process.cwd(), keep: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--keep') {
      parsed.keep = true;
      continue;
    }
    if (flag !== '--root' && flag !== '--manifest') throw new Error(`unknown argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--root') parsed.repoRoot = value;
    if (flag === '--manifest') parsed.manifestPath = value;
    index += 1;
  }
  if (!parsed.manifestPath) throw new Error('--manifest is required');
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await runTarballConsumer(parseArgs(process.argv.slice(2)));
    console.log(`external consumer accepted ${result.packageCount} prepublication tarballs`);
  } catch (error) {
    console.error(error?.message ?? String(error));
    process.exitCode = 1;
  }
}
